"""
ASR 后处理 harness 层 — 规则 + 开源纠错库。
- pycorrector: 中文同音/近音错字纠正
- symspellpy: 英文拼写纠错
- 领域术语保护 + 文本清洗
"""
from __future__ import annotations
import re

# ===== 领域术语保护（不被纠错库误改）=====
DOMAIN_TERMS = [
    "单次识别", "会议模式", "语音识别", "识别语言",
    "灵感迸发", "头脑风暴", "上传文件", "开始录音",
]

# ===== 中文常见错误纠正表（兜底）=====
ZH_CORRECTIONS = {
    "单词识别": "单次识别",
    "单词模式": "单次模式",
    "紧致": "仅只",
    "紧质": "仅只",
}

# ===== 英文常见错误纠正 =====
EN_CORRECTIONS = {
    "this will include in that": "this will be included in that",
    "will include in": "will be included in",
}

# 初始化纠错库（懒加载）
_pycorrector = None
_symspell = None


def _get_pycorrector():
    global _pycorrector
    if _pycorrector is None:
        try:
            import pycorrector
            pycorrector.set_model_path(None)  # 使用内置词典
            _pycorrector = pycorrector
        except Exception:
            _pycorrector = False
    return _pycorrector


def _get_symspell():
    global _symspell
    if _symspell is None:
        try:
            from symspellpy import SymSpell, Verbosity
            import pkg_resources
            sym = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
            dict_path = pkg_resources.resource_filename(
                "symspellpy", "frequency_dictionary_en_82_765.txt"
            )
            sym.load_dictionary(dict_path, term_index=0, count_index=1)
            _symspell = (sym, Verbosity)
        except Exception:
            _symspell = False
    return _symspell


def _protect_terms(text: str) -> tuple[str, dict]:
    """把领域术语替换成占位符，防止被纠错库误改。"""
    placeholders = {}
    for i, term in enumerate(DOMAIN_TERMS):
        if term in text:
            key = f"__TERM_{i}__"
            text = text.replace(term, key)
            placeholders[key] = term
    return text, placeholders


def _restore_terms(text: str, placeholders: dict) -> str:
    """恢复领域术语。"""
    for key, term in placeholders.items():
        text = text.replace(key, term)
    return text


def _fix_zh(text: str) -> str:
    """中文文本修正：规则 + pycorrector。"""
    # 规则兜底
    for wrong, right in ZH_CORRECTIONS.items():
        text = text.replace(wrong, right)

    # pycorrector 纠错
    corrector = _get_pycorrector()
    if corrector and corrector is not False:
        try:
            text, placeholders = _protect_terms(text)
            corrected = corrector.correct(text)
            text = corrected["corrected_text"]
            text = _restore_terms(text, placeholders)
        except Exception:
            pass

    # 中英文之间加空格
    text = re.sub(r'([\u4e00-\u9fff])([a-zA-Z])', r'\1 \2', text)
    text = re.sub(r'([a-zA-Z])([\u4e00-\u9fff])', r'\1 \2', text)
    return text


def _fix_en(text: str) -> str:
    """英文文本修正：symspell + 规则。"""
    # symspell 拼写纠错
    result = _get_symspell()
    if result and result is not False:
        sym, Verbosity = result
        try:
            words = text.split()
            corrected_words = []
            for word in words:
                # 跳过短词、全大写、带标点的词
                if len(word) <= 2 or word.isupper() or not word.isalpha():
                    corrected_words.append(word)
                    continue
                suggestions = sym.lookup(word, Verbosity.CLOSEST, max_edit_distance=2)
                if suggestions:
                    corrected_words.append(suggestions[0].term)
                else:
                    corrected_words.append(word)
            text = " ".join(corrected_words)
        except Exception:
            pass

    # 规则修正
    for wrong, right in EN_CORRECTIONS.items():
        text = text.replace(wrong, right)

    # 句首大写
    sentences = text.split('. ')
    sentences = [s[0].upper() + s[1:] if s else s for s in sentences]
    text = '. '.join(sentences)
    text = re.sub(r'\bi\b', 'I', text)
    text = re.sub(r' +', ' ', text).strip()
    return text


def _cleanup(text: str) -> str:
    """通用文本清洗。"""
    text = re.sub(r'([。，！？；：、,.!?;:])\1+', r'\1', text)
    return text.strip()


def post_process(text: str, language: str = "auto") -> str:
    """ASR 后处理入口。"""
    if not text:
        return text

    text = _cleanup(text)

    if language == "zh":
        text = _fix_zh(text)
    elif language == "en":
        text = _fix_en(text)
    else:
        text = _fix_zh(text)
        text = _fix_en(text)

    return text
