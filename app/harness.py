"""
ASR 后处理 harness 层 — 规则 + 开源纠错库。
- pycorrector: 中文同音/近音错字纠正
- symspellpy: 英文拼写纠错
- 领域术语保护 + 文本清洗
"""
from __future__ import annotations
import logging
import re

logger = logging.getLogger("app.harness")

# ===== 领域术语保护（不被纠错库误改）=====
DOMAIN_TERMS = [
    "单次识别", "会议模式", "语音识别", "识别语言",
    "灵感迸发", "头脑风暴", "上传文件", "开始录音",
]

# ===== 中文常见错误纠正表（兜底）=====
ZH_CORRECTIONS = {
    # === 项目功能词 ===
    "单词识别": "单次识别",
    "单词模式": "单次模式",
    "开始路音": "开始录音",
    "停止路音": "停止录音",
    "开始录音": "开始录音",
    "停止录音": "停止录音",
    "上传音频": "上传音频",
    "上传文件": "上传文件",
    "导出文件": "导出文件",
    "复制文本": "复制文本",
    "历史记录": "历史记录",
    "磁带收藏": "磁带收藏",
    "语音识别": "语音识别",
    "语音转文字": "语音转文字",
    "实时识别": "实时识别",
    "实时转写": "实时转写",
    "中英混合": "中英混合",
    "中阴混合": "中英混合",
    "恨恨": "混合",
    "中英恨恨": "中英混合",
    "中英文混合": "中英文混合",
    # === 面试官常用词 ===
    "准备率": "准确率",
    "识别率": "识别率",
    "实事": "实时",
    "细统": "系统",
    "相目": "项目",
    "册试": "测试",
    "制持": "支持",
    "模形": "模型",
    "推里": "推理",
    "离县": "离线",
    "本低": "本地",
    "想应": "响应",
    "素度": "速度",
    "沿迟": "延迟",
    "卖克风": "麦克风",
    "留览器": "浏览器",
    "网叶": "网页",
    "紧致": "仅只",
    "紧质": "仅只",
    # === 技术词 ===
    "fastapi": "FastAPI",
    "python": "Python",
    "whisper": "Whisper",
    "openai": "OpenAI",
    "github": "GitHub",
    "api": "API",
    "cpu": "CPU",
    "gpu": "GPU",
    "uri": "URL",
    "json": "JSON",
}

# ===== 英文常见错误纠正 =====
# 注意：这里只放完整短语替换，不要放单字母（如 "i"）——dict 的 replace 是
# 子串全局替换，会把 this/city 等词里的小写 i 一并改大写。
# 独立代词 "I" 的大写由 _fix_en 末尾的正则 \bi\b 处理。
EN_CORRECTIONS = {
    "this will include in that": "this will be included in that",
    "will include in": "will be included in",
}

# 常见英文缩写：句首出现时保持全大写，避免句首大写规则只保留首字母（如 ok → OK）
EN_ACRONYMS = {
    "OK", "IT", "AI", "API", "CPU", "GPU", "UI", "UX", "URL", "HTTP", "HTTPS",
    "PDF", "USB", "CEO", "FAQ", "ID", "OS", "SDK", "APP", "VAD", "ASR",
    "JSON", "TCP", "IP", "DNS", "SQL", "CSV", "HTML", "CSS", "CLI", "IDE",
    "SaaS", "IoT", "MP3", "MP4", "AI", "BT", "WiFi", "DNS",
}
_ACRONYM_LOWER = {a.lower() for a in EN_ACRONYMS}

# 强制中文模式下允许混留的英文 token（技术缩写 / 品牌名 / 常用外来词）；
# 其余普通英文词属于“在中文模式下误识别出来的英文发音”，硬剔除。
_ZH_KEEP_LATIN = _ACRONYM_LOWER | {
    "fastapi", "python", "whisper", "openai", "github",
    "app", "wifi", "bluetooth", "usb", "pdf",
}

# 初始化纠错库（懒加载）
_pycorrector = None
_symspell = None
_opencc = None


def _get_opencc():
    global _opencc
    if _opencc is None:
        try:
            from opencc import OpenCC
            _opencc = OpenCC('t2s')  # 繁体 → 简体
        except Exception:
            _opencc = False
    return _opencc


def _get_pycorrector():
    global _pycorrector
    if _pycorrector is None:
        try:
            import pycorrector
            pycorrector.set_model_path(None)  # 使用内置词典
            _pycorrector = pycorrector
        except Exception as e:
            # 常见原因：环境未装 torch（pycorrector 深层依赖）。
            # 此时优雅降级为纯规则纠错，绝不让识别请求因此 500。
            logger.warning(
                "pycorrector 不可用，降级为规则纠错: %s: %s", type(e).__name__, e
            )
            _pycorrector = False
    return _pycorrector


def _get_symspell():
    global _symspell
    if _symspell is None:
        try:
            from importlib import resources
            from symspellpy import SymSpell, Verbosity

            sym = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
            # 用 importlib.resources 定位包内词典，避免依赖在 Python 3.13 环境
            # 已不可用的 pkg_resources；文件系统用路径，打包环境退回文本流。
            dict_resource = resources.files("symspellpy").joinpath(
                "frequency_dictionary_en_82_765.txt"
            )
            if dict_resource.is_file():
                dict_source = str(dict_resource)
            else:
                dict_source = dict_resource.open("r", encoding="utf-8")

            ok = sym.load_dictionary(dict_source, term_index=0, count_index=1)
            if not ok:
                raise RuntimeError("symspell load_dictionary 返回 False，词典未载入")
            _symspell = (sym, Verbosity)
        except Exception as e:
            # 任何加载失败都优雅降级为英文规则纠错，绝不让识别请求 500
            logger.warning(
                "symspell 不可用，英文拼写纠错降级为规则处理: %s: %s",
                type(e).__name__,
                e,
            )
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


def _protect_english(text: str) -> tuple[str, dict]:
    """把英文单词替换成占位符，防止被中文纠错库误改。"""
    placeholders = {}
    i = 0
    def _replace(m):
        nonlocal i
        key = f"__EN_{i}__"
        placeholders[key] = m.group(0)
        i += 1
        return key
    text = re.sub(r'[a-zA-Z][a-zA-Z0-9\']*', _replace, text)
    return text, placeholders


def _restore_terms(text: str, placeholders: dict) -> str:
    """恢复领域术语。"""
    for key, term in placeholders.items():
        text = text.replace(key, term)
    return text


def _fix_zh(text: str) -> str:
    """中文文本修正：规则 + pycorrector（英文单词受保护）。"""
    # 纯英文文本跳过中文纠错
    if not re.search(r'[\u4e00-\u9fff]', text):
        return text

    # 规则兜底
    for wrong, right in ZH_CORRECTIONS.items():
        text = text.replace(wrong, right)

    # pycorrector 纠错（先保护英文单词和领域术语）
    corrector = _get_pycorrector()
    if corrector and corrector is not False:
        original = text
        try:
            text, en_placeholders = _protect_english(text)
            text, term_placeholders = _protect_terms(text)
            corrected = corrector.correct(text)
            text = corrected["corrected_text"]
            text = _restore_terms(text, term_placeholders)
            text = _restore_terms(text, en_placeholders)
        except Exception:
            # 纠错内部报错（含缺失 torch 引发的深层异常）时回退纠错前原文，
            # 防止 __EN_0__ / __TERM_1__ 这类占位符泄露到最终文本
            logger.debug("pycorrector.correct 调用失败，回退原文", exc_info=True)
            text = original

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
                # 已知缩写（api/ai/cpu 等）不交给 symspell，避免被词典噪声误改（api→apr）
                letters = re.sub(r"[^A-Za-z]", "", word).lower()
                if letters in _ACRONYM_LOWER:
                    corrected_words.append(word)
                    continue
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

    # 句首大写：普通词首字母大写；已知缩写保持全大写；已是全大写的不破坏
    sentences = text.split(". ")
    new_sentences = []
    for s in sentences:
        if not s:
            new_sentences.append(s)
            continue
        m = re.match(r"^(\s*)([A-Za-z]+)(.*)$", s)
        if not m:
            new_sentences.append(s)
            continue
        lead, word, rest = m.groups()
        if word.upper() in EN_ACRONYMS:
            word = word.upper()
        elif not word.isupper():
            word = word[0].upper() + word[1:]
        new_sentences.append(lead + word + rest)
    text = ". ".join(new_sentences)
    text = re.sub(r"\bi\b", "I", text)
    text = re.sub(r' +', ' ', text).strip()
    return text


def _cleanup(text: str) -> str:
    """通用文本清洗。"""
    text = re.sub(r'([。，！？；：、,.!?;:])\1+', r'\1', text)
    # 去除重复短语（模型幻觉）
    # 匹配连续重复的英文单词（3次以上）
    text = re.sub(r'\b([a-zA-Z]+)(\s+\1){2,}\b', r'\1', text)
    # 去除重复的中文短语（只清理明显的3字以上重复）
    text = re.sub(r'([\u4e00-\u9fff]{3,})\1{1,}', r'\1', text)
    return text.strip()


def _enforce_zh(text: str) -> str:
    """强制中文：剔除普通英文词，仅保留白名单技术缩写 / 外来词。"""
    def _repl(m):
        raw = m.group(0)
        key = re.sub(r"[^a-zA-Z]", "", raw).lower()
        return raw if key in _ZH_KEEP_LATIN else ""
    out = re.sub(r"[A-Za-z][A-Za-z0-9'.\-]*", _repl, text)
    out = re.sub(r"[ \t]{2,}", " ", out)
    # 英文词被删后残留的英文标点单独清掉，中文标点保留
    out = re.sub(r"\s*[,.!?;:]\s*", " ", out)
    out = re.sub(r"[，。！？；：、]{2,}", lambda m: m.group(0)[0], out)
    return out.strip(" \t,.;:!?，。！？；：、")


def _enforce_en(text: str) -> str:
    """强制英文：剔除全部中文字符（缩写/技术词不受影响，因为本就不含中文）。"""
    out = re.sub(r"[一-鿿]+", "", text)
    out = re.sub(r"[，。！？；：、]+", " ", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out.strip(" \t,.;:!?，。！？；：、")


def post_process(text: str, language: str = "auto", forced: bool = False) -> tuple[str, str]:
    """ASR 后处理入口。返回 (修正后文本, 修正后语言)。"""
    if not text:
        return text, language

    text = _cleanup(text)

    # 繁体转简体
    cc = _get_opencc()
    if cc and cc is not False:
        try:
            text = cc.convert(text)
        except Exception:
            pass

    # 文本反推：仅在非强制（auto / 模型自动检测）时允许纠正语言；
    # 用户显式选定 zh/en 时以用户选择为准，不再反推翻转
    if not forced and (language == "en" or language == "auto"):
        zh_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
        en_words = len(re.findall(r'[a-zA-Z]+', text))
        if zh_chars > en_words * 2:
            language = "zh"

    if language == "zh":
        text = _fix_zh(text)
    elif language == "en":
        text = _fix_en(text)
    else:
        text = _fix_zh(text)
        text = _fix_en(text)

    # 强制语言硬约束：zh 不留普通英文词，en 不留中文；auto 模式允许中英混说
    if forced:
        if language == "zh":
            text = _enforce_zh(text)
        elif language == "en":
            text = _enforce_en(text)

    return text, language
