# Local Speech-to-Text

本地离线中英文语音识别 Web 系统（版本 **3.0.0**）：浏览器录音或上传音视频文件，后端调用本地 faster-whisper 模型完成识别，结果带时间戳分段返回页面展示。无需云端 ASR API、无需 GPU、不依赖 Docker / Node.js / 数据库。

## 一、技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 | Python 3.12 / 3.13 + FastAPI + Uvicorn | `app/main.py` 提供路由，`/api/transcribe` 在线程池中执行推理，不阻塞事件循环 |
| ASR | faster-whisper（CTranslate2 后端，CPU int8 量化） | 默认 small 模型（约 464MB），缺失时回退 base（约 141MB）；不依赖 PyTorch |
| 音频解码 | PyAV（av） | 统一解码浏览器录音 WebM/Opus 与上传音视频；视频自动提取音轨 |
| 后处理 | harness 层（pycorrector / symspellpy / OpenCC + 规则表） | 中英文纠错、繁简转换、术语保护、幻觉去重；可选依赖缺失时自动降级为纯规则纠错 |
| 前端 | 原生 HTML / CSS / JavaScript（无框架） | MediaRecorder + Web Audio API 音量检测（VAD）+ Canvas 波形 + IndexedDB 本地收藏 |
| 测试 | pytest + httpx TestClient | mock 模型用例秒级通过；真实模型用例单独打标记默认跳过 |

## 二、功能特性

| 功能 | 说明 |
|------|------|
| 单次识别 | 录完一段点停止，一次性提交识别；显示文本、语言、音频时长、处理耗时 |
| 会议模式（实时切片） | 持续录音，前端 VAD 按音量自适应阈值检测停嘴自动切片，识别文本实时追加 |
| 中英文自动检测 | language=auto 默认；也可手动指定 zh / en；支持中英混说 |
| 文件上传 | 音频：WAV / WebM / OGG / MP3 / M4A / FLAC，上限 **100MB**；视频：MP4 / MOV / MKV / AVI / WEBM / M4V，上限 **200MB**，由 PyAV 提取音轨后识别 |
| 时间戳分段 | 返回 `segments` 分段（每段含 start / end / text），页面按 `[mm:ss.mm - mm:ss.mm]` 展示 |
| 波形可视化 | Canvas 实时绘制录音波形与 VU 电平条 |
| 磁带收藏（本地历史） | 识别记录存入浏览器：元数据在 localStorage，录音音频 Blob 存 IndexedDB；最多保留 20 条、24 小时自动清除，点击磁带弹窗可回放音频与查看全文；分「单次灵感 / 会议记录」两栏 |
| 结果操作 | 一键复制、导出 TXT、清空结果；支持空格键快捷开始/停止录音 |
| 深浅模式 | 默认跟随系统 `prefers-color-scheme`；右上角按钮可手动切换浅色 / 深色并本地持久化；两种模式另有主题色调差异 |
| 离线运行 | 模型下载到 `models/` 后可完全断网识别；首次启动仅下载模型时需要网络 |
| 容错降级 | 麦克风权限拒绝、无设备、空文件、格式不支持、超大文件、模型加载失败均返回友好提示，不崩溃；纠错库导入失败不影响主识别流程 |

## 三、环境要求

- **Python 3.12 或 3.13**（3.14 暂不支持：av 库在 3.14 上无可用预编译包，`start.sh` 会探测并拒绝 3.14）
- 操作系统：macOS / Linux（`start.sh`）、Windows（`start.bat`）
- 浏览器：Chrome / Edge 最新稳定版；Safari 可访问，但部分 MediaRecorder 封装格式可能不同
- CPU 即可推理，无需 GPU、无需显存；普通笔记本 CPU int8 量化下可满足短语音识别
- 磁盘空间：small 模型约 464MB（base 回退约 141MB）；首次联网下载，之后离线可用
- 首次启动网络：默认从 ModelScope（国内直连）下载模型文件；脚本同时设置 `HF_ENDPOINT=https://hf-mirror.com` 作为 HuggingFace 备用镜像

## 四、快速启动

### 方式一：一键启动（推荐）

```bash
# macOS / Linux（自动建 venv、装依赖、检测模型、起服务、延迟打开浏览器）
./start.sh

# Windows
start.bat
```

启动成功后浏览器自动访问 <http://127.0.0.1:8000>；若 8000 端口已被占用，脚本会提示并直接打开已有页面，不会因 `EADDRINUSE` 崩溃。

### 方式二：手动启动

```bash
python3.12 -m venv .venv          # 或 python3.13 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate.bat
pip install -r requirements.txt
bash download_model.sh small      # 首次下载模型（已存在文件会自动跳过）
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

> 模型选择：默认 small；设置环境变量 `WHISPER_MODEL=base` 可优先加载 base 模型（速度更快、准确率略低）。本地查找顺序为「首选对应目录，其余目录依次回退」。

## 五、测试方法

`pytest.ini` 已配置 `addopts = -m "not real_model"`，默认跳过依赖真实权重的用例：

```bash
# 常规自动化测试（mock 模型，不下载权重，秒级完成）
.venv/bin/python -m pytest -m "not real_model" -q
# addopts 已内置相同过滤，下面这条等价：
.venv/bin/python -m pytest -q

# 真实模型测试（需先完成 download_model.sh，耗时较长）
.venv/bin/python -m pytest -m real_model -v
```

最近一次实跑：**22 passed, 3 deselected**（3 条 `real_model` 用例默认跳过；用例数随迭代增补，以 `pytest -q` 实际输出为准）。

## 六、目录结构与模块职责

```
local-speech-to-text/
├── app/
│   ├── main.py            # FastAPI 应用入口、路由、文件大小/格式分流、异常码映射
│   ├── asr.py             # 模型懒加载与线程锁、本地模型查找回退、transcribe_with_timing、segments 时间戳
│   ├── harness.py         # 后处理：繁简转换、中英文纠错、领域术语保护、幻觉重复清洗
│   ├── audio.py           # 上传文件校验（空文件/扩展名/大小）、临时文件保存与即用即删
│   └── config.py          # 唯一配置真相源：音频/视频大小上限与扩展名白名单
├── static/
│   ├── index.html         # 页面结构：语言/模式选择、录音机、上传、结果、分段、磁带收藏、回放弹窗
│   ├── style.css          # 苹果风拟真录音机样式、响应式、深浅模式、两种模式主题色
│   └── app.js             # 录音、VAD 切片、波形绘制、上传、API 调用、IndexedDB/localStorage 历史
├── tests/
│   ├── conftest.py        # mock ASR fixture 与 TestClient
│   ├── test_health.py     # /health 与首页
│   ├── test_transcribe_api.py
│   ├── test_audio.py       # 校验规则单测
│   └── test_real_model.py # @pytest.mark.real_model，默认跳过
├── samples/               # chinese.wav / english.wav / reference.txt 测试样本
├── docs/                   # 需求、设计、实现对照、测试报告、AI 开发记录
├── models/                 # 模型目录（不入 git；small 优先，base 回退）
├── start.sh / start.bat           # 一键启动
├── download_model.sh / download_model.bat  # 模型下载（支持 small/base 参数）
├── requirements.txt / requirements-dev.txt
├── pytest.ini
└── README.md
```

## 七、API 简要说明

### `GET /health`

健康检查，返回 `{"status": "ok"}`。

### `POST /api/transcribe`

- Content-Type：`multipart/form-data`
- 表单字段：
  - `file`（必填）：音频或视频文件；音频 ≤ 100MB，视频 ≤ 200MB
  - `language`（可选，默认 `auto`）：`zh` / `en` / `auto`
- 成功返回 200：

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

- 错误码：`400`（空文件 / 格式不支持 / 超过大小上限 / 无法解码或无音频流）、`422`（缺少 file 或 language 取值非法）、`503`（模型加载或推理失败）。
- 临时文件在请求结束后立即删除，不持久化保存用户音频。

## 八、常见问题（FAQ）

| 场景 | 原因与处理 |
|------|------------|
| 浏览器提示麦克风权限被拒绝 / 无声音 | 在浏览器地址栏站点设置中允许麦克风权限后刷新；确认系统（macOS 隐私设置 / Windows 麦克风权限）已授权；无录音设备时页面会给出设备缺失提示 |
| 首次启动模型没下载下来 / 目录为空 | 单独执行 `bash download_model.sh small`（Windows：`download_model.bat small`）；脚本会跳过已下载文件，可重复执行；确认能访问 `modelscope.cn`，也可设置 `HF_ENDPOINT` 备用镜像 |
| 8000 端口被占用 | 先关闭占用进程，或手动用 `python -m uvicorn app.main:app --host 127.0.0.1 --port 8001` 换端口启动（前端按同源相对路径请求，换端口不影响功能） |
| 上传文件提示格式不支持 | 音频白名单：wav/webm/ogg/mp3/m4a/flac；视频白名单：mp4/mov/mkv/avi/webm/m4v；其余格式（如 m4p、aac 裸流、字幕文件）请先转码 |
| 报错「文件超过限制」 | 音频最大 100MB、视频最大 200MB；超长录音建议在前端分段或先压缩码率 |
| 安装依赖后仍提示纠错相关警告 / 效果一般 | harness 层对 pycorrector、symspellpy、OpenCC 采用懒加载：任一可选依赖导入失败会自动降级为内置规则纠错，不阻断识别；如需完整纠错效果，确保 `requirements.txt` 中依赖全部安装成功 |
| 是否需要安装 torch | 不需要。本项目使用 CTranslate2 推理后端，`requirements.txt` 不含 PyTorch；若环境中误装 torch 也不会被主流程使用 |
| 识别结果有错别字 / 英文语法问题 | 先检查是否指定了正确语言（zh/en）；嘈杂环境或带口音时准确率会下降，属 small 模型能力边界；会议模式切片过短时可重新录制长句 |

## 九、已知限制与规避

1. **单机串行**：后端用识别锁串行处理请求，不支持多用户并发；并发请求会排队等待。
2. **本地模型能力边界**：small 模型在重度口音、强噪声、专业术语场景下准确率有限；base 回退模型速度优先、准确率更低；不支持说话人分离与声纹识别。
3. **历史仅存于当前浏览器**：磁带收藏使用 localStorage + IndexedDB，清除浏览器数据或换设备后丢失；最多 20 条、保留 24 小时，非服务端数据库存储。
4. **视频识别依赖本地解码库**：PyAV 对个别封装格式（如加密 DRM、特殊编码）可能无法提取音轨，此时返回 400 提示无法解码。
5. **Python 版本约束**：仅验证 3.12 / 3.13；3.14 因 av 预编译包缺失不支持，请勿强行安装。
6. **无登录、无服务端持久化、无翻译/TTS**：这些属于题目明确不做的范围；导出 TXT 是唯一的结果外存手段。
7. **会议模式为近实时而非流式 WebSocket**：按切片 HTTP 请求提交，存在切片级别的处理延迟，不适合长直播字幕场景。

## 十、设计与测试文档

- `docs/requirements.md`：需求拆分与边界假设
- `docs/design.md`：架构图、模块职责、VAD 参数、选型理由、接口定义
- `docs/implementation-mapping.md`：逐条需求 → 代码位置对照
- `docs/test-report.md`：用例覆盖表与手动验证记录
- `docs/ai-development.md`：AI 辅助开发过程与关键决策
