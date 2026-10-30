"""音频处理工具函数测试。"""
import pytest
from app.audio import validate_upload, AudioValidationError, MAX_FILE_SIZE
from app import harness


def test_validate_normal_wav():
    """正常 WAV 文件通过校验。"""
    validate_upload("test.wav", b"\x00" * 1000)  # 模拟内容


def test_validate_empty_file():
    """空文件应报错。"""
    with pytest.raises(AudioValidationError, match="空"):
        validate_upload("test.wav", b"")


def test_validate_too_large():
    """超过 100MB 应报错。"""
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


# ===== harness 后处理健壮性回归 =====

def test_fix_en_does_not_corrupt_letters_inside_words():
    """英文规则表不得做子串全局替换腐蚀词内小写 i（如 this/city）。"""
    out, _ = harness.post_process("this city is big", "en")
    lowered = out.lower()
    assert "this" in lowered  # 句首允许大写，但词形不得被破坏
    assert "city" in lowered
    # 词内 i 不得被错误大写（历史 bug：dict "i"->"I" 全局 replace）
    assert "thIs" not in out
    assert "cIty" not in out
    # 独立代词 i 仍应大写
    out2, _ = harness.post_process("i am happy", "en")
    assert "I" in out2


def test_post_process_empty_and_punctuation_safe():
    """空文本与纯标点输入不得报错、不得残留占位符。"""
    assert harness.post_process("", "auto") == ("", "auto")
    out, _ = harness.post_process("！！！，，。", "zh")
    assert "__EN_" not in out
    assert "__TERM_" not in out


def test_pycorrector_failure_falls_back_to_raw_text(monkeypatch):
    """纠错库深层抛异常（模拟缺 torch 崩溃）时回退原文，且不泄露占位符。"""

    class _BoomCorrector:
        def correct(self, text):
            raise RuntimeError("simulated torch missing crash deep inside corrector")

    monkeypatch.setattr(harness, "_pycorrector", _BoomCorrector())
    out = harness._fix_zh("你好，这是语音识别。")
    assert "__EN_" not in out
    assert "__TERM_" not in out
    # 回退为纠错前原文（规则表可能微调，这里只断言占位符已清除且无异常抛出）
    assert "你好" in out


# ===== 强制语言模式：剔除串语内容 =====

def test_forced_zh_strips_plain_english_keeps_terms():
    """强制中文：普通英文词剔除，技术缩写（CPU/API）保留。"""
    out, _ = harness.post_process("你好 hello world 测试 CPU API", "zh", forced=True)
    assert "hello" not in out.lower()
    assert "world" not in out.lower()
    assert "你好" in out
    assert "CPU" in out
    assert "API" in out


def test_forced_en_strips_chinese():
    """强制英文：中文字符全部剔除。"""
    out, _ = harness.post_process("Hello world 你好 this test", "en", forced=True)
    assert "你好" not in out
    assert "Hello" in out


def test_auto_mode_keeps_mixed_language():
    """auto 模式不做硬过滤，中英混说保留。"""
    out, _ = harness.post_process("你好 hello world 混合", "auto", forced=False)
    assert "你好" in out
    assert "hello" in out.lower()


def test_forced_zh_pure_english_becomes_empty():
    """强制中文下整段英文发音应清洗为空，由前端提示无有效中文结果。"""
    out, _ = harness.post_process("hello world programming only", "zh", forced=True)
    assert out.strip() == ""


def test_forced_zh_cleans_homophone_terms_and_keeps_tech_tokens():
    """强制中文：同音错字按术语表纠正，技术缩写保留，普通英文剔除。"""
    out, _ = harness.post_process("这个捷构和接扣 Redis hello", "zh", forced=True)
    assert "架构" in out
    assert "接口" in out
    assert "Redis" in out
    assert "hello" not in out.lower()


def test_forced_en_keeps_canonical_proper_nouns():
    """强制英文：中文剔除，FastAPI/Python 等技术名保持规范大小写。"""
    out, _ = harness.post_process("你好 this project uses fastapi and python", "en", forced=True)
    assert "你好" not in out
    assert "FastAPI" in out
    assert "Python" in out

