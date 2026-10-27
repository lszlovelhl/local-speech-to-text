# Local Speech-to-Text

基于本地开源 ASR 模型的中英文语音识别 Web 应用，支持自动语言检测、会议模式实时识别、VAD 自适应切片。

## 环境要求

- Python 3.12+
- Chrome / Edge 最新稳定版（Safari 也可）
- 无需 GPU，普通 CPU 即可运行
- 首次启动需联网下载模型权重（约 150MB），之后可完全断网运行

## 快速启动

```bash
# 方式一：一键启动（自动开浏览器）
./start.sh          # macOS / Linux
start.bat           # Windows

# 方式二：手动启动
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

浏览器访问 http://127.0.0.1:8000

首次识别时会自动下载 Whisper base 模型（约 150MB），缓存在 `~/.cache/huggingface/`。

## 运行测试

```bash
# 常规自动化测试（mock 模型，秒级完成，不下载权重）
python -m pytest -q

# 真实模型测试（需先下载模型）
python -m pytest -m real_model -v
```

## 功能说明

- **自动语言检测**：默认 auto 模式，中英文混说自动识别，无需手动切换
- **单次识别模式**：录完一段后点停止，一次性识别
- **会议模式**：持续录音，VAD 自动检测停嘴切片，文字实时追加显示
- **VAD 自适应切片**：浏览器硬件降噪 + 自适应音量阈值 + 最短/最长保护
- **文件上传**：支持 WAV / WebM / OGG / MP3 / M4A / FLAC，上限 10MB
- **苹果风格 UI**：SF Pro 字体、毛玻璃卡片、iOS 分段选择器、移动端响应式
- **离线运行**：模型下载后断网可用

## 项目结构

```
local-speech-to-text/
├── app/
│   ├── main.py        # FastAPI 路由与入口
│   ├── asr.py         # ASR 模型封装（faster-whisper）
│   └── audio.py       # 音频校验与工具
├── static/
│   ├── index.html     # Web 页面
│   ├── style.css      # 苹果风格 + 移动端响应式
│   └── app.js         # 录音、VAD、上传、API 调用
├── tests/             # pytest 测试（mock + real_model 分离）
├── samples/           # 测试音频样本
├── docs/              # 设计文档与测试报告
├── start.sh / start.bat  # 一键启动脚本
└── requirements.txt
```

## ASR 模型

使用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 后端），base 模型，CPU int8 量化推理。详见 `docs/design.md`。
