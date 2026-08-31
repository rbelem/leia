# SPDX-License-Identifier: MPL-2.0
"""
leia local-model shim server (ADR-0006, ticket 04): one FastAPI app that
exposes the extension's local voice-server contract in front of exactly
one TTS model at a time (--model piper|kittentts|neutts). Loopback-only,
keyless — the same trust model as src/audio/local-profiles.ts.

Contract (consumed by src/audio/engine-local.ts + local-profiles.ts):

  GET  /leia/v1/health        -> {"ok": true}                        (probe needs body.ok === true)
  GET  /leia/v1/capabilities  -> {"wordTiming": bool,
                                  "voices": [{"id","lang","name"}]}  (non-empty)
  POST /leia/v1/synthesize    body {"text": str, "voice": str,
                                    "rate": float, "format": "wav"}
                              -> {"audio_b64": "<base64 WAV, 24 kHz mono int16>"}

The extension always sends format:"wav" and rate clamped to [0.5, 2];
the server re-clamps anyway and rejects any other format. wordTiming is
always false — none of the three models expose usable word timestamps
through these SDKs, and the engine skips word events when it is false.
"""

import argparse
import base64
import io
import logging
import wave
from dataclasses import dataclass
from typing import Protocol

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

log = logging.getLogger("leia-shim")

SAMPLE_RATE = 24000  # contract: synthesize always returns 24 kHz mono 16-bit WAV

DEFAULT_PORTS = {
    "piper": 8881,
    "kittentts": 8882,
    "neutts": 8883,
    "edge": 8884,
    "stub": 8881,
}


@dataclass(frozen=True)
class Voice:
    id: str
    lang: str
    name: str


class TTSModel(Protocol):
    """One loaded TTS model.

    synthesize() returns (native_rate, mono 16-bit LE PCM bytes); the
    contract layer resamples to 24 kHz if the model's native rate differs.
    Unknown voice ids fall back to the adapter's default voice.
    """

    def voices(self) -> list[Voice]: ...

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]: ...


class StubModel:
    """Deterministic offline model for contract tests and HTTP smoke runs —
    no model download. `python server.py --model stub`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def voices(self) -> list[Voice]:
        return [
            Voice("stub-en", "en", "Stub English"),
            Voice("stub-de", "de", "Stub German"),
        ]

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        self.calls.append((text, voice, rate))
        frames = max(1, int(0.05 * rate * SAMPLE_RATE))
        return SAMPLE_RATE, b"\x00\x00" * frames


def clamp_rate(rate: float) -> float:
    # Same clamp the engine applies client-side (engine-local.ts clampRate).
    return min(2.0, max(0.5, rate))


def pcm_at_24k(pcm: bytes, rate: int) -> bytes:
    """Resample mono int16 PCM to the 24 kHz contract rate (linear).

    Only piper's stock medium voices are 22.05 kHz; kitten/neutts are
    24 kHz natively. numpy ships with every real model stack, hence the
    lazy import — the stub/test path never needs it.
    """
    if rate == SAMPLE_RATE:
        return pcm
    import numpy as np

    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if x.size == 0:
        return b""
    n_out = max(1, round(x.size * SAMPLE_RATE / rate))
    out = np.interp(np.linspace(0.0, x.size - 1.0, n_out), np.arange(x.size), x)
    return out.astype(np.int16).tobytes()


def wav_bytes(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = "default"
    rate: float = 1.0
    format: str = "wav"


class VoiceOut(BaseModel):
    id: str
    lang: str
    name: str


def create_app(model: TTSModel) -> FastAPI:
    app = FastAPI(
        title="leia local-model shim", docs_url=None, redoc_url=None, openapi_url=None
    )
    # Extension origins (moz-extension://, chrome-extension://) cannot be
    # enumerated; the server is loopback-only, so permissive CORS is safe.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/leia/v1/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/leia/v1/capabilities")
    def capabilities() -> dict[str, object]:
        return {
            "wordTiming": False,
            "voices": [
                VoiceOut(id=v.id, lang=v.lang, name=v.name) for v in model.voices()
            ],
        }

    @app.post("/leia/v1/synthesize")
    def synthesize(req: SpeakRequest) -> dict[str, str]:
        if req.format != "wav":
            raise HTTPException(
                status_code=400,
                detail=f"unsupported format {req.format!r}; contract is wav",
            )
        native_rate, pcm = model.synthesize(req.text, req.voice, clamp_rate(req.rate))
        audio = wav_bytes(pcm_at_24k(pcm, native_rate))
        return {"audio_b64": base64.b64encode(audio).decode("ascii")}

    return app


def build_model(name: str) -> TTSModel:
    if name == "stub":
        return StubModel()
    from adapters import build_model as build_real  # lazy: SDKs load at adapter init

    return build_real(name)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(
        description="leia local-model TTS shim (loopback-only)"
    )
    parser.add_argument("--model", required=True, choices=sorted(DEFAULT_PORTS))
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="bind address (docker images pass 0.0.0.0; keep 127.0.0.1 otherwise)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="default depends on --model: %(default)s -> " + repr(DEFAULT_PORTS),
    )
    args = parser.parse_args()
    port = args.port if args.port is not None else DEFAULT_PORTS[args.model]
    log.info("starting shim model=%s on %s:%d", args.model, args.host, port)
    uvicorn.run(
        create_app(build_model(args.model)), host=args.host, port=port, log_level="info"
    )


if __name__ == "__main__":
    main()
