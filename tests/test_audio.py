"""音频处理工具函数测试。"""
import pytest
from app.audio import validate_upload, AudioValidationError, MAX_FILE_SIZE


def test_validate_normal_wav():
    """正常 WAV 文件通过校验。"""
    validate_upload("test.wav", b"\x00" * 1000)  # 模拟内容


def test_validate_empty_file():
    """空文件应报错。"""
    with pytest.raises(AudioValidationError, match="空"):
        validate_upload("test.wav", b"")


def test_validate_too_large():
    """超过 10MB 应报错。"""
    big_content = b"\x00" * (MAX_FILE_SIZE + 1)
    with pytest.raises(AudioValidationError, match="超过"):
        validate_upload("big.wav", big_content)


def test_validate_unsupported_extension():
    """不支持的扩展名应报错。"""
    with pytest.raises(AudioValidationError, match="不支持"):
        validate_upload("test.txt", b"hello")


def test_validate_webm_allowed():
    """WebM 格式应通过。"""
    validate_upload("recording.webm", b"\x1aE\xdf\xa3" * 100)


def test_validate_case_insensitive():
    """扩展名大小写不敏感。"""
    validate_upload("TEST.WAV", b"\x00" * 100)
