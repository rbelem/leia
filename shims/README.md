# leia local-model shims

Small FastAPI servers (ADR-0006, ticket 04) that let the leia extension's
**local voice-server profiles** drive open TTS models. Loopback-only, keyless.
One process serves one model; pick with `--model`:

| `--model`    | Port | Package (`pip`) | Model license | Disk (download) | Speed on CPU (honest)                                   |
| ------------ | ---- | --------------- | ------------- | --------------- | ------------------------------------------------------- |
| `piper`      | 8881 | `piper-tts`     | GPL-3.0       | ~65 MB/voice    | Fast — real-time or faster (medium voices)               |
| `kittentts`  | 8882 | `kittentts`     | Apache-2.0    | ~80 MB          | Roughly real-time (mini); nano is faster, lower quality  |
| `neutts`     | 8883 | `neutts-air`    | Apache-2.0    | ~0.5 GB         | **Slowest** — LLM backbone (GGUF Q4); often below real-time. Synthesize per sentence, not per paragraph. |
| `edge`       | 8884 | `edge-tts==7.2.8` | MIT         | none (network service) | Real-time-ish (streams)                          |

**Privacy:** piper/kittentts/neutts never leave your machine. **`edge` is the
exception** — it sends the text to Microsoft's Read-Aloud service and returns
synthesized audio (officially an undocumented browser feature, not an API).

**Tested here vs not:** the HTTP contract layer (all routes/shapes) is covered
by the pytest suite below and was curl-verified against a running stub server.
The container images and their real-model adapters were **not executed in
the authoring environment** — run each image once and
hit it with the curl block before relying on it.

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

First start downloads the mini model (~80 MB) into the volume. Smaller/faster:
`-e KITTEN_MODEL=KittenML/kitten-tts-nano-0.1`.

Install hint (extension): `podman run --rm -p 127.0.0.1:8882:8882 -v leia-shim-kittentts:/root/.cache leia-shim-kittentts`

### neutts — http://127.0.0.1:8883

```sh
podman build -t leia-shim-neutts -f Dockerfile.neutts .
podman run --rm -p 127.0.0.1:8883:8883 -v leia-shim-neutts:/root/.cache leia-shim-neutts
```

Image build compiles llama-cpp-python (~10–20 min). First start downloads the
Q4 GGUF backbone (~0.5 GB) plus the reference speaker sample. One built-in
voice (`dave`, from the upstream reference sample). Higher quality, slower:
`-e NEUTTS_BACKBONE=neutts-air-q8-gguf`.

Install hint (extension): `podman run --rm -p 127.0.0.1:8883:8883 -v leia-shim-neutts:/root/.cache leia-shim-neutts`

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
installed (`pip install piper-tts`, `kittentts`, or `neuttsair`):

```sh
python server.py --model piper --port 8881   # binds 127.0.0.1 by default
```

Model env vars (all optional): `PIPER_HOME`, `PIPER_VOICE`, `KITTEN_MODEL`,
`NEUTTS_BACKBONE`. The edge shim has none — it's a pinned network client
(`edge-tts==7.2.8`), not a model.

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
