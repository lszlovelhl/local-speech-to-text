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

from app import asr
from app.audio import validate_upload, save_temp_audio, cleanup_temp, AudioValidationError

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Local Speech-to-Text", version="2.1.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

ALLOWED_LANGUAGES = {"zh", "en", "auto"}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _probe_audio(path: str) -> None:
    """快速探测音频文件是否可解码，不可解码直接报错。"""
    try:
        import av
        with av.open(path, mode="r") as container:
            if not container.streams.audio:
                raise AudioValidationError("文件中未找到音频流，可能不是有效的音频文件")
    except AudioValidationError:
        raise
    except Exception as e:
        raise AudioValidationError(f"音频文件无法解码，格式可能损坏：{e}") from e


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

    content = await file.read()
    try:
        validate_upload(file.filename or "audio.wav", content)
    except AudioValidationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    ext = os.path.splitext(file.filename or "audio.wav")[1].lower()
    temp_path = save_temp_audio(content, ext)

    try:
        # 先探测文件是否可解码，假文件直接报错
        try:
            _probe_audio(temp_path)
        except AudioValidationError as e:
            raise HTTPException(status_code=400, detail=e.message)

        result = asr.transcribe_with_timing(temp_path, language)
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except asr.ModelNotLoadedError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"语音识别失败：{str(e)}")
    finally:
        cleanup_temp(temp_path)
