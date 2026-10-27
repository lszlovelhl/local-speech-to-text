"""
Local Speech-to-Text Web Application — FastAPI 主入口。

启动：
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool

from app import asr
from app.audio import validate_upload, save_temp_audio, cleanup_temp, AudioValidationError
from app.config import VIDEO_EXTENSIONS, MAX_AUDIO_SIZE, MAX_VIDEO_SIZE

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Local Speech-to-Text", version="3.0.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

ALLOWED_LANGUAGES = {"zh", "en", "auto"}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _probe_media(path: str) -> None:
    """探测文件是否可解码且包含音频流。"""
    try:
        import av
        with av.open(path, mode="r") as container:
            if not container.streams.audio:
                raise AudioValidationError("文件中未找到音频流，可能不是有效的音视频文件")
    except AudioValidationError:
        raise
    except Exception:
        raise AudioValidationError("文件无法解码，格式可能损坏")


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("auto"),
):
    if language not in ALLOWED_LANGUAGES:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的语言 '{language}'，仅支持 zh / en / auto",
        )

    # 先通过 Content-Length 头预判大小，避免大文件撑爆内存
    filename = file.filename or "audio.wav"
    ext = os.path.splitext(filename)[1].lower()
    max_size = MAX_VIDEO_SIZE if ext in VIDEO_EXTENSIONS else MAX_AUDIO_SIZE

    content_length = file.size or 0
    if content_length > max_size:
        limit_mb = max_size // 1024 // 1024
        raise HTTPException(status_code=400, detail=f"文件大小超过限制（最大 {limit_mb}MB）")

    content = await file.read()

    if len(content) == 0:
        raise HTTPException(status_code=400, detail="上传文件为空")

    # 实际大小校验（双重保险）
    if len(content) > max_size:
        limit_mb = max_size // 1024 // 1024
        raise HTTPException(status_code=400, detail=f"文件大小超过限制（最大 {limit_mb}MB）")

    if ext not in VIDEO_EXTENSIONS:
        try:
            validate_upload(filename, content)
        except AudioValidationError as e:
            raise HTTPException(status_code=e.status_code, detail=e.message)

    temp_path = save_temp_audio(content, ext)

    try:
        try:
            _probe_media(temp_path)
        except AudioValidationError as e:
            raise HTTPException(status_code=400, detail=e.message)

        # 在线程池中跑 ASR，不堵事件循环
        result = await run_in_threadpool(asr.transcribe_with_timing, temp_path, language)
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except asr.ModelNotLoadedError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        raise HTTPException(status_code=503, detail="语音识别失败，请检查文件格式")
    finally:
        cleanup_temp(temp_path)
