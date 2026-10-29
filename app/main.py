"""
Local Speech-to-Text Web Application — FastAPI 主入口。

启动：
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool

from app import asr
from app.audio import validate_upload, save_temp_audio, cleanup_temp, AudioValidationError
from app.config import VIDEO_EXTENSIONS, MAX_AUDIO_SIZE, MAX_VIDEO_SIZE

logger = logging.getLogger("app.main")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Local Speech-to-Text", version="3.0.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

ALLOWED_LANGUAGES = {"zh", "en", "auto"}

_READ_CHUNK = 1024 * 1024  # 1MB 分块读取，避免一次性把大文件读入内存


async def _read_bounded(file: UploadFile, max_size: int) -> bytes:
    """分块读取上传内容，累计长度一旦超过 max_size 立即中断并抛出 400。

    即使客户端缺失/伪造 Content-Length 头（file.size 为 None 或 0），
    也不会把超限文件整体灌入内存。
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            limit_mb = max_size // 1024 // 1024
            raise HTTPException(
                status_code=400, detail=f"文件大小超过限制（最大 {limit_mb}MB）"
            )
        chunks.append(chunk)
    return b"".join(chunks)


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request: Request, exc: RequestValidationError):
    """把 FastAPI 默认英文 422（如缺失 file 字段）翻译为友好中文，状态码仍为 422。

    注意：本 handler 只处理框架层的请求校验错误（RequestValidationError），
    不影响路由内部主动 raise 的 HTTPException（400/422/503 等保持原样）。
    """
    errors = exc.errors()
    missing_file = any(
        err.get("type") == "missing" and (err.get("loc") or [])[-1] == "file"
        for err in errors
    )
    detail = (
        "请先选择或录制要识别的音频/视频文件"
        if missing_file
        else "请求参数有误，请检查上传文件与语言选择"
    )
    return JSONResponse(status_code=422, content={"detail": detail})


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

    # 分块读取并实时拦截超限内容，避免 Content-Length 缺失时全量读入内存
    content = await _read_bounded(file, max_size)

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

    temp_path = None
    try:
        temp_path = save_temp_audio(content, ext)

        try:
            _probe_media(temp_path)
        except AudioValidationError as e:
            raise HTTPException(status_code=400, detail=e.message)

        # 在线程池中跑 ASR，不堵事件循环
        result = await run_in_threadpool(asr.transcribe_with_timing, temp_path, language)
        return JSONResponse(content=result)
    except HTTPException:
        # 业务校验类异常（4xx）原样向上抛，不被通用兜底吞掉
        raise
    except asr.ModelNotLoadedError as e:
        logger.warning("ASR 模型未就绪: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        # 记录真实堆栈便于排查，对外只返回友好提示，不外泄 traceback
        logger.exception("语音识别处理失败, filename=%s", filename)
        raise HTTPException(status_code=503, detail="语音识别失败，请检查文件格式")
    finally:
        # temp_path 可能在 save_temp_audio 阶段就未成功赋值，必须判空
        if temp_path:
            cleanup_temp(temp_path)
