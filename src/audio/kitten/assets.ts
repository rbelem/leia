// SPDX-License-Identifier: MPL-2.0
/**
 * KittenTTS nano (kitten-local family, ticket 06) — static asset catalog and
 * the pure halves of the asset pipeline: cache keys, cache validation, voice
 * mapping, Float32→16-bit PCM conversion. No browser-API imports so the unit
 * tests run headlessly; the IndexedDB glue lives in idb.ts and the fetch /
 * cache orchestration in the worker (worker.ts).
 *
 * Assets are pinned to the clowerweb/kitten-tts-web-demo public folder with
 * the upstream HuggingFace repo (KittenML/kitten-tts-nano-0.1) as documented
 * fallback; first use downloads ~25 MB once and caches it in IndexedDB.
 */

export const KITTEN_MODEL_URL =
  "https://raw.githubusercontent.com/clowerweb/kitten-tts-web-demo/main/public/tts-model/model_quantized.onnx";
export const KITTEN_VOICES_URL =
  "https://raw.githubusercontent.com/clowerweb/kitten-tts-web-demo/main/public/tts-model/voices.json";
export const KITTEN_TOKENIZER_URL =
  "https://raw.githubusercontent.com/clowerweb/kitten-tts-web-demo/main/public/tts-model/tokenizer.json";

/**
 * Documented fallbacks (upstream model repo). Same filenames; tried in order
 * after the pinned demo URLs fail.
 */
export const KITTEN_HF_BASE = "https://huggingface.co/KittenML/kitten-tts-nano-0.1/resolve/main";

export type KittenAssetKind = "model" | "json";

export interface KittenAssetSpec {
  /** Primary pinned URL — also the IndexedDB cache key prefix. */
  url: string;
  /** Fallbacks tried in order when the primary fetch fails. */
  fallbacks: string[];
  kind: KittenAssetKind;
}

export const KITTEN_ASSETS: Record<"model" | "voices" | "tokenizer", KittenAssetSpec> = {
  model: { url: KITTEN_MODEL_URL, fallbacks: [`${KITTEN_HF_BASE}/model_quantized.onnx`], kind: "model" },
  voices: { url: KITTEN_VOICES_URL, fallbacks: [`${KITTEN_HF_BASE}/voices.json`], kind: "json" },
  tokenizer: { url: KITTEN_TOKENIZER_URL, fallbacks: [`${KITTEN_HF_BASE}/tokenizer.json`], kind: "json" },
};

export const KITTEN_SAMPLE_RATE = 24_000;
export const KITTEN_LANG = "en-US";
/** nano quality degrades on long input; session chunks are ≤250 anyway. */
export const KITTEN_MAX_UTTERANCE_CHARS = 1000;

/**
 * The 8 real voices.json keys (verified live against the demo asset), girls
 * first; `expr-voice-2-f` is the default. These are the exact dict keys —
 * getVoices()/picker names must match them or the worker's lookup fails.
 */
export const KITTEN_VOICE_NAMES = [
  "expr-voice-2-f",
  "expr-voice-3-f",
  "expr-voice-4-f",
  "expr-voice-5-f",
  "expr-voice-2-m",
  "expr-voice-3-m",
  "expr-voice-4-m",
  "expr-voice-5-m",
] as const;
export const KITTEN_DEFAULT_VOICE = KITTEN_VOICE_NAMES[0];

/** Corruption floor: the real int8 model is ~24 MB; anything smaller is a truncated/poisoned download. */
export const MODEL_MIN_BYTES = 10_000_000;

/**
 * IndexedDB record key: URL + byte length (ticket spec). The length also
 * becomes the cheap corruption signal — a cache record's key only matches a
 * payload whose length equals the fetched Content-Length-derived length.
 */
export function cacheKey(url: string, byteLength: number): string {
  return `${url}#${byteLength}`;
}

/** Range covering every `url#<len>` key for one asset URL. */
export function cacheRange(url: string): IDBKeyRange {
  return IDBKeyRange.bound(`${url}#`, `${url}#\uffff`);
}

/** Validate bytes before they are trusted (cache hit) or cached (fresh fetch). */
export function validateAsset(kind: KittenAssetKind, bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  if (kind === "model") return bytes.byteLength >= MODEL_MIN_BYTES;
  try {
    void JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * voices.json shape (verified live): { "expr-voice-2-f": [[…embedding…]], … }
 * — each key maps to a LIST with exactly ONE element, the flat style
 * embedding vector (same [numStyles][dim] shape family as Kokoro's VOICES
 * dict with numStyles = 1 here). The worker feeds the flattened vector as
 * the `styles` tensor [1, dim]; no L2 normalization / transposition — the
 * demo passes the stored vector straight through.
 */
export type KittenVoicesJson = Record<string, number[][] | number[]>;

/** Unwrap `[[embedding]]` → flat embedding (tolerates a bare flat array). */
function flattenEmbedding(value: number[][] | number[]): number[] {
  return Array.isArray(value[0]) ? (value[0] as number[]) : (value as number[]);
}

/**
 * Map a picker voice name onto its embedding. Shipped names are the exact
 * keys; the relaxed match is only a fallback for tolerant callers.
 */
export function resolveVoiceEmbedding(voices: KittenVoicesJson, name: string): Float32Array | null {
  const direct = voices[name];
  if (direct !== undefined) return Float32Array.from(flattenEmbedding(direct));
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]/g, "");
  const wanted = norm(name);
  for (const [key, value] of Object.entries(voices)) {
    if (norm(key) === wanted) return Float32Array.from(flattenEmbedding(value));
  }
  return null;
}

/** tokenizer.json shape (HuggingFace): model.vocab is the flat phoneme→id map. */
export function readTokenizerVocab(tokenizerJson: unknown): Record<string, number> {
  const model = (tokenizerJson as { model?: { vocab?: unknown } } | null)?.model;
  const vocab = (model as { vocab?: unknown } | null)?.vocab;
  if (vocab && typeof vocab === "object") return vocab as Record<string, number>;
  // Some tokenizer exports keep the vocab at the top level.
  const top = (tokenizerJson as { vocab?: unknown } | null)?.vocab;
  if (top && typeof top === "object") return top as Record<string, number>;
  throw new Error("tokenizer.json has no vocab");
}

/** Float32 [-1,1] → 16-bit signed LE PCM bytes (clamped). */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
