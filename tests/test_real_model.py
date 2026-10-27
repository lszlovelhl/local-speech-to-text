"""
真实模型测试 —— 需要下载模型权重后才能运行。

默认 `pytest -q` 会跳过这些测试（通过 conftest 中的 marker 过滤）。
运行方式：
    pytest -m real_model -v

首次运行会自动下载 faster-whisper base 模型（约 150MB）。
"""
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = PROJECT_ROOT / "samples"


@pytest.mark.real_model
def test_real_chinese():
    """用真实模型识别中文样本。"""
    from app import asr
    wav_path = str(SAMPLES_DIR / "chinese.wav")
    result = asr.transcribe_with_timing(wav_path, "zh")
    assert result["text"], "中文识别结果不应为空"
    assert result["duration_seconds"] > 0
    print(f"\n[中文识别] 结果: {result['text']}")
    print(f"[中文识别] 时长: {result['duration_seconds']}s, 耗时: {result['processing_seconds']}s")


@pytest.mark.real_model
def test_real_english():
    """用真实模型识别英文样本。"""
    from app import asr
    wav_path = str(SAMPLES_DIR / "english.wav")
    result = asr.transcribe_with_timing(wav_path, "en")
    assert result["text"], "英文识别结果不应为空"
    assert result["duration_seconds"] > 0
    print(f"\n[英文识别] 结果: {result['text']}")
    print(f"[英文识别] 时长: {result['duration_seconds']}s, 耗时: {result['processing_seconds']}s")


@pytest.mark.real_model
def test_real_model_api_endpoint():
    """通过 HTTP 接口测试真实模型识别中文样本。"""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    wav_path = SAMPLES_DIR / "chinese.wav"
    with open(wav_path, "rb") as f:
        resp = client.post(
            "/api/transcribe",
            files={"file": ("chinese.wav", f.read(), "audio/wav")},
            data={"language": "zh"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["text"]
    assert data["language"] == "zh"
