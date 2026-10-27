"""
集中配置：上传大小上限与文件扩展名白名单。
作为唯一真相源，app/main.py 与 app/audio.py 均从这里导入，
不再各自硬编码，避免两处不一致。
"""
from __future__ import annotations

# 上传大小上限（字节）
MAX_AUDIO_SIZE = 100 * 1024 * 1024  # 100MB
MAX_VIDEO_SIZE = 200 * 1024 * 1024  # 200MB

# 允许的视频扩展名（PyAV 自动提取音轨）
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}

# 允许的音频扩展名
ALLOWED_EXTENSIONS = {".wav", ".webm", ".ogg", ".mp3", ".m4a", ".flac"}
