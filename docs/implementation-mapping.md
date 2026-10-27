# 需求实现对照表

本文档逐条对照题目要求，说明每项要求的实现位置、实现方式和设计原因。

---

## 一、必做功能（F1-F5）

### F1：浏览器麦克风录音

| 项目 | 说明 |
|------|------|
| **题目要求** | 浏览器可访问麦克风、录制并停止录音 |
| **实现位置** | `static/app.js` → `startRecording()` / `stopRecording()` |
| **实现方式** | 使用 MediaRecorder API + Web Audio AnalyserNode，浏览器硬件降噪（noiseSuppression / echoCancellation / autoGainControl），录音时长实时显示，无硬编码时长限制 |
| **设计原因** | MediaRecorder 是浏览器原生 API，无需第三方库；硬件降噪在采集端处理，减轻后端压力 |
| **验证方式** | 点击录音按钮 → 浏览器弹权限 → 说话 → 点停止 → 自动提交识别 |

### F2：音频文件上传

| 项目 | 说明 |
|------|------|
| **题目要求** | 可通过上传音频文件独立验证识别功能 |
| **实现位置** | `static/index.html` 文件上传区 + `app/main.py` POST /api/transcribe |
| **实现方式** | `<input type="file" accept=".wav,.webm,.ogg,.mp3,.m4a,.flac">`，上传后与录音走同一后端接口 |
| **设计原因** | 复用同一后端识别逻辑，避免代码重复；多格式支持由 PyAV 底层解码保证 |
| **验证方式** | 选择 samples/chinese.wav → 上传 → 返回识别文本 |

### F3：本地 ASR 模型（中英文）

| 项目 | 说明 |
|------|------|
| **题目要求** | 使用真实本地 ASR 模型分别识别中文和英文，CPU 推理，断网可用 |
| **实现位置** | `app/asr.py` → `_load_model()` |
| **实现方式** | faster-whisper small 模型（CTranslate2 后端），CPU int8 量化，优先从本地 `models/faster-whisper-small/` 加载，无需联网 |
| **设计原因** | 选择 faster-whisper 而非原版 Whisper：CTranslate2 在 CPU 上快 4 倍，pip 直接安装无需编译；选择 small 而非 base：英文准确率明显更高，体积 460MB 可接受 |
| **验证方式** | 断网后录音识别仍正常工作 |

### F4：识别结果展示

| 项目 | 说明 |
|------|------|
| **题目要求** | 识别结果正确返回并展示在 Web 页面 |
| **实现位置** | `static/app.js` → `showResult()` + `static/index.html` 结果区 |
| **实现方式** | 展示识别文本、检测到的语言、音频时长、处理耗时，附复制按钮 |
| **设计原因** | 完整展示返回 JSON 的所有字段，方便面试官对照接口规范验证 |
| **验证方式** | 录音后页面显示识别文本和耗时 |

### F5：异常处理

| 项目 | 说明 |
|------|------|
| **题目要求** | 能够处理常见错误，而不是直接崩溃 |
| **实现位置** | 前端 `static/app.js` 错误处理 + 后端 `app/main.py` 异常捕获 |
| **实现方式** | 前端区分：麦克风权限拒绝、无录音设备、录音为空；后端区分：空文件、格式不支持、超过 10MB、模型加载失败。均返回友好提示而非 500 |
| **设计原因** | 题目明确要求"不直接崩溃"，每个异常路径都有对应的测试用例 |
| **验证方式** | 拒绝麦克风权限 → 页面提示"请允许麦克风访问"；上传 .txt 文件 → 提示格式不支持 |

---

## 二、加分功能（F6）

### F6：实时语音识别

| 项目 | 说明 |
|------|------|
| **题目要求** | 实时转换，保持录音状态直到手动停止（会议模式） |
| **实现位置** | `static/app.js` → 会议模式 VAD 切片逻辑 |
| **实现方式** | 持续录音，AnalyserNode 检测音量变化，自适应阈值（2.5× 底噪），检测到停嘴（500ms 静音）自动切片提交后端识别，文字实时追加到结果区 |
| **设计原因** | 三层防护：浏览器硬件降噪（采集端）+ 自适应阈值（前端 VAD）+ 后端 vad_filter（模型端），确保嘈杂环境下也能正确切片 |
| **验证方式** | 切到会议模式 → 持续说话 → 停嘴后自动出字 → 继续说 → 文字追加 |

---

## 三、接口规范

### GET /health

| 项目 | 说明 |
|------|------|
| **题目要求** | 健康检查接口 |
| **实现位置** | `app/main.py` → `@app.get("/health")` |
| **返回格式** | `{"status": "ok"}` |
| **测试位置** | `tests/test_health.py` |

### POST /api/transcribe

| 项目 | 说明 |
|------|------|
| **题目要求** | multipart/form-data：file（音频文件）+ language（zh/en/auto） |
| **实现位置** | `app/main.py` → `@app.post("/api/transcribe")` |
| **返回格式** | `{"text": "...", "language": "zh", "duration_seconds": 3.5, "processing_seconds": 1.2}` |
| **测试位置** | `tests/test_transcribe_api.py` |

---

## 四、测试要求

| 题目要求 | 实现位置 | 说明 |
|----------|----------|------|
| 自动化测试（mock 模型） | `tests/test_health.py`、`test_transcribe_api.py`、`test_audio.py` | 16 个用例，秒级完成 |
| 真实模型测试 | `tests/test_real_model.py` | 标记 `@pytest.mark.real_model`，默认跳过 |
| pytest.ini 配置 | `pytest.ini` | `addopts = -m "not real_model"` |
| 样本音频 | `samples/chinese.wav`、`english.wav`、`reference.txt` | macOS `say` 命令合成 |
| 测试报告 | `docs/test-report.md` | 含用例表、手动验证结果、已知问题 |

---

## 五、手动验证项（题目 6.3）

| 序号 | 验证项 | 状态 |
|------|--------|------|
| 1 | 浏览器麦克风录制中文并识别 | ✅ 已验证 |
| 2 | 浏览器麦克风录制英文并识别 | ✅ 已验证 |
| 3 | 上传中文 WAV 文件并识别 | ✅ 已验证 |
| 4 | 上传英文 WAV 文件并识别 | ✅ 已验证 |
| 5 | 麦克风权限被拒绝时的系统表现 | ✅ 前端捕获并提示 |
| 6 | 模型准备完成后，在无外网情况下完成识别 | ✅ 模型在本地 models/ 目录 |

---

## 六、文档要求（题目 7.2）

| 文档 | 实现位置 | 内容 |
|------|----------|------|
| README.md | 项目根目录 | 系统介绍、环境要求、安装启动步骤、模型初始化、运行及测试方法 |
| requirements.md | `docs/requirements.md` | 需求理解、功能拆分、必要假设和边界条件 |
| design.md | `docs/design.md` | 系统架构、核心模块、音频处理流程、ASR 模型选型及理由 |
| test-report.md | `docs/test-report.md` | 测试用例、实际运行结果、真实模型测试及已知问题 |
| ai-development.md | `docs/ai-development.md` | OpenCode 使用过程、开发任务拆分、遇到的问题及处理过程 |

---

## 七、OpenCode 开发过程记录（题目 7.3）

| 阶段 | 实现位置 | 内容 |
|------|----------|------|
| 阶段一：需求理解与技术设计 | `docs/ai-development.md` | 如何使用 AI 理解需求、制定方案、选择 ASR 模型 |
| 阶段二：功能开发与集成 | `docs/ai-development.md` | 前端录音、后端 API、模型集成的开发过程 |
| 阶段三：测试与问题修复 | `docs/ai-development.md` | 实际测试、错误定位（av 编译失败、HuggingFace 连不上）及 AI 辅助解决 |

`ai-development.md` 中已说明：
- OpenCode 在开发中承担了哪些任务
- 哪些重要技术决策由自己做出
- 遇到过什么问题，如何借助 AI 解决
- 如何确认 AI 生成的代码满足业务需求
- 如果继续优化系统，会优先改进什么

---

## 八、功能范围限制（题目 8，明确不做的事）

| 不做的事 | 状态 |
|----------|------|
| 用户登录及权限管理 | ✅ 未实现 |
| 数据库存储 | ✅ 未实现 |
| 语音识别历史记录管理 | ✅ 未实现 |
| 说话人识别与声纹分析 | ✅ 未实现 |
| 音频降噪算法开发 | ✅ 未实现（使用浏览器硬件降噪） |
| 语音翻译 | ✅ 未实现 |
| 文字转语音（TTS） | ✅ 未实现 |
| 模型训练及 Fine-tuning | ✅ 未实现 |
| 复杂分布式部署或多用户并发 | ✅ 未实现 |
| 手机端适配 | ✅ 未实现（但做了响应式 CSS） |
| 商业级实时字幕性能 | ✅ 未实现 |

---

## 九、完成标准（题目 9）

| 序号 | 标准 | 状态 |
|------|------|------|
| 1 | 能够按照 README 在约定环境启动 | ✅ `./start.sh` 一键启动 |
| 2 | 浏览器可以访问麦克风、录制并停止录音 | ✅ |
| 3 | 能够将录制的音频提交后端处理 | ✅ |
| 4 | 使用真实本地 ASR 模型分别识别中文和英文 | ✅ faster-whisper small |
| 5 | 识别结果正确返回并展示在 Web 页面 | ✅ |
| 6 | 可以通过上传音频文件独立验证识别功能 | ✅ |
| 7 | 能够处理常见错误，而不是直接崩溃 | ✅ |
| 8 | 具有实际执行过的自动化测试及真实模型验证 | ✅ 16 passed + 实机验证 |
| 9 | 提交完整源码、运行文档、测试结果及 OpenCode 开发证据 | ✅ 全部在 GitHub |

---

## 十、项目结构（题目 7.1）

```
local-speech-to-text/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI 路由
│   ├── asr.py           # ASR 模型封装
│   └── audio.py         # 音频校验
├── static/
│   ├── index.html       # Web 页面
│   ├── style.css        # 苹果风格样式
│   └── app.js           # 录音/VAD/上传逻辑
├── tests/
│   ├── __init__.py
│   ├── conftest.py      # mock fixture
│   ├── test_health.py
│   ├── test_transcribe_api.py
│   ├── test_audio.py
│   └── test_real_model.py
├── samples/
│   ├── chinese.wav
│   ├── english.wav
│   └── reference.txt
├── docs/
│   ├── requirements.md
│   ├── design.md
│   ├── test-report.md
│   ├── ai-development.md
│   └── implementation-mapping.md  # 本文档
├── models/              # 模型目录（不入 git，首次运行自动下载）
├── start.sh / start.bat
├── download_model.sh / download_model.bat
├── requirements.txt
├── pytest.ini
├── README.md
└── .gitignore
```
