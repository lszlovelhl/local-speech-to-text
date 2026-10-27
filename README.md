# Local Speech-to-Text

基于本地开源 ASR 模型的中英文语音识别 Web 应用。

## 环境要求

- Python 3.12+
- Chrome / Edge 最新稳定版
- 无需 GPU，普通 CPU 即可运行
- 首次启动需联网下载模型权重（约 150MB），之后可完全断网运行

## 快速启动

```bash
# 1. 安装依赖
python -m pip install -r requirements.txt

# 2. 启动服务
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3. 浏览器访问
#    Chrome 打开 http://127.0.0.1:8000
```

首次识别时会自动下载 Whisper base 模型（约 150MB），请耐心等待。模型缓存在 `~/.cache/huggingface/` 目录。

## 运行测试

```bash
# 常规自动化测试（mock 模型，秒级完成）
python -m pytest -q

# 真实模型测试（需先下载模型，会实际调用 ASR）
python -m pytest -m real_model -v
```

## 功能说明

- **麦克风录音**：点击 Start Recording 开始录音，Stop 结束，最长 60 秒
- **文件上传**：支持 WAV / WebM / OGG / MP3 格式，上限 10MB
- **中英文切换**：页面右上角选择识别语言（zh / en）
- **实时反馈**：录音状态、识别进度、处理耗时均有展示
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
│   ├── style.css
│   └── app.js         # 录音、上传、API 调用
├── tests/             # pytest 测试
├── samples/           # 测试音频样本
├── docs/              # 设计文档与测试报告
└── requirements.txt
```

## ASR 模型

使用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 后端），base 模型，CPU int8 量化推理。详见 `docs/design.md`。
