// SPDX-License-Identifier: MPL-2.0
/**
 * KittenTTS nano synthesis worker (kitten-local family, ticket 06). Runs the
 * whole on-device pipeline off the audio-owner thread so the offscreen doc /
 * Firefox event page stays message-responsive during the 0.5–3 s of
 * inference per sentence (a busy owner thread would swallow cancel()):
 *
 *   asset load (IndexedDB cache → pinned URL → HF fallback)
 *     → phonemizer.js (espeak) → flat-vocab tokenizer → ONNX Runtime Web
 *     (WASM EP, single-threaded — extension pages are not cross-origin
 *     isolated) → Float32 mono PCM, transferred back to the engine.
 *
 * Requests are serialized (one inference at a time); stale replies are
 * discarded by the engine, not here.
 */
import * as ort from "onnxruntime-web/wasm";
import { phonemize } from "phonemizer";
import {
  KITTEN_ASSETS,
  readTokenizerVocab,
  resolveVoiceEmbedding,
  validateAsset,
  type KittenVoicesJson,
} from "./assets";
import { encodePhonemes, kittenInputIds } from "./phoneme-tokens";
import { idbDeleteAsset, idbGetRecords, idbPutAsset } from "./idb";
import type { KittenWorkerReply, KittenWorkerRequest } from "./protocol";

// ORT's wasm glue + binary are bundled next to this worker (build.mjs copies
// them into audio/kitten/ort/). Absolute URL: wasmPaths resolves relative to
// the document in window contexts, but workers get no useful document base.
ort.env.wasm.wasmPaths = new URL("ort/", self.location.href).href;
// Extension pages are not cross-origin isolated → no SharedArrayBuffer → 1 thread.
ort.env.wasm.numThreads = 1;

const ESPEAK_LANG = "en-us";

let session: ort.InferenceSession | null = null;
let vocab: Record<string, number> | null = null;
let voices: KittenVoicesJson | null = null;
let tail: Promise<void> = Promise.resolve();

/** Fetch one asset: cache first (validated), else pinned URL then fallbacks. */
async function loadAssetBytes(spec: typeof KITTEN_ASSETS.model): Promise<ArrayBuffer> {
  for (const bytes of await idbGetRecords(spec.url)) {
    const view = new Uint8Array(bytes);
    if (validateAsset(spec.kind, view)) return bytes;
  }
  // Corrupted/short cache: drop every record for this URL and refetch (once).
  await idbDeleteAsset(spec.url);
  for (const url of [spec.url, ...spec.fallbacks]) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const bytes = await resp.arrayBuffer();
      if (!validateAsset(spec.kind, new Uint8Array(bytes))) continue;
      await idbPutAsset(spec.url, bytes.byteLength, bytes); // key = url + byte length
      return bytes;
    } catch {
      // try the next URL
    }
  }
  throw new Error(`kitten asset unavailable: ${spec.url}`);
}

async function init(): Promise<readonly string[]> {
  if (session) return session.inputNames;
  const [modelBytes, voicesBytes, tokenizerBytes] = await Promise.all([
    loadAssetBytes(KITTEN_ASSETS.model),
    loadAssetBytes(KITTEN_ASSETS.voices),
    loadAssetBytes(KITTEN_ASSETS.tokenizer),
  ]);
  voices = JSON.parse(new TextDecoder().decode(voicesBytes)) as KittenVoicesJson;
  vocab = readTokenizerVocab(JSON.parse(new TextDecoder().decode(tokenizerBytes)));
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  return session.inputNames;
}

/** One inference: phonemes → tokens → ORT → Float32 samples. */
async function synthesize(req: { text: string; voice: string; speed: number }): Promise<Float32Array> {
  if (!session || !vocab || !voices) throw new Error("kitten worker not initialized");
  const embedding = resolveVoiceEmbedding(voices, req.voice);
  if (!embedding) throw new Error(`kitten voice not found in voices.json: ${req.voice}`);

  const phonemeLines = await phonemize(req.text, ESPEAK_LANG);
  const ids = kittenInputIds(encodePhonemes(vocab, phonemeLines.join(" ")));

  const speed = Math.min(2, Math.max(0.5, req.speed));
  // Feed by the graph's actual input names (Kokoro-style: input_ids /
  // styles|voice / speed) so a naming drift surfaces as a precise error.
  const feed: Record<string, ort.Tensor> = {};
  for (const name of session.inputNames) {
    if (/input|token/i.test(name)) {
      feed[name] = new ort.Tensor("int64", ids, [1, ids.length]);
    } else if (/style|voice|spk/i.test(name)) {
      feed[name] = new ort.Tensor("float32", embedding, [1, embedding.length]);
    } else if (/speed/i.test(name)) {
      feed[name] = new ort.Tensor("float32", Float32Array.of(speed), []);
    }
  }
  const outputs = await session.run(feed);
  const first = Object.values(outputs)[0];
  const data = first?.data as Float32Array | undefined;
  if (!(data instanceof Float32Array) || data.length === 0) {
    throw new Error("kitten model produced no audio");
  }
  return data;
}

function post(reply: KittenWorkerReply, transfer?: Transferable[]): void {
  self.postMessage(reply, { transfer: transfer ?? [] });
}

self.onmessage = (ev: MessageEvent<KittenWorkerRequest>): void => {
  const msg = ev.data;
  // Serialize every op; init runs before the first synth via the same chain.
  tail = tail.then(async () => {
    if (msg.type === "init") {
      try {
        post({ type: "ready", inputNames: await init() });
      } catch (err) {
        post({ type: "error", message: String(err) });
      }
      return;
    }
    if (msg.type === "synth") {
      try {
        const audio = await synthesize(msg);
        const copy = audio.slice().buffer; // own the buffer before transfer
        post({ type: "audio", reqId: msg.reqId, audio: copy }, [copy]);
      } catch (err) {
        post({ type: "error", reqId: msg.reqId, message: String(err) });
      }
    }
  });
};
