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
import tempfile
import wave
from pathlib import Path

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


# --- kokoro adapter glue (network-free; the ~350 MB download happens in __init__) ---


class FakeKokoro:
    """Stands in for kokoro_onnx.Kokoro at the synthesize() boundary."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float, str]] = []

    def get_voices(self) -> list[str]:
        return ["zf_xiaobei", "af_heart", "am_michael"]  # unsorted on purpose

    def create(
        self, text: str, voice: str, speed: float, lang: str
    ) -> tuple["object", int]:
        self.calls.append((text, voice, speed, lang))
        import numpy as np

        return np.array([0.0, 0.5, -0.5], dtype=np.float32), SAMPLE_RATE


def test_kokoro_glue_sorts_voices_and_maps_langs() -> None:
    from adapters import KokoroModel

    model = KokoroModel.__new__(KokoroModel)  # skip __init__: no model download
    fake = FakeKokoro()
    model.tts = fake
    model.voice_ids = sorted(fake.get_voices())
    assert [(v.id, v.lang, v.name) for v in model.voices()] == [
        ("af_heart", "en-US", "af_heart"),
        ("am_michael", "en-US", "am_michael"),
        ("zf_xiaobei", "zh-CN", "zf_xiaobei"),
    ]


def test_kokoro_glue_wraps_create() -> None:
    from adapters import KokoroModel

    model = KokoroModel.__new__(KokoroModel)
    fake = FakeKokoro()
    model.tts = fake
    model.voice_ids = sorted(fake.get_voices())
    rate, pcm = model.synthesize("olá mundo", "zf_xiaobei", 1.5)
    assert rate == SAMPLE_RATE
    assert len(pcm) == 6  # 3 float32 samples -> 3 int16 frames * 2 bytes
    # speed carries the contract rate; create() gets the espeak-style
    # lowercase lang while voices() exposes BCP-47.
    assert fake.calls == [("olá mundo", "zf_xiaobei", 1.5, "zh-cn")]


def test_kokoro_unknown_voice_falls_back() -> None:
    from adapters import KokoroModel

    model = KokoroModel.__new__(KokoroModel)
    fake = FakeKokoro()
    model.tts = fake
    model.voice_ids = sorted(fake.get_voices())
    model.synthesize("x", "does-not-exist", 1.0)
    assert fake.calls[-1][1] == "af_heart"  # first sorted voice


# --- phonon adapter glue (network-free; the model download happens in __init__) ---


class FakePhonon:
    """Stands in for the `ptts` wheel's TTS object at the synthesize() boundary."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.conditions: dict[str, str] = {}

    def synth(self, text: str, voice: object = None) -> "object":
        self.calls.append((text, voice))
        import numpy as np

        return np.array([0.0, 0.5, -0.5], dtype=np.float32)

    def set_conditions(self, conditions: dict[str, str]) -> None:
        self.conditions.update(conditions)


def phonon_model(fake: FakePhonon):
    """A PhononModel with its __init__ skipped — no model download."""
    from adapters import PhononModel

    model = PhononModel.__new__(PhononModel)
    model.tts = fake
    model.lang = "en"
    model.sample_rate = SAMPLE_RATE
    model.voice_ids = ["default"]
    model.catalog = []
    model.studio_key = None
    model.studio = []
    model.voice_home = Path(tempfile.gettempdir()) / "leia-phonon-voices"
    model._studio_names = {}
    model._studio_registered = set()
    model._applied_delta = None
    model._rate_supported = True
    return model


def test_phonon_duration_delta_mapping() -> None:
    from adapters import phonon_duration_delta

    # The contract rate is a multiplier; duration_delta is a conditioner:
    # 0 is the model's own pace, negative is faster, positive is slower.
    assert phonon_duration_delta(1.0) == 0.0
    assert phonon_duration_delta(2.0) == pytest.approx(-0.3)
    assert phonon_duration_delta(0.5) == pytest.approx(0.3)
    assert phonon_duration_delta(1.5) == pytest.approx(-0.15)
    # Out-of-contract values clamp to the band instead of running away.
    assert phonon_duration_delta(9.0) == pytest.approx(-0.3)
    assert phonon_duration_delta(0.0) == pytest.approx(0.3)


def test_phonon_glue_wraps_synth() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    rate, pcm = model.synthesize("hello there", "default", 1.0)
    assert rate == SAMPLE_RATE
    assert len(pcm) == 6  # 3 float32 samples -> 3 int16 frames * 2 bytes
    assert fake.calls == [("hello there", "default")]
    # The rate rides the duration_delta conditioner.
    assert fake.conditions == {"duration_delta": "0.000"}


def test_phonon_unknown_voice_falls_back() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    model.synthesize("x", "does-not-exist", 1.0)
    assert fake.calls[-1][1] is None  # the checkpoint's own default voice


def test_phonon_rate_knob_moves_the_conditioner() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    model.synthesize("x", "default", 2.0)
    assert fake.conditions["duration_delta"] == "-0.300"
    # An unchanged rate is not re-applied (set_conditions clears the model's
    # primed state, so a per-request call would throw the priming away).
    model.synthesize("x", "default", 2.0)
    assert fake.conditions == {"duration_delta": "-0.300"}


def test_phonon_survives_a_checkpoint_without_duration_delta() -> None:
    class NoConditioner(FakePhonon):
        def set_conditions(self, conditions: dict[str, str]) -> None:
            raise RuntimeError(
                "no conditioner named 'duration_delta' in this checkpoint"
            )

    fake = NoConditioner()
    model = phonon_model(fake)
    rate, pcm = model.synthesize("x", "default", 2.0)
    assert rate == SAMPLE_RATE
    assert len(pcm) == 6  # the request still succeeds, at the model's own pace


def test_phonon_voices_merge_checkpoint_and_catalog() -> None:
    from adapters import Voice

    fake = FakePhonon()
    model = phonon_model(fake)
    model.voice_ids = ["default"]
    model.catalog = [Voice("Freya", "en", "Freya"), Voice("Alba", "en", "Alba")]
    assert [(v.id, v.lang, v.name) for v in model.voices()] == [
        ("default", "en", "default"),
        ("Freya", "en", "Freya"),
        ("Alba", "en", "Alba"),
    ]


def test_phonon_studio_voices_join_the_picker() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    model.studio_key = "gd1"
    model.studio = None
    model._gradium_api = lambda path: [
        {"uid": "clone01", "name": "My clone", "language": "en", "is_catalog": False},
        {"uid": "cat01", "name": "Flagship", "language": "en", "is_catalog": True},
    ]

    # The Studio voice is offered by its uid; the catalog voice is not
    # duplicated (the public catalog already carries those).
    assert [(v.id, v.lang, v.name) for v in model.voices()] == [
        ("default", "en", "default"),
        ("clone01", "en", "My clone"),
    ]


def test_phonon_studio_voice_is_synthesized_by_its_registered_name() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    model.studio_key = "gd1"
    model.studio = [Voice("clone01", "en", "My clone")]
    model._studio_names = {"clone01": "My clone"}
    model._register_studio_voice = lambda uid: "My clone"

    model.synthesize("hello", "clone01", 1.0)
    assert fake.calls[-1] == ("hello", "My clone")


def test_phonon_without_a_studio_key_lists_no_studio_voices() -> None:
    fake = FakePhonon()
    model = phonon_model(fake)
    model.studio = None

    def _boom(path: str) -> list[dict]:
        raise AssertionError("the Gradium API must not be called without a key")

    model._gradium_api = _boom
    assert model.voices() == [Voice("default", "en", "default")]


# --- neutts adapter glue (network-free; weights are HF-gated upstream) ---


class FakeNeuTTS:
    """Stands in for neutts.NeuTTS at the synthesize() boundary."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object, str]] = []

    def encode_reference(self, path: str) -> bytes:
        return b"ref-codes"

    def infer(self, text: str, ref_codes: object, ref_text: str) -> "object":
        self.calls.append((text, ref_codes, ref_text))
        import numpy as np

        return np.array([0.0, 0.5, -0.5], dtype=np.float32)


def test_neutts_glue_wraps_infer() -> None:
    from adapters import NeuTTSModel

    model = NeuTTSModel.__new__(NeuTTSModel)  # skip __init__: no model download
    fake = FakeNeuTTS()
    model.tts = fake
    model.ref = b"ref-codes"
    model.ref_text = "reference text"
    rate, pcm = model.synthesize("hello there", "dave", 1.0)
    assert rate == SAMPLE_RATE
    assert len(pcm) == 6  # 3 float32 samples -> 3 int16 frames * 2 bytes
    assert fake.calls == [("hello there", b"ref-codes", "reference text")]


def test_neutts_voices_static() -> None:
    from adapters import NeuTTSModel

    model = NeuTTSModel.__new__(NeuTTSModel)  # voices() needs no init-time state
    assert [(v.id, v.lang, v.name) for v in model.voices()] == [
        ("dave", "en", "Dave (reference sample)")
    ]
