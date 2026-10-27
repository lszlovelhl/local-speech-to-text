"""
ASR 模型封装：基于 faster-whisper (CTranslate2)，CPU int8 推理。
支持中英文自动检测（auto 模式）。
优先从本地 models/ 目录加载模型，避免网络下载。
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional, Tuple

# 国内网络环境下的 HuggingFace 镜像（备用）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 兼容补丁：新版 faster-whisper 调用 av.open(metadata_errors=...)，
# 但部分 av 版本不支持该参数，这里自动剥离。
import av as _av
_orig_av_open = _av.open
def _patched_av_open(*args, **kwargs):
    kwargs.pop("metadata_errors", None)
    return _orig_av_open(*args, **kwargs)
_av.open = _patched_av_open

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_MODEL_DIR = PROJECT_ROOT / "models" / "faster-whisper-base"

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")

_model = None
_model_lock = threading.Lock()


class ModelNotLoadedError(Exception):
    pass


def _load_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel

        # 优先从本地目录加载模型（随项目附带，无需下载）
        if LOCAL_MODEL_DIR.exists() and (LOCAL_MODEL_DIR / "model.bin").exists():
            print(f"[ASR] 从本地加载模型: {LOCAL_MODEL_DIR}")
            _model = WhisperModel(
                str(LOCAL_MODEL_DIR), device="cpu", compute_type="int8"
            )
        else:
            # 本地没有则从 HuggingFace 下载（首次运行）
            print(f"[ASR] 从 HuggingFace 下载模型: {MODEL_SIZE}")
            _model = WhisperModel(
                MODEL_SIZE, device="cpu", compute_type="int8"
            )
        return _model


def get_model():
    return _load_model()


def transcribe(audio_path: str, language: Optional[str] = None) -> Tuple[str, float, str]:
    """
    语音识别。

    Args:
        audio_path: 音频路径
        language: "zh" / "en" / "auto" / None（自动检测）

    Returns:
        (识别文本, 音频时长, 实际检测到的语言)
    """
    model = get_model()
    # auto 或 None → 不传 language，让 Whisper 自动检测
    lang_param = None if language in (None, "auto") else language
    segments, info = model.transcribe(
        audio_path,
        language=lang_param,
        beam_size=5,
        vad_filter=True,
    )
    text_parts = [seg.text.strip() for seg in segments]
    text = " ".join(text_parts).strip()
    detected_lang = info.language if not lang_param else lang_param
    return text, float(info.duration), detected_lang


def transcribe_with_timing(audio_path: str, language: Optional[str] = None) -> dict:
    t0 = time.perf_counter()
    text, duration, detected = transcribe(audio_path, language)
    elapsed = time.perf_counter() - t0
    return {
        "text": text,
        "language": detected,
        "duration_seconds": round(duration, 2),
        "processing_seconds": round(elapsed, 2),
    }
