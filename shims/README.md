# leia local-model shims

Small FastAPI servers (ADR-0006, ticket 04) that let the leia extension's
**local voice-server profiles** drive open TTS models. Loopback-only, keyless.
One process serves one model; pick with `--model`:

| `--model`    | Port | Package (`pip`) | Model license | Disk (download) | Speed on CPU (honest)                                   |
| ------------ | ---- | --------------- | ------------- | --------------- | ------------------------------------------------------- |
| `piper`      | 8881 | `piper-tts`     | GPL-3.0       | ~65 MB/voice    | Fast — real-time or faster (medium voices)               |
| `kittentts`  | 8882 | `kittentts==0.1.3` | Apache-2.0  | ~40 MB (nano)   | Fast on CPU; nano quality is modest                       |
| `neutts`     | 8883 | `neutts==1.4.1` | Apache-2.0    | ~1 GB (nano backbone + codec) | **Slowest** — autoregressive backbone on CPU. Synthesize per sentence, not per paragraph. |
| `edge`       | 8884 | `edge-tts==7.2.8` | MIT         | none (network service) | Real-time-ish (streams)                          |

**Privacy:** piper/kittentts/neutts never leave your machine. **`edge` is the
exception** — it sends the text to Microsoft's Read-Aloud service and returns
synthesized audio (officially an undocumented browser feature, not an API).

**Tested here vs not** (updated 2026-09-01, after the podman smoke-test fixes —
host: NixOS, rootless podman 5.8.4):

- **Contract layer:** pytest suite green (13 tests); also verified live over
  HTTP via `--model stub` + curl.
- **piper** — verified live: bare-metal venv and container (README run line),
  real synth → 24 kHz WAV (resampled from the voice's native 22.05 kHz).
- **kittentts** — verified live: bare-metal venv and container, real nano
  synth → 24 kHz WAV. Bare-metal on NixOS needs espeak-ng paths (see note
  below); containers ship espeak-ng.
- **edge** — verified live: bare-metal venv and container, real Microsoft
  synth (pt-BR + en-US voices) → mp3 decoded in-process → 24 kHz WAV.
- **neutts** — **blocked upstream, not verified end-to-end**: every
  `neuphonic/*` weights repo is HF-gated (401 anonymous; no token on the test
  machine). Adapter API verified by introspection of `neutts==1.4.1`
  (constructor, `encode_reference`, `infer`) with a network-free unit test of
  the synth glue; container image builds. Needs `HF_TOKEN` + license
  acceptance to go live (see the gating note).
- **Not tested anywhere:** audio *quality* judgments (intelligibility, voice
  naturalness) and long-session behavior — listen once per model yourself.

## Contract

Exactly what `src/audio/engine-local.ts` and `src/audio/local-profiles.ts`
consume (the pytest suite enforces this — if it drifts, tests fail):

```
GET  /leia/v1/health        -> {"ok": true}
GET  /leia/v1/capabilities  -> {"wordTiming": false, "voices": [{"id": "…", "lang": "en", "name": "…"}, …]}
POST /leia/v1/synthesize    {"text": "hello", "voice": "<voice id>", "rate": 1.0, "format": "wav"}
                            -> {"audio_b64": "<base64 WAV — 24 kHz, mono, 16-bit PCM>"}
```

- `rate` is clamped to `[0.5, 2]` server-side (same clamp as the engine).
  piper honors it via `length_scale`; kitten passes it as `speed`;
  neutts ignores it (no speed knob).
- Unknown voice ids fall back to the adapter's default voice.
- `wordTiming` is always `false` — none of the three SDKs expose usable word
  timestamps; the engine skips word highlighting when it is false.

## Install & run (podman)

Build each image once from this directory (`shims/`), then run. The
`podman run` line for each model is the string the extension embeds verbatim
as the built-in profile install hint (ticket 05) — keep them copy-pasteable.

### piper — http://127.0.0.1:8881

```sh
podman build -t leia-shim-piper -f Dockerfile.piper .
podman run --rm -p 127.0.0.1:8881:8881 -v leia-shim-piper:/models leia-shim-piper
```

First start downloads `en_US-lessac-medium` (~65 MB) into the volume. Change
voices with `-e PIPER_VOICE=en_US-amy-medium` (any piper1-gpl medium voice name).

Install hint (extension): `podman run --rm -p 127.0.0.1:8881:8881 -v leia-shim-piper:/models leia-shim-piper`

### kittentts — http://127.0.0.1:8882

```sh
podman build -t leia-shim-kittentts -f Dockerfile.kittentts .
podman run --rm -p 127.0.0.1:8882:8882 -v leia-shim-kittentts:/root/.cache leia-shim-kittentts
```

First start downloads the nano model into the volume. **Nano is the shipped
default and the only supported option**: the PyPI lib (`kittentts==0.1.3`)
takes local onnx/voices paths and only understands nano's layout. Mini 0.8
needs the separate `kittentts-0.8.0` GitHub wheel plus `misaki>=0.9.4`
(git-only, python<3.14) — deliberately not shipped here. Voice ids:
`expr-voice-2-m` … `expr-voice-5-f`.

Install hint (extension): `podman run --rm -p 127.0.0.1:8882:8882 -v leia-shim-kittentts:/root/.cache leia-shim-kittentts`

### neutts — http://127.0.0.1:8883

```sh
export HF_TOKEN=hf_…   # see gating note below
podman build -t leia-shim-neutts -f Dockerfile.neutts .
podman run --rm -p 127.0.0.1:8883:8883 -e HF_TOKEN -v leia-shim-neutts:/root/.cache leia-shim-neutts
```

No compile step (the llama.cpp era is gone — `neutts` 1.4.1 runs a
transformers backbone). First start downloads the backbone + codec (~1 GB)
plus the reference speaker sample into the volume. One built-in voice (`dave`,
from the upstream reference sample). Different backbone via
`-e NEUTTS_BACKBONE_REPO=…` (GGUF backbones additionally need
llama-cpp-python, not shipped here).

**Gated weights:** every `neuphonic/*` model repo (`neutts-nano` default,
`neucodec` codec, `neutts-air`…) requires accepting the license on
huggingface.co and an authenticated download. Without a token the container
exits on first start with `OSError: You are trying to access a gated repo` in
its logs (model load happens before the port binds). Fix: accept
`neuphonic/neutts-nano` **and** `neuphonic/neucodec` on the HF website, create
a read token, then `export HF_TOKEN=hf_…` before `podman run` (the
`-e HF_TOKEN` flag passes it into the container).

Install hint (extension): `podman run --rm -p 127.0.0.1:8883:8883 -e HF_TOKEN -v leia-shim-neutts:/root/.cache leia-shim-neutts`

### edge — http://127.0.0.1:8884

```sh
podman build -t leia-shim-edge -f Dockerfile.edge .
podman run --rm -p 127.0.0.1:8884:8884 leia-shim-edge
```

Model-free (no download, no volume). ~20 curated neural voices across the top
locales (pt-BR included) — try voice `pt-BR-FranciscaNeural`.

Install hint (extension): `podman run --rm -p 127.0.0.1:8884:8884 leia-shim-edge`

**Fragility / breakage mode:** this wraps an *unofficial, undocumented*
Microsoft service. The trusted-token scheme (`Sec-MS-GEC`) has changed before
and will again. **Symptom: `health` returns `{"ok":true}` but `synthesize`
fails (500 / "returned no audio").** Fix: bump the pinned version in
`Dockerfile.edge` (`edge-tts==X.Y.Z`) and rebuild — the pin exists so a
breaking upstream change never surprises you silently.

**ToS / privacy:** Read-Aloud is a browser feature, not a public API; treat
this as a personal-use gray area, not something to rate-limit-hammer or
re-expose publicly. Unlike the other shims, **the text you read is sent to
Microsoft's servers.**

### Verify any of them

```sh
curl -s http://127.0.0.1:8881/leia/v1/health
# {"ok":true}
curl -s http://127.0.0.1:8881/leia/v1/capabilities
curl -s -X POST http://127.0.0.1:8881/leia/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello from piper","voice":"en_US-lessac-medium","rate":1,"format":"wav"}' \
  | python3 -c 'import json,sys,base64,io,wave; w=wave.open(io.BytesIO(base64.b64decode(json.load(sys.stdin)["audio_b64"])),"rb"); print(w.getframerate(), w.getnframes(), "frames")'
```

That last pipe prints `24000 <n> frames` — a playable 24 kHz WAV. For the
edge shim, same calls against `:8884` with `"voice":"pt-BR-FranciscaNeural"`.

The port mapping is `127.0.0.1:…` on the host side, so the server is
reachable **only from your machine** — same trust model the extension's probe
enforces (`validateBaseUrl` accepts only 127.0.0.1 / ::1 / localhost).

## Development & tests

No containers or models needed for the contract suite:

```sh
cd shims
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest tests -q        # contract suite — fails on any drift
python server.py --model stub    # full HTTP surface, zero model download
```

`--model stub` serves a deterministic beep model on 8881 — handy for curl
smoke tests of the contract layer without a multi-GB download.

Without containers, you can also run a real model bare-metal if its SDK is
installed (`pip install piper-tts`, `kittentts`, or `neutts`):

```sh
python server.py --model piper --port 8881   # binds 127.0.0.1 by default
```

Model env vars (all optional): `PIPER_HOME`, `PIPER_VOICE`, `KITTEN_MODEL`,
`NEUTTS_BACKBONE_REPO`, `NEUTTS_CODEC_REPO`, `HF_TOKEN` (neutts only — see
the gating note). The edge shim has none — it's a pinned network client
(`edge-tts==7.2.8`), not a model.

NixOS bare-metal note: manylinux wheels (numpy/torch) fail to load against
the default linker path; export `LD_LIBRARY_PATH` with a libstdc++/zlib from
nix, and espeak-ng paths for phonemizer (`PHONEMIZER_ESPEAK_LIBRARY`,
`PHONEMIZER_ESPEAK_PATH`) for kittentts/neutts. Containers are unaffected.

## License position

- The leia extension is MPL-2.0 and stays MPL-2.0. It never links any of
  these libraries — it speaks HTTP to a separate local process.
- This directory's source (`server.py`, `adapters.py`, tests, Dockerfiles) is
  MPL-2.0 like the rest of the repo (`SPDX-License-Identifier: MPL-2.0`).
- The **piper image** bundles GPL-3.0 `piper-tts`; distributing that image (or
  the bare-metal `pip install piper-tts` server process) subjects the whole
  served combination to GPL-3.0. That is why piper lives in this separate
  server process and is never imported by the extension.
- kittentts (Apache-2.0), neutts-air (Apache-2.0) and edge-tts (MIT) are
  permissive; their images carry no additional package obligations. The edge
  *service* itself is Microsoft's, used unofficially — see the edge section's
  ToS note.
