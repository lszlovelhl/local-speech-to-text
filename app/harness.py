"""
ASR 后处理 harness 层 — 规则修正，不改模型。
- 常见同音词纠错
- 领域术语修正
- 英文大小写/标点规范化
- 文本清洗（去重、空格修复）
"""
from __future__ import annotations
import re

# ===== 中文常见错误纠正表（同音/近音）=====
ZH_CORRECTIONS = {
    "单词识别": "单次识别",
    "单词模式": "单次模式",
    "紧致": "仅只",
    "紧质": "仅只",
    "会议模式": "会议模式",  # already correct, keep
    "语音识别": "语音识别",
    "识别语言": "识别语言",
    "灵感迸发": "灵感迸发",
    "头脑风暴": "头脑风暴",
}

# ===== 英文常见错误纠正 =====
EN_CORRECTIONS = {
    "this will include in that": "this will be included in that",
    "will include in": "will be included in",
}


def _fix_zh(text: str) -> str:
    """中文文本修正。"""
    for wrong, right in ZH_CORRECTIONS.items():
        text = text.replace(wrong, right)
    # 中英文之间加空格
    text = re.sub(r'([\u4e00-\u9fff])([a-zA-Z])', r'\1 \2', text)
    text = re.sub(r'([a-zA-Z])([\u4e00-\u9fff])', r'\1 \2', text)
    return text


def _fix_en(text: str) -> str:
    """英文文本修正。"""
    for wrong, right in EN_CORRECTIONS.items():
        text = text.replace(wrong, right)
    # 句首大写
    sentences = text.split('. ')
    sentences = [s[0].upper() + s[1:] if s else s for s in sentences]
    text = '. '.join(sentences)
    # I 大写
    text = re.sub(r'\bi\b', 'I', text)
    # 去除多余空格
    text = re.sub(r' +', ' ', text).strip()
    return text


def _cleanup(text: str) -> str:
    """通用文本清洗。"""
    # 去除重复标点
    text = re.sub(r'([。，！？；：、,.!?;:])\1+', r'\1', text)
    # 去除首尾空白
    text = text.strip()
    return text


def post_process(text: str, language: str = "auto") -> str:
    """
    ASR 后处理入口。
    根据检测到的语言应用对应修正规则。
    """
    if not text:
        return text

    text = _cleanup(text)

    if language == "zh":
        text = _fix_zh(text)
    elif language == "en":
        text = _fix_en(text)
    else:
        # auto: 混合处理
        text = _fix_zh(text)
        text = _fix_en(text)

    return text
