"""
ASR 模型封装：基于 faster-whisper (CTranslate2)，CPU int8 推理。
支持中英文自动检测（auto 模式）。
优先从本地 models/ 目录加载模型，避免网络下载。
优先使用 small 模型（准确率更高）。
返回带时间戳的分段识别结果。
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional

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

# 所有可选本地模型目录（key 与 WHISPER_MODEL 取值对应）
_LOCAL_MODEL_DIRS = {
    "small": PROJECT_ROOT / "models" / "faster-whisper-small",
    "base": PROJECT_ROOT / "models" / "faster-whisper-base",
}

# WHISPER_MODEL 环境变量：既决定 HuggingFace 下载哪个模型，也决定本地目录的查找优先级。
# 默认 small（准确率更高）；设为 base 则优先加载本地 base，找不到再回退 small。
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")

_model = None
_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()


class ModelNotLoadedError(Exception):
    pass


def _model_search_order():
    """按 MODEL_SIZE 构造本地模型查找顺序：首选对应目录，其余目录依次回退。"""
    order = []
    primary = _LOCAL_MODEL_DIRS.get(MODEL_SIZE)
    if primary is not None:
        order.append(primary)
    for d in _LOCAL_MODEL_DIRS.values():
        if d not in order:
            order.append(d)
    return order


def _find_local_model() -> Optional[Path]:
    for d in _model_search_order():
        if (d / "model.bin").exists():
            return d
    return None


def _load_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel

            local = _find_local_model()
            if local:
                print(f"[ASR] 从本地加载模型: {local}")
                _model = WhisperModel(
                    str(local), device="cpu", compute_type="int8"
                )
            else:
                print(f"[ASR] 从 HuggingFace 下载模型: {MODEL_SIZE}")
                _model = WhisperModel(
                    MODEL_SIZE, device="cpu", compute_type="int8"
                )
        except Exception as e:
            _model = None
            raise ModelNotLoadedError(f"模型加载失败：{e}") from e
        return _model


def get_model():
    return _load_model()


def transcribe_with_timing(audio_path: str, language: Optional[str] = None) -> dict:
    """
    语音识别，返回带时间戳的分段结果。
    同一时间只处理一个请求，防止模型并发崩溃。
    """
    with _transcribe_lock:
        t0 = time.perf_counter()
        model = get_model()
        lang_param = None if language in (None, "auto") else language

        initial_prompt = None
        if lang_param == "en":
            initial_prompt = ("Hello, this is a clear English speech recording. "
                               "Please transcribe everything in English only.")
        elif lang_param == "zh":
            initial_prompt = ("你好，这是一段清晰的中文语音录音。"
                               "这是一个语音识别工具，用于将语音转成文字。"
                               "常用词：单次识别、会议模式、识别语言、录音、上传文件。")

        segments_iter, info = model.transcribe(
            audio_path,
            language=lang_param,
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
        )

        segments = []
        text_parts = []
        for seg in segments_iter:
            text = seg.text.strip()
            if text:
                segments.append({
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                })
                text_parts.append(text)

        text = " ".join(text_parts).strip()
        elapsed = time.perf_counter() - t0

        return {
            "text": text,
            "language": info.language if not lang_param else lang_param,
            "duration_seconds": round(float(info.duration), 2),
            "processing_seconds": round(elapsed, 2),
            "segments": segments,
        }
