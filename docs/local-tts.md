# Local AI voices — setup guide for Linux, macOS and Windows

Run an open-weight text-to-speech model on your own machine and let the
leia extension read any article with it. One command to start, no API
keys, no GPU, no Python knowledge. Everything on this page is
loopback-only: the audio is generated on your computer and never leaves
it — with one clearly-flagged exception (`edge`, step 2).

## What you need

- The leia extension installed in Firefox or Chrome (see the repo README).
- About 5 minutes, plus disk space for the model you pick (0.1–1 GB).
- A terminal. That's all.

## Step 1 — install uv (one time)

The shims run through [uv](https://docs.astral.sh/uv/), which fetches an
isolated Python plus the exact dependencies each model needs — nothing is
installed into your system.

**Linux / macOS** (any shell):

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows** (PowerShell):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**Any OS with pip**, if you prefer: `pip install uv`

Open a **new** terminal and check it worked:

```sh
uv --version
```

## Step 2 — start a voice server

Get the leia repository (you need its `shims/` folder), then from the
repo root:

```sh
shims/run.sh kokoro        # Linux / macOS
shims\run.ps1 kokoro       # Windows (PowerShell)
```

The first start downloads the model (~350 MB for kokoro) and then prints
something like `starting shim model=kokoro on 127.0.0.1:8880`. **Keep
this terminal open** while you read — closing it stops the voice.

Pick a model with the same command, different name:

| Model         | Command              | Port | Download | Speed on CPU (honest)                  | Voices                          | License    |
| ------------- | -------------------- | ---- | -------- | -------------------------------------- | ------------------------------- | ---------- |
| **kokoro** ⭐ | `run.sh kokoro`      | 8880 | ~350 MB  | ~2–3 s per sentence                    | 54 voices, 9 languages          | Apache-2.0 |
| piper         | `run.sh piper`       | 8881 | ~65 MB   | real-time or faster                    | 1 voice (more via `PIPER_VOICE`) | GPL-3.0    |
| kittentts     | `run.sh kittentts`   | 8882 | ~40 MB   | fast, quality is modest                | 8 voices                        | Apache-2.0 |
| neutts        | `run.sh neutts`      | 8883 | ~1 GB    | **slowest** — per-sentence synthesis   | 1 (voice-cloning reference)     | Apache-2.0 |
| edge          | `run.sh edge`        | 8884 | none     | real-time-ish                          | 20+ neural voices, 20 locales   | MIT        |
| stub          | `run.sh stub`        | 8881 | none     | instant                                | 2 beeps (pipeline testing only) | —          |

⭐ **Start with kokoro** — it is the best model that runs well without a
GPU (Elo ~1060 on the Artificial Analysis Speech Arena, #6 open-weight
overall), with natural voices in English (`af_heart`, `am_michael`),
Portuguese (`pf_dora`, `pm_alex`), Spanish, French, Italian, British
English (`bf_emma`), Japanese, Hindi and Chinese.

> **`edge` is not local.** It has no model — it relays your text to
> Microsoft's free Read-Aloud service and plays the result. Convenient,
> zero download, but the text leaves your machine. Every other model on
> this page is 100% offline after its one-time download.

> **neutts** downloads from Hugging Face gated repos: accept the licenses
> for `neuphonic/neutts-nano` and `neuphonic/neucodec` on
> huggingface.co, create a read token, and `export HF_TOKEN=hf_…` before
> starting it (Windows: `$env:HF_TOKEN = "hf_…"`).

## Step 3 — pick the voice in leia

1. Open leia (the popup or its options page) and find **Local servers**.
2. Your server shows up as **online**. leia checks for servers when the
   extension starts — if it was already running, restart the browser
   once and it will appear.
3. Pick a voice (kokoro: `af_heart` for English, `pf_dora` for
   português).
4. Open any article and press play. That's it.

## GPU models — the current state of the art (optional)

No GPU? Stop here — kokoro *is* the state of the art for CPU machines.

With an 8 GB+ NVIDIA GPU (Linux, or Windows via WSL2), the top-ranked
open-weight models run behind [vLLM-Omni](https://docs.vllm.ai/), which
serves a standard OpenAI-style API that leia speaks natively:

| Model                | Elo (Sep 2026) | License    | Serve command                                            | Port |
| -------------------- | -------------- | ---------- | -------------------------------------------------------- | ---- |
| VoxCPM2              | ~1100          | Apache-2.0 | `vllm serve openbmb/VoxCPM2 --omni --port 8885`          | 8885 |
| Qwen3 TTS (1.7B)     | ~1090          | Apache-2.0 | `vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --omni --port 8886` | 8886 |
| Step Audio EditX     | ~1102          | Apache-2.0 | `vllm serve stepfun-ai/Step-Audio-EditX --omni --port 8887` | 8887 |
| Voxtral TTS (4B)     | ~1082          | CC-BY-NC   | `vllm serve mistralai/Voxtral-4B-TTS-2603 --omni --port 8888` | 8888 |

Install vLLM-Omni once (`pip install vllm-omni` on Linux/WSL2 with
CUDA 12.x — see the vLLM docs), run the serve command, and the matching
built-in profile lights up in leia's picker automatically — no
configuration needed. For any *other* OpenAI-compatible TTS server
(LocalAI, Kokoro-FastAPI, llama.cpp-omni wrappers…), use leia's
**Options → Add server** with:

- **URL**: `http://127.0.0.1:<port>`
- **API**: OpenAI-compatible
- **Model id**: whatever `GET /v1/models` on that server reports

## Troubleshooting

- **The server doesn't appear in leia** — start the server *first*, then
  restart the browser. leia probes for servers once, at extension start.
- **First start seems stuck** — it's downloading the model; watch the
  terminal for progress. Subsequent starts are instant.
- **Port already in use** — something else owns 8880+. Stop the other
  process, or start the shim elsewhere (`shims/run.sh kokoro --port
  8890`) and add a matching custom server in leia's options.
- **Windows blocks `run.ps1`** — run it with
  `powershell -ExecutionPolicy Bypass -File shims\run.ps1 kokoro`.
- **Linux (NixOS especially)** — some prebuilt wheels need a system
  libstdc++/espeak-ng on the loader path; the exact exports are in
  [shims/README.md](../shims/README.md). Containers are unaffected.
- **Synthesis errors on one language only** — kokoro phonemizes through
  espeak-ng; a missing language there fails that voice while others
  work. Try a different voice pack.
- **No sound at all** — check the OS output device; leia plays through
  the browser's normal audio output.

## Privacy summary

| Path                          | Where your text goes            |
| ----------------------------- | ------------------------------- |
| kokoro / piper / kittentts / neutts / GPU models | Nowhere — synthesized locally |
| edge                          | Microsoft's Read-Aloud service  |
| Provider engines (OpenAI etc.)| That provider's cloud           |

## Prefer containers?

[podman](https://podman.io/)/Docker versions of every model, the full
wire contract, and the pytest suite that enforces it live in
[shims/README.md](../shims/README.md).
