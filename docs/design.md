# 系统设计文档

## 一、系统架构

```
┌─────────────────────────────────────────┐
│            Browser (Chrome)            │
│  ┌─────────────────────────────────┐   │
│  │  HTML / CSS / Vanilla JS        │   │
│  │  ├── MediaRecorder (录音)       │   │
│  │  ├── File Upload (文件上传)     │   │
│  │  └── Fetch API → /api/transcribe│  │
│  └─────────────────────────────────┘   │
└───────────────────┬─────────────────────┘
                    │ HTTP (multipart/form-data)
┌───────────────────▼─────────────────────┐
│         FastAPI (Python 3.12)          │
│  ├── GET  /health                      │
│  ├── GET  /          → static/index.html│
│  ├── POST /api/transcribe              │
│  │     ├── 校验文件 (大小/格式)        │
│  │     ├── 保存临时文件                │
│  │     └── ASR 推理 → JSON 返回        │
│  └── StaticFiles → static/             │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│     faster-whisper (CTranslate2)        │
│  ├── Model: Whisper base (~150MB)     │
│  ├── Device: CPU                       │
│  ├── Compute: int8 量化                │
│  └── 首次自动下载，之后离线可用        │
└─────────────────────────────────────────┘
```

## 二、核心模块

### 2.1 `app/main.py` — FastAPI 路由

- `GET /health`：健康检查，返回 `{"status": "ok"}`
- `GET /`：返回前端页面
- `POST /api/transcribe`：接收 multipart/form-data（file + language），校验后调用 ASR 模块识别

### 2.2 `app/asr.py` — ASR 模型封装

- **懒加载**：模型在首次识别请求时才加载，不阻塞服务启动
- **线程安全**：使用 `threading.Lock` 防止并发重复加载
- **CPU int8 量化**：`WhisperModel("base", device="cpu", compute_type="int8")`
- **VAD 过滤**：`vad_filter=True` 自动去除静音段，提升短音频准确率
- **耗时统计**：`transcribe_with_timing()` 封装了推理耗时测量

### 2.3 `app/audio.py` — 音频校验

- 文件大小上限 10MB
- 允许格式：.wav / .webm / .ogg / .mp3 / .m4a / .flac
- 空文件、不支持格式抛出 `AudioValidationError`

### 2.4 前端 `static/app.js`

- **录音状态机**：idle → recording → processing → done/error
- **60 秒限制**：计时器到点自动 stop
- **错误处理**：区分 NotAllowedError（权限拒绝）和 NotFoundError（无麦克风）
- **结果展示**：文本、语言、音频时长、处理耗时、复制按钮

## 三、音频处理流程

```
录音/上传 → Blob → multipart/form-data → 后端保存临时文件
    → faster-whisper.transcribe() → segments 迭代
    → 拼接文本 → 返回 {text, language, duration_seconds, processing_seconds}
    → 删除临时文件 → 前端展示
```

## 四、ASR 模型选型

### 选择：faster-whisper (base 模型)

| 候选方案 | 优点 | 缺点 | 结论 |
|----------|------|------|------|
| **faster-whisper** | pip 直接安装；CPU 推理比原版快 4 倍；int8 量化；支持中英文；首次下载后离线 | 需要下载 ~150MB 模型 | **选用** |
| 原版 openai-whisper | 官方维护 | PyTorch 依赖 ~2GB；CPU 慢 | 不选 |
| whisper.cpp | 极快 | 需编译 C++，题目禁止 | 不选 |
| Vosk | 极小体积 | 中文准确率低 | 不选 |
| FunASR | 中文效果好 | 依赖链复杂，模型大 | 不选 |

**选 base 而非 small 的理由**：base（74M 参数）在普通笔记本 CPU 上 5 秒音频约 1-2 秒出结果，满足实时性要求；small（244M 参数）准确率略高但推理时间翻倍。面试复现环境为普通 CPU，base 是速度与准确率的最佳平衡点。

## 五、接口定义

### GET /health
```json
{"status": "ok"}
```

### POST /api/transcribe
- Content-Type: `multipart/form-data`
- 参数：`file` (File), `language` ("zh" | "en")
- 返回 200：
```json
{
  "text": "你好，欢迎使用语音识别系统",
  "language": "zh",
  "duration_seconds": 5.2,
  "processing_seconds": 1.8
}
```
- 错误：400（文件问题）/ 422（参数错误）/ 503（模型推理失败）
