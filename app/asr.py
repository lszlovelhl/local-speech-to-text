"""
ASR 模型封装：基于 faster-whisper (CTranslate2)，CPU int8 推理。
支持中英文自动检测（auto 模式）。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional, Tuple

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
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
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
