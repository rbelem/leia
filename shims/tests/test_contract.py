# SPDX-License-Identifier: MPL-2.0
"""Contract tests for the shim HTTP surface — no model downloads needed.

Each test mirrors exactly what the extension does (the probe in
src/audio/local-profiles.ts, speak in src/audio/engine-local.ts), so a
failure here means the extension would break against this server.
Real-model audio quality/smoke is manual: run a container image per README
and hit it with the curl block there.
"""

import base64
import io
import wave

import pytest
from fastapi.testclient import TestClient

from adapters import CURATED_VOICES, EdgeModel, edge_rate_str
from server import SAMPLE_RATE, StubModel, Voice, create_app


class StubEdgeModel:
    """EdgeModel stand-in with the edge voice list but no network —
    proves the edge voices flow through the unchanged contract layer."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def voices(self) -> list[Voice]:
        return list(CURATED_VOICES)

    def synthesize(self, text: str, voice: str, rate: float) -> tuple[int, bytes]:
        self.calls.append((text, voice, rate))
        return SAMPLE_RATE, b"\x00\x00" * 480


@pytest.fixture()
def stub() -> StubModel:
    return StubModel()


@pytest.fixture()
def client(stub: StubModel) -> TestClient:
    return TestClient(create_app(stub))


def test_health_matches_probe(client: TestClient) -> None:
    # local-profiles.ts: HTTP 200 AND body.ok === true, else offline.
    resp = client.get("/leia/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_capabilities_shape(client: TestClient) -> None:
    # parseCaps: wordTiming bool, voices non-empty, id/lang/name strings.
    resp = client.get("/leia/v1/capabilities")
    assert resp.status_code == 200
    body = resp.json()
    assert body["wordTiming"] is False
    voices = body["voices"]
    assert len(voices) > 0
    for v in voices:
        assert isinstance(v["id"], str) and v["id"]
        assert isinstance(v["lang"], str) and v["lang"]
        assert isinstance(v["name"], str)


def test_synthesize_returns_24k_wav_envelope(client: TestClient) -> None:
    # engine-local.ts: POST JSON envelope, atob(audio_b64), played as audio/wav.
    resp = client.post(
        "/leia/v1/synthesize",
        json={"text": "hello world", "voice": "stub-en", "rate": 1.0, "format": "wav"},
    )
    assert resp.status_code == 200
    audio = base64.b64decode(resp.json()["audio_b64"])
    with wave.open(io.BytesIO(audio), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getnframes() > 0


def test_synthesize_clamps_rate(client: TestClient, stub: StubModel) -> None:
    # Server-side clamp mirrors engine clampRate ([0.5, 2]).
    for sent, expected in ((9.0, 2.0), (0.0, 0.5), (1.0, 1.0)):
        resp = client.post(
            "/leia/v1/synthesize",
            json={"text": "x", "voice": "stub-en", "rate": sent, "format": "wav"},
        )
        assert resp.status_code == 200
    assert [call[2] for call in stub.calls] == [2.0, 0.5, 1.0]


def test_synthesize_unknown_voice_falls_back(
    client: TestClient, stub: StubModel
) -> None:
    # Server passes the id through; adapters fall back to their default voice.
    resp = client.post(
        "/leia/v1/synthesize",
        json={"text": "x", "voice": "does-not-exist", "rate": 1.0, "format": "wav"},
    )
    assert resp.status_code == 200
    assert stub.calls[-1][1] == "does-not-exist"


def test_rejects_non_wav_format(client: TestClient) -> None:
    # The engine only ever sends format:"wav"; anything else is contract drift.
    resp = client.post(
        "/leia/v1/synthesize",
        json={"text": "x", "voice": "stub-en", "rate": 1.0, "format": "mp3"},
    )
    assert resp.status_code == 400


def test_rejects_empty_text(client: TestClient) -> None:
    resp = client.post(
        "/leia/v1/synthesize",
        json={"text": "", "voice": "stub-en", "rate": 1.0, "format": "wav"},
    )
    assert resp.status_code == 422


# --- edge adapter (network-free paths only) ---


def test_edge_rate_str() -> None:
    # contract rate clamp [0.5, 2] -> edge-tts percentage strings
    assert edge_rate_str(1.0) == "+0%"
    assert edge_rate_str(2.0) == "+100%"
    assert edge_rate_str(0.5) == "-50%"
    assert edge_rate_str(1.15) == "+15%"


def test_edge_curated_voices() -> None:
    model = EdgeModel()  # constructor is network-free
    voices = model.voices()
    assert len(voices) >= 20
    assert [v.id for v in voices] == [v.id for v in CURATED_VOICES]
    assert len({v.id for v in voices}) == len(voices)
    assert all(v.id.endswith("Neural") for v in voices)
    assert any(v.lang == "pt-BR" for v in voices)


def test_edge_voice_fallback() -> None:
    model = EdgeModel()
    assert model.resolve_voice("pt-BR-FranciscaNeural") == "pt-BR-FranciscaNeural"
    assert model.resolve_voice("bogus") == "pt-BR-FranciscaNeural"


def test_edge_contract_via_stub() -> None:
    stub = StubEdgeModel()
    client = TestClient(create_app(stub))
    caps = client.get("/leia/v1/capabilities").json()
    assert caps["wordTiming"] is False
    assert [v["id"] for v in caps["voices"]] == [v.id for v in CURATED_VOICES]
    resp = client.post(
        "/leia/v1/synthesize",
        json={
            "text": "olá",
            "voice": "pt-BR-AntonioNeural",
            "rate": 1.25,
            "format": "wav",
        },
    )
    assert resp.status_code == 200
    audio = base64.b64decode(resp.json()["audio_b64"])
    with wave.open(io.BytesIO(audio), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE
        assert w.getnframes() > 0
    assert stub.calls[-1][:2] == ("olá", "pt-BR-AntonioNeural")
