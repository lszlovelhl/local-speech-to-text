# 系统设计文档

> 对应版本：应用 `version="3.0.0"`（见 `app/main.py`）。本文以当前代码实现为准。

## 一、系统架构

```
┌─────────────────────────────────────────────────┐
│            Browser (Chrome / Edge / Safari)      │
│  ┌─────────────────────────────────────────┐    │
│  │  HTML / CSS / Vanilla JS（无框架）        │    │
│  │  ├── MediaRecorder（录音采集）            │    │
│  │  ├── Web Audio API AnalyserNode（前端 VAD）│    │
│  │  ├── Canvas 波形 + VU 电平绘制             │    │
│  │  ├── 文件上传（音频 / 视频音轨）           │    │
│  │  ├── IndexedDB + localStorage 磁带收藏     │    │
│  │  └── Fetch API → POST /api/transcribe   │    │
│  └─────────────────────────────────────────┘    │
└───────────────────┬─────────────────────────────┘
                    │ HTTP（multipart/form-data）
┌───────────────────▼─────────────────────────────┐
│         FastAPI（Python 3.12 / 3.13）            │
│  ├── GET  /health                                │
│  ├── GET  /                 → static/index.html │
│  ├── POST /api/transcribe                         │
│  │     ├── 大小预判 + 扩展名分流（音频/视频）     │
│  │     ├── audio.py 校验 → 临时文件               │
│  │     ├── PyAV 探测音轨                          │
│  │     ├── ASR 推理（线程池 + 串行锁）            │
│  │     └── harness.py 后处理 → JSON 返回          │
│  └── StaticFiles → static/                       │
└───────────────────┬─────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────┐
│     faster-whisper（CTranslate2，CPU int8）      │
│  ├── 默认模型 small（约 464MB，本地目录优先）    │
│  ├── 回退模型 base（约 141MB）                   │
│  ├── 后端 VAD filter 二次过滤静音段               │
│  └── 首次联网下载到 models/，之后离线可用        │
└─────────────────────────────────────────────────┘
```

## 二、核心模块

### 2.1 `app/main.py` — FastAPI 路由与编排

- `GET /health`：健康检查，返回 `{"status": "ok"}`
- `GET /`：返回 `static/index.html`；`/static` 由 `StaticFiles` 挂载
- `POST /api/transcribe`：
  - 先按 `Content-Length` 预判大小，避免超大文件撑爆内存
  - 扩展名命中 `VIDEO_EXTENSIONS` 时走视频上限（200MB），否则走音频上限（100MB）
  - 非视频文件先过 `audio.validate_upload`；再用 PyAV `av.open` 探测是否含可解码音频流
  - `run_in_threadpool` 执行 ASR，避免阻塞事件循环
  - 异常统一映射为 400 / 422 / 503；`finally` 删除临时文件

### 2.2 `app/asr.py` — ASR 模型封装

- **懒加载**：模型首次识别时才加载，不阻塞服务启动、不影响 pytest
- **线程安全**：`_model_lock` 防止并发重复加载；`_transcribe_lock` 保证同一时间只推理一个请求，避免 CTranslate2 并发崩溃
- **本地模型查找**：`_find_local_model()` 按「`WHISPER_MODEL` 指定目录优先 → 其余本地目录依次回退」查找 `model.bin`；默认 `WHISPER_MODEL=small`
- **推理参数**：`device="cpu"`、`compute_type="int8"`、`beam_size=5`、`vad_filter=True`（`min_silence_duration_ms=500`）、`condition_on_previous_text=False`
- **语言与提示词**：`auto` 时不传 language 由模型检测；`en` / `zh` 注入 `initial_prompt` 领域提示词，提升术语与标点质量
- **分段结果**：遍历 `segments_iter` 收集 `{start, end, text}`，整体文本与分段文本均送入 `harness.post_process` 后处理
- **兼容补丁**：对 `av.open` 做包装，自动剥离新旧 av 版本不兼容的 `metadata_errors` 参数
- **异常**：加载或推理失败抛出 `ModelNotLoadedError`，由路由转 503

### 2.3 `app/harness.py` — 识别后处理

- 通用清洗：标点去重、英文连续重复词与中文重复短语（模型幻觉）去除
- 繁简转换：OpenCC `t2s`（导入失败自动跳过）
- 中文纠错：内置规则纠正表 + pycorrector（英文单词与领域术语先占位保护再恢复）
- 英文纠错：symspellpy 词典近邻替换 + 规则表 + 句首大写
- 语言反推：检测到 en/auto 但中文字符占优时自动改判为 zh
- **降级策略**：pycorrector / symspellpy / OpenCC 均为懒加载，任一导入或初始化失败置为 `False` 并跳过，绝不抛异常中断主流程

### 2.4 `app/audio.py` — 上传校验与临时文件

- 空文件检测；扩展名白名单校验；大小校验（`MAX_FILE_SIZE` 兼容别名指向 `MAX_AUDIO_SIZE`）
- `tempfile.mkstemp` 写临时文件，`cleanup_temp` 在请求结束后删除
- 视频文件不走 `validate_upload` 扩展名白名单（由 `config.VIDEO_EXTENSIONS` 与 PyAV 探测保证合法性）

### 2.5 `app/config.py` — 集中配置（唯一真相源）

| 配置项 | 值 | 用途 |
|--------|----|------|
| `MAX_AUDIO_SIZE` | 100 MB | 音频上传上限 |
| `MAX_VIDEO_SIZE` | 200 MB | 视频上传上限 |
| `VIDEO_EXTENSIONS` | .mp4 / .mov / .mkv / .avi / .webm / .m4v | PyAV 提取音轨 |
| `ALLOWED_EXTENSIONS` | .wav / .webm / .ogg / .mp3 / .m4a / .flac | 音频白名单 |

### 2.6 前端 `static/`

**录音与前端 VAD：**
- `getUserMedia` 开启 `noiseSuppression + echoCancellation + autoGainControl`（浏览器硬件级降噪）
- 录音开始先测 500ms 环境底噪，说话阈值 = 底噪 × 2.5（`VAD_SENSITIVITY`）自适应
- 最短说话 300ms；最短静音 600ms 判定切片；最长切片 10000ms 强制切分（安全网）
- 会议模式下 AnalyserNode 持续采样音量，驱动波形 Canvas 与 VU 电平条

**结果与历史：**
- 结果区展示语言、时长、处理耗时；多段结果渲染 `segments` 时间戳列表
- 复制到剪贴板、导出 TXT、清空结果；空格键快捷启停录音
- 磁带收藏：`localStorage` 保存元数据（模式/文本/时长/分段/时间戳，最多 20 条、24h 清除），录音 Blob 存 IndexedDB `stt_db`；点击磁带弹窗回放音频

**视觉与适配：**
- 拟真便携录音机造型（STT-2000）、毛玻璃卡片、iOS 分段选择器
- `prefers-color-scheme: dark` 自动深色模式；单次/会议两种模式切换主题色调
- 响应式布局，窄屏按钮保证可点击尺寸

## 三、音频处理流程

```
录音 / 上传文件
  → （前端 VAD 切片 Blob）multipart/form-data → 后端临时文件
  → PyAV 探测可解码音轨
  → faster-whisper.transcribe（vad_filter + initial_prompt + beam_size=5）
  → segments + 全文本 → harness.post_process（繁简/纠错/清洗/语言反推）
  → 返回 {text, language, duration_seconds, processing_seconds, segments}
  → finally 删除临时文件；前端渲染并写入本地磁带收藏
```

## 四、ASR 模型选型

| 候选方案 | 优点 | 缺点 | 结论 |
|----------|------|------|------|
| **faster-whisper** | pip 直接安装；CTranslate2 在 CPU 上比原版快约 4 倍；int8 量化；支持中英文与自动语言检测；不依赖 PyTorch | 需下载本地权重（small 约 464MB） | **选用** |
| 原版 openai-whisper | 官方维护 | 依赖 PyTorch 体积大、CPU 推理慢 | 不选 |
| whisper.cpp | 极快 | 需本地编译 C++ 工具链，部署成本高 | 不选 |
| Vosk | 模型小、离线友好 | 中文准确率与词表覆盖弱 | 不选 |

**模型规格策略：默认 small、base 回退。** small（244M 参数，约 464MB）在中英文准确率上明显优于 base；若本地仅有 base（74M 参数，约 141MB）或设置 `WHISPER_MODEL=base`，系统自动加载 base 换取 CPU 速度。模型均从本地 `models/faster-whisper-<size>/` 优先加载，找不到时才由 WhisperModel 在线拉取。

## 五、VAD 自适应切片策略

| 参数 | 取值 | 位置 | 说明 |
|------|------|------|------|
| 噪音采样时长 | 500ms | 前端 `VAD_NOISE_MEASURE_MS` | 录音开始先测环境底噪 |
| 阈值倍率 | 2.5× | 前端 `VAD_SENSITIVITY` | 说话音量阈值 = 底噪 × 2.5 |
| 最短说话 | 300ms | 前端 `VAD_MIN_SPEECH_MS` | 短于此时长不算说话，防误触 |
| 最短静音 | 600ms | 前端 `VAD_MIN_SILENCE_MS` | 连续静音 0.6s 才切片（会议模式） |
| 最大切片 | 10000ms | 前端 `VAD_MAX_CHUNK_MS` | 持续说话不切时 10s 强制切分 |
| 浏览器降噪 | 硬件级 | getUserMedia | noiseSuppression + echoCancellation + autoGainControl |
| 后端 VAD | 二次过滤 | `asr.py` `vad_filter=True` | `min_silence_duration_ms=500` |

> 三层防护：采集端硬件降噪 → 前端音量阈值切片 → 后端模型端 VAD 过滤静音段。

## 六、接口定义

### GET /health

```json
{"status": "ok"}
```

### POST /api/transcribe

- Content-Type：`multipart/form-data`
- 参数：
  - `file`（必填）：音频（≤100MB，wav/webm/ogg/mp3/m4a/flac）或视频（≤200MB，mp4/mov/mkv/avi/webm/m4v，提取音轨）
  - `language`：`zh` / `en` / `auto`，默认 `auto`
- 成功 200：

```json
{
  "text": "你好，欢迎使用语音识别系统。",
  "language": "zh",
  "duration_seconds": 5.2,
  "processing_seconds": 1.8,
  "segments": [
    { "start": 0.0, "end": 2.41, "text": "你好，欢迎使用" },
    { "start": 2.41, "end": 5.2, "text": "语音识别系统。" }
  ]
}
```

- 错误码：
  - `400`：空文件、扩展名不支持、超过大小上限、文件无法解码或不含音频流
  - `422`：缺少 `file` 字段，或 `language` 不在 zh/en/auto 内
  - `503`：模型加载失败或推理过程异常
