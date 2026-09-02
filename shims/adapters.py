# SPDX-License-Identifier: MPL-2.0
"""
Real-model adapters for the leia shim server. Each class imports its SDK
lazily (inside __init__), so importing this module — and therefore the
whole contract layer — works on a bare venv without the multi-GB model
stacks. That is what keeps the pytest contract suite runnable anywhere.

NOTE: these adapters are written against the documented public APIs of
piper1-gpl, KittenTTS and neutts-air and were NOT executed in the
authoring environment (no containers, no model downloads). Run each
image once per README and check the curl block before trusting it.
"""

import io
import logging
import os
import subprocess
import sys
import wave
from pathlib import Path

from server import TTSModel, Voice

log = logging.getLogger("leia-shim")


def build_model(name: str) -> TTSModel:
    if name == "piper":
        return PiperModel()
    if name == "kittentts":
        return KittenTTSModel()
    if name == "neutts":
        return NeuTTSModel()
    if name == "edge":
        return EdgeModel()
    raise ValueError(f"unknown model {name!r}")


def float_to_pcm16(
    samples: "object",
) -> bytes:  # numpy array in, avoid importing numpy at module load
    import numpy as np

    x = np.clip(np.asarray(samples, dtype=np.float32).ravel(), -1.0, 1.0)
    return (x * 32767.0).astype("<i2").tobytes()


class PiperModel:
    """piper-tts (OHF-Voice/piper1-gpl). GPL-3.0 — runs in this server
    process only; the extension talks HTTP and never links it.

    Stock medium voices are 22.05 kHz; the contract layer resamples to
    24 kHz (see server.pcm_at_24k).
    """

    def __init__(self) -> None:
        from piper import PiperVoice

        self.home = Path(
            os.environ.get("PIPER_HOME", "~/.cache/leia/piper")
        ).expanduser()
        self.voice_name = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")
        onnx = self.home / f"{self.voice_name}.onnx"
        if not onnx.exists():
            self._download()
        log.info("loading piper voice %s", self.voice_name)
        self.voice = PiperVoice.load(onnx)

    def _download(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        log.info("downloading piper voice %s into %s", self.voice_name, self.home)
        # piper1-gpl's downloader saves <voice>.onnx(+.json) into its cwd.
        subprocess.run(
            [sys.executable, "-m", "piper.download_voices", self.voice_name],
            cwd=self.home,
            check=True,
        )

    def voices(self) -> list[Voice]:
        return [
            Voice(self.voice_name, self.voice_name.split("_", 1)[0], self.voice_name)
        ]

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        from piper import SynthesisConfig

        # piper's speed knob is length_scale (higher = slower) -> invert rate.
        config = SynthesisConfig(length_scale=1.0 / max(rate, 0.05))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            self.voice.synthesize_wav(text, wav_file, config)
        buf.seek(0)
        with wave.open(buf, "rb") as wav_file:
            return wav_file.getframerate(), wav_file.readframes(wav_file.getnframes())


class KittenTTSModel:
    """KittenTTS ONNX (Apache-2.0). Ships NANO by default — the pairing the
    PyPI lib actually supports (kittentts==0.1.3 takes LOCAL onnx/voices
    paths and only understands the nano style layout). Output is 24 kHz.

    Mini 0.8 is intentionally NOT shipped: its repo pairs a StyleTTS-2
    onnx (style [1,256], voices.npz (400,256)) that needs the separate
    kittentts-0.8.0 GitHub wheel plus misaki>=0.9.4 (git, python<3.14) —
    too fragile for a shim. Set KITTEN_MODEL=KittenML/kitten-tts-nano-0.1
    explicitly or point it at a local checkout dir for offline use.

    kittentts (0.1.3) takes LOCAL file paths only — a repo id goes
    straight into ort.InferenceSession and fails with NO_SUCHFILE — so
    the adapter resolves the repo to a local checkout (snapshot_download)
    before constructing."""

    FALLBACK_VOICES = (
        "expr-voice-2-m",
        "expr-voice-2-f",
        "expr-voice-3-m",
        "expr-voice-3-f",
        "expr-voice-4-m",
        "expr-voice-4-f",
        "expr-voice-5-m",
        "expr-voice-5-f",
    )

    def __init__(self) -> None:
        from huggingface_hub import snapshot_download
        from kittentts import KittenTTS

        model_ref = os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.1")
        checkout = Path(model_ref).expanduser()
        if not checkout.exists():
            log.info(
                "fetching KittenTTS model %s (first run downloads ~80 MB)", model_ref
            )
            checkout = Path(snapshot_download(model_ref))
        onnx = next(checkout.glob("*.onnx"))
        self.model = KittenTTS(str(onnx), str(checkout / "voices.npz"))
        # lib exposes its voices as .available_voices; keep the fallback for drift
        live = getattr(self.model, "available_voices", None) or getattr(
            self.model, "voices", None
        )
        self.voice_ids = list(live or self.FALLBACK_VOICES)

    def voices(self) -> list[Voice]:
        return [Voice(v, "en", v) for v in self.voice_ids]

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        used = voice if voice in self.voice_ids else self.voice_ids[0]
        audio = self.model.generate(text, voice=used, speed=rate)
        return 24000, float_to_pcm16(audio)


class NeuTTSModel:
    """NeuTTS via the `neutts` PyPI package (1.4.1): transformers backbone
    (default neuphonic/neutts-nano) + NeuCodec, zero-shot voice cloning
    with the upstream `dave` reference sample as the single built-in
    voice. Still the slowest shim — autoregressive backbone on CPU,
    feed it per-sentence. rate is ignored (no speed knob). Output is
    24 kHz natively.

    History: the package was `neuttsair`/neutts-air (llama.cpp GGUF,
    `NeuTTS(backbone=...)` + `.inference()`); 1.4.1 is import `neutts`,
    constructor takes repo ids and the method is `.infer()`. GGUF
    backbones need llama-cpp-python which the image does NOT ship — the
    default nano backbone runs on plain transformers. neucodec's
    unpinned torchao resolves to 0.18 whose layout breaks torchtune;
    Dockerfile.neutts pins torchao==0.17.0."""

    def __init__(self) -> None:
        from huggingface_hub import hf_hub_download
        from neutts import NeuTTS

        backbone_repo = os.environ.get("NEUTTS_BACKBONE_REPO", "neuphonic/neutts-nano")
        log.info(
            "loading NeuTTS backbone %s (first run downloads from HF)", backbone_repo
        )
        self.tts = NeuTTS(
            backbone_repo=backbone_repo,
            backbone_device="cpu",
            codec_repo=os.environ.get("NEUTTS_CODEC_REPO", "neuphonic/neucodec"),
            codec_device="cpu",
        )
        ref_wav = hf_hub_download("neuphonic/neutts-air", "samples/dave.wav")
        ref_txt = hf_hub_download("neuphonic/neutts-air", "samples/dave.txt")
        self.ref = self.tts.encode_reference(ref_wav)
        self.ref_text = Path(ref_txt).read_text(encoding="utf-8").strip()

    def voices(self) -> list[Voice]:
        return [Voice("dave", "en", "Dave (reference sample)")]

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        wav = self.tts.infer(text, self.ref, self.ref_text)
        return 24000, float_to_pcm16(wav)


# --- edge (Microsoft Read-Aloud via edge-tts) ---

# Curated subset (~400+ exist upstream): stable neural voices across the top
# locales, pt-BR included. Kept static on purpose — the picker must not churn
# when Microsoft adds/removes voices. ids are edge-tts "short names".
CURATED_VOICES: tuple[Voice, ...] = tuple(
    Voice(id, lang, name)
    for id, lang, name in (
        ("pt-BR-FranciscaNeural", "pt-BR", "Francisca (pt-BR)"),
        ("pt-BR-AntonioNeural", "pt-BR", "Antônio (pt-BR)"),
        ("pt-PT-FernandaNeural", "pt-PT", "Fernanda (pt-PT)"),
        ("en-US-AriaNeural", "en-US", "Aria (en-US)"),
        ("en-US-GuyNeural", "en-US", "Guy (en-US)"),
        ("en-US-JennyNeural", "en-US", "Jenny (en-US)"),
        ("en-GB-SoniaNeural", "en-GB", "Sonia (en-GB)"),
        ("en-GB-RyanNeural", "en-GB", "Ryan (en-GB)"),
        ("es-ES-ElviraNeural", "es-ES", "Elvira (es-ES)"),
        ("fr-FR-DeniseNeural", "fr-FR", "Denise (fr-FR)"),
        ("de-DE-KatjaNeural", "de-DE", "Katja (de-DE)"),
        ("it-IT-ElsaNeural", "it-IT", "Elsa (it-IT)"),
        ("ja-JP-NanamiNeural", "ja-JP", "Nanami (ja-JP)"),
        ("ko-KR-SunHiNeural", "ko-KR", "Sun-Hi (ko-KR)"),
        ("zh-CN-XiaoxiaoNeural", "zh-CN", "Xiaoxiao (zh-CN)"),
        ("ru-RU-SvetlanaNeural", "ru-RU", "Svetlana (ru-RU)"),
        ("hi-IN-SwaraNeural", "hi-IN", "Swara (hi-IN)"),
        ("ar-EG-SalmaNeural", "ar-EG", "Salma (ar-EG)"),
        ("id-ID-GadisNeural", "id-ID", "Gadis (id-ID)"),
        ("nl-NL-ColetteNeural", "nl-NL", "Colette (nl-NL)"),
    )
)

# edge-tts streams audio-24khz-48kbitrate-mono-mp3; decode in-process to the
# WAV contract. miniaudio is a self-contained wheel (bundled dr_mp3) that
# decodes AND resamples/downmixes to 24 kHz mono in one call — no ffmpeg.
EDGE_TTS_PIN = "edge-tts==7.2.8"
MINIAUDIO_PIN = "miniaudio==1.71"


def edge_rate_str(rate: float) -> str:
    """Contract rate (0.5–2) -> edge-tts percentage string: 1.0 -> '+0%'."""
    return f"{round((rate - 1.0) * 100):+d}%"


def mp3_to_pcm24(mp3: bytes) -> bytes:
    import array

    import miniaudio

    decoded = miniaudio.decode(
        mp3,
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=24000,
    )
    return array.array("h", decoded.samples).tobytes()


class EdgeModel:
    """Microsoft Edge Read-Aloud neural voices through edge-tts.

    NOT local: text is sent to Microsoft servers — the only shim whose
    audio leaves the machine (extension side must disclose provider
    privacy). Unofficial service: the Sec-MS-GEC token scheme has changed
    before; symptom is health ok + speak failing, fix is bumping the
    edge-tts pin (see README breakage note).

    Constructor and helpers are network-free; only synthesize() touches
    the network, which is what keeps the contract suite offline-safe.
    """

    def __init__(self, voices: tuple[Voice, ...] = CURATED_VOICES) -> None:
        self._voices = tuple(voices)

    def voices(self) -> list[Voice]:
        return list(self._voices)

    def resolve_voice(self, voice: str) -> str:
        return voice if voice in {v.id for v in self._voices} else self._voices[0].id

    async def _collect_mp3(self, text: str, voice_id: str, rate: str) -> bytes:
        import edge_tts

        chunks: list[bytes] = []
        comm = edge_tts.Communicate(text, voice_id, rate=rate)
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if not chunks:
            raise RuntimeError(
                "edge-tts returned no audio — service likely changed; bump the edge-tts pin (README breakage note)"
            )
        return b"".join(chunks)

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        # Sync handler runs in FastAPI's threadpool, so a fresh event loop is fine.
        import asyncio

        mp3 = asyncio.run(
            self._collect_mp3(text, self.resolve_voice(voice), edge_rate_str(rate))
        )
        return 24000, mp3_to_pcm24(mp3)
