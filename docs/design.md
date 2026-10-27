# 系统设计文档

## 一、系统架构

```
┌─────────────────────────────────────────────┐
│            Browser (Chrome/Edge/Safari)      │
│  ┌─────────────────────────────────────┐    │
│  │  HTML / CSS / Vanilla JS            │    │
│  │  ├── MediaRecorder (录音)          │    │
│  │  ├── Web Audio API (VAD 音量检测)  │    │
│  │  ├── getUserMedia 硬件级降噪        │    │
│  │  ├── File Upload (文件上传)         │    │
│  │  └── Fetch API → /api/transcribe   │    │
│  └─────────────────────────────────────┘    │
└───────────────────┬─────────────────────────┘
                    │ HTTP (multipart/form-data)
┌───────────────────▼─────────────────────────┐
│         FastAPI (Python 3.12)             │
│  ├── GET  /health                        │
│  ├── GET  /          → static/index.html │
│  ├── POST /api/transcribe                 │
│  │     ├── 校验文件 (大小/格式)          │
│  │     ├── 保存临时文件                   │
│  │     └── ASR 推理 → JSON 返回           │
│  └── StaticFiles → static/               │
└───────────────────┬─────────────────────────┘
                    │
┌───────────────────▼─────────────────────────┐
│     faster-whisper (CTranslate2)           │
│  ├── Model: Whisper base (~150MB)         │
│  ├── Device: CPU, int8 量化               │
│  ├── VAD filter: 后端二次过滤静音段        │
│  └── 首次自动下载，之后离线可用           │
└─────────────────────────────────────────────┘
```

## 二、核心模块

### 2.1 `app/main.py` — FastAPI 路由

- `GET /health`：健康检查，返回 `{"status": "ok"}`
- `GET /`：返回前端页面
- `POST /api/transcribe`：接收 multipart/form-data（file + language），language 支持 zh / en / auto

### 2.2 `app/asr.py` — ASR 模型封装

- **懒加载**：模型首次识别时才加载，不阻塞服务启动
- **线程安全**：`threading.Lock` 防止并发重复加载
- **CPU int8 量化**：`WhisperModel("base", device="cpu", compute_type="int8")`
- **VAD 过滤**：`vad_filter=True` 后端自动去除静音段
- **自动语言检测**：language=auto 时不传参数给 Whisper，由模型自动检测
- **耗时统计**：`transcribe_with_timing()` 封装推理耗时测量

### 2.3 `app/audio.py` — 音频校验

- 文件大小上限 10MB
- 允许格式：.wav / .webm / .ogg / .mp3 / .m4a / .flac
- 空文件、不支持格式抛出 `AudioValidationError`

### 2.4 前端 `static/app.js`

**录音与 VAD：**
- `getUserMedia` 开启 `noiseSuppression + echoCancellation + autoGainControl`（浏览器硬件级降噪）
- 录音开始先测 0.5 秒噪音底噪，说话阈值 = 底噪 × 2.5（自适应）
- 最短说话 0.3 秒、最短静音 1.5 秒才判定切片
- 最长 8 秒强制切片（安全网）
- 会议模式下每 250ms 收集音频数据，VAD 循环检测音量

**双模式：**
- **单次识别**：录完点停止，一次性提交识别
- **会议模式**：持续录音，VAD 检测停嘴自动切片提交，文字实时追加

**错误处理：**
- 区分 NotAllowedError（权限拒绝）和 NotFoundError（无麦克风）
- 识别失败允许重试，不崩溃

## 三、音频处理流程

```
录音 → MediaRecorder 分片 → VAD 检测停嘴 → 切片 Blob
  → multipart/form-data → 后端保存临时文件
  → faster-whisper.transcribe()（vad_filter=True）
  → 拼接文本 → 返回 {text, language, duration_seconds, processing_seconds}
  → 删除临时文件 → 前端追加展示
```

## 四、ASR 模型选型

| 候选方案 | 优点 | 缺点 | 结论 |
|----------|------|------|------|
| **faster-whisper** | pip 直接安装；CPU 推理快 4 倍；int8 量化；支持中英文；自动语言检测 | 需下载 ~150MB | **选用** |
| 原版 openai-whisper | 官方维护 | PyTorch 依赖 ~2GB；CPU 慢 | 不选 |
| whisper.cpp | 极快 | 需编译 C++，题目禁止 | 不选 |
| Vosk | 极小体积 | 中文准确率低 | 不选 |

**选 base 而非 small**：base（74M 参数）在普通 CPU 上 5 秒音频约 1-2 秒出结果；small 准确率略高但推理时间翻倍。复现环境为普通 CPU，base 是速度与准确率的最佳平衡。

## 五、VAD 自适应切片策略

| 参数 | 值 | 说明 |
|------|-----|------|
| 噪音采样时长 | 500ms | 录音开始先测环境底噪 |
| 阈值倍率 | 2.5× | 说话音量 = 底噪 × 2.5 |
| 最短说话 | 300ms | 短于此时长不算说话（防误触） |
| 最短静音 | 1500ms | 连续静音 1.5 秒才切片 |
| 最大切片 | 8000ms | 不管有没有停嘴，8 秒强制切 |
| 浏览器降噪 | 硬件级 | noiseSuppression + echoCancellation + autoGainControl |
| 后端 VAD | 二次过滤 | faster-whisper vad_filter=True |

## 六、接口定义

### GET /health
```json
{"status": "ok"}
```

### POST /api/transcribe
- Content-Type: `multipart/form-data`
- 参数：`file` (File), `language` ("zh" | "en" | "auto"，默认 auto)
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
