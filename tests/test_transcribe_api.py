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


def test_transcribe_missing_file_chinese_message(client):
    """缺 file 字段的 422 应返回中文友好提示，不外露英文 Field required。"""
    resp = client.post("/api/transcribe", data={"language": "zh"})
    assert resp.status_code == 422
    body = resp.json()
    assert isinstance(body["detail"], str)
    assert "文件" in body["detail"]
    assert "Field required" not in body["detail"]
    assert "msg" not in body  # 不再回传 FastAPI 默认英文错误数组结构


def test_transcribe_no_extension(client):
    """无扩展名文件应被明确拒绝（400，不允许穿透到 ASR）。"""
    resp = client.post(
        "/api/transcribe",
        files={"file": ("noextension", b"hello world", "application/octet-stream")},
        data={"language": "zh"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]


def test_transcribe_fake_wav_is_text(client):
    """纯文本伪装成 .wav：解不出音频流，应友好 400 而非 500 堆栈。"""
    resp = client.post(
        "/api/transcribe",
        files={"file": ("fake.wav", b"this is plain text not audio", "audio/wav")},
        data={"language": "zh"},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]
    assert "Internal Server Error" not in str(body)


def test_transcribe_fake_mp4_is_text(client):
    """纯文本伪装成 .mp4（视频分支跳过扩展名校验）仍须在解码探测处 400。"""
    resp = client.post(
        "/api/transcribe",
        files={"file": ("fake.mp4", b"this is plain text not video", "video/mp4")},
        data={"language": "zh"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]
