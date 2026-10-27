"""
pytest 共享 fixtures。
默认 mock 掉 ASR 模型，避免 pytest 触发模型下载。
"""
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
os.environ["WHISPER_MODEL"] = "base"


@pytest.fixture
def mock_asr(monkeypatch):
    from app import asr

    def fake_transcribe(audio_path, language=None):
        lang_out = language if language in ("zh", "en") else "zh"
        return {
            "text": "你好，这是一段测试语音。" if lang_out == "zh" else "Hello, this is a test.",
            "language": lang_out,
            "duration_seconds": 3.5,
            "processing_seconds": 0.2,
        }

    monkeypatch.setattr(asr, "transcribe_with_timing", fake_transcribe)


@pytest.fixture
def client(mock_asr):
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


@pytest.fixture
def sample_wav_bytes():
    import wave, io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * 8000)
    return buf.getvalue()
