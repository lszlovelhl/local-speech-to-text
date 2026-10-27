"""语音识别 API 测试（mock ASR）。"""


def test_transcribe_chinese(client, sample_wav_bytes):
    resp = client.post(
        "/api/transcribe",
        files={"file": ("chinese.wav", sample_wav_bytes, "audio/wav")},
        data={"language": "zh"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "text" in data
    assert data["language"] == "zh"
    assert "duration_seconds" in data
    assert "processing_seconds" in data


def test_transcribe_english(client, sample_wav_bytes):
    resp = client.post(
        "/api/transcribe",
        files={"file": ("english.wav", sample_wav_bytes, "audio/wav")},
        data={"language": "en"},
    )
    assert resp.status_code == 200
    assert resp.json()["language"] == "en"


def test_transcribe_auto_language(client, sample_wav_bytes):
    """auto 语言模式应被接受。"""
    resp = client.post(
        "/api/transcribe",
        files={"file": ("test.wav", sample_wav_bytes, "audio/wav")},
        data={"language": "auto"},
    )
    assert resp.status_code == 200


def test_transcribe_default_auto(client, sample_wav_bytes):
    """不传 language 参数时默认 auto。"""
    resp = client.post(
        "/api/transcribe",
        files={"file": ("test.wav", sample_wav_bytes, "audio/wav")},
    )
    assert resp.status_code == 200


def test_transcribe_invalid_language(client, sample_wav_bytes):
    resp = client.post(
        "/api/transcribe",
        files={"file": ("test.wav", sample_wav_bytes, "audio/wav")},
        data={"language": "fr"},
    )
    assert resp.status_code == 422


def test_transcribe_empty_file(client):
    resp = client.post(
        "/api/transcribe",
        files={"file": ("empty.wav", b"", "audio/wav")},
        data={"language": "zh"},
    )
    assert resp.status_code == 400


def test_transcribe_unsupported_format(client):
    resp = client.post(
        "/api/transcribe",
        files={"file": ("test.txt", b"hello", "text/plain")},
        data={"language": "zh"},
    )
    assert resp.status_code == 400


def test_transcribe_missing_file(client):
    resp = client.post("/api/transcribe", data={"language": "zh"})
    assert resp.status_code == 422
