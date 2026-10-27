"""
音频文件校验与处理工具。
"""
from __future__ import annotations

import os
import tempfile
from typing import Tuple

# 允许的文件扩展名
ALLOWED_EXTENSIONS = {".wav", ".webm", ".ogg", ".mp3", ".m4a", ".flac"}
# 上传大小上限 10MB
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


class AudioValidationError(Exception):
    """音频文件校验失败。"""
    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def validate_upload(filename: str, content: bytes) -> None:
    """
    校验上传的音频文件。

    Raises:
        AudioValidationError: 校验不通过
    """
    # 文件大小
    if len(content) == 0:
        raise AudioValidationError("上传文件为空")
    if len(content) > MAX_FILE_SIZE:
        raise AudioValidationError(
            f"文件大小超过限制（最大 {MAX_FILE_SIZE // 1024 // 1024}MB）"
        )

    # 扩展名
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise AudioValidationError(
            f"不支持的文件格式 '{ext}'，支持：{', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )


def save_temp_audio(content: bytes, suffix: str) -> str:
    """将上传内容保存为临时文件，返回路径。"""
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(content)
    return path


def cleanup_temp(path: str) -> None:
    """删除临时文件。"""
    try:
        os.unlink(path)
    except OSError:
        pass
