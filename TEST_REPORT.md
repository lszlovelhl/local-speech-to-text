# Local Speech-to-Text — 完整测试报告

- **测试时间**：2026-10-27 22:52 (Asia/Shanghai)
- **测试主机**：macOS（BSD 用户态）
- **服务进程**：PID 2983，`/Library/Frameworks/Python.framework/Versions/3.13/.../Python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- **服务地址**：http://127.0.0.1:8000
- **测试原则**：只读、只跑测试命令，未修改任何源码；未重启/杀掉运行中的服务；`start.sh` 仅做 `bash -n` 语法检查与静态逻辑审查，未实际试跑。

---

## 1. 启动健康检查

```bash
$ curl -i http://127.0.0.1:8000/health
HTTP/1.1 200 OK
date: Tue, 27 Oct 2026 14:52:35 GMT
server: uvicorn
content-length: 15
content-type: application/json

{"status":"ok"}
```

**结果**：✅ 200，返回 `{"status":"ok"}`。路径正确，无需探测备用路径。

---

## 2. 前端页面与静态资源

| 路径 | HTTP | 大小 | Content-Type |
|---|---|---|---|
| `/` | 200 | 10883 B | text/html; charset=utf-8 |
| `/static/style.css` | 200 | 24123 B | text/css; charset=utf-8 |
| `/static/app.js` | 200 | 24548 B | text/javascript; charset=utf-8 |
| `/static/nonexistent.js` | 404 | — | — |

`index.html` 中引用的资源（`grep -oE '(src|href)="[^"]*"'`）：

```
href="/static/style.css"
src="/static/app.js"
```

两个引用路径均真实存在于 `static/` 目录，无 404。✅

---

## 3. API 接口测试

后端字段名从 `app/main.py:56` 确认：`file: UploadFile = File(...)`，即 multipart 字段名为 **`file`**。

### 3.1 样本文件

```
samples/chinese.wav   196004 B
samples/english.wav   175988 B
samples/reference.txt  235 B
```

参考文本：
- 中文：`你好，欢迎使用本地语音识别系统。这是一段中文测试音频。`
- 英文：`Hello, welcome to the local speech to text system. This is a test audio in English.`

### 3.2 中文转写

```bash
$ curl -X POST http://127.0.0.1:8000/api/transcribe \
    -F "file=@samples/chinese.wav" -F "language=zh"
```

```json
{"text":"你好,欢迎使用本地语音识别系统,这是一段中文测试音频。",
 "language":"zh","duration_seconds":6.0,"processing_seconds":2.35,
 "segments":[{"start":0.0,"end":6.0,
              "text":"你好,欢迎使用本地语音识别系统,这是一段中文测试音频。"}]}
```

**结果**：✅ 与参考文本语义完全一致（仅逗号为半角 `,` vs 全角 `，`，标点风格差异，不影响识别正确性）。端到端耗时 2.44s。

### 3.3 英文转写

```bash
$ curl -X POST http://127.0.0.1:8000/api/transcribe \
    -F "file=@samples/english.wav" -F "language=en"
```

```json
{"text":"Hello, welcome to the local speech-to-text system, this is a test audio in English.",
 "language":"en","duration_seconds":5.37,"processing_seconds":1.03,
 "segments":[{"start":0.0,"end":5.2,
              "text":"Hello, welcome to the local speech-to-text system, this is a test audio in English."}]}
```

**结果**：✅ 与参考文本几乎逐字一致（"speech-to-text" vs 参考 "speech to text"，连字符差异）。端到端 1.07s。

### 3.4 auto 语言检测

```bash
$ curl -X POST ... -F "file=@samples/english.wav" -F "language=auto"
```

返回 `language:"en"`，✅ 正确自动检测为英文。

### 3.5 边界情况

| # | 场景 | 命令要点 | HTTP | 返回 |
|---|---|---|---|---|
| 1 | 完全不带文件 | `-F "language=zh"` | 422 | `{"detail":[{"type":"missing","loc":["body","file"],...}]}` |
| 2 | 不支持的扩展名 `.txt` | `echo hello > /tmp/fake.txt` | 400 | `不支持的文件格式 '.txt'，支持：.flac, .m4a, .mp3, .ogg, .wav, .webm` |
| 3 | 空 wav（0 字节） | `: > /tmp/empty.wav` | 400 | `上传文件为空` |
| 4 | 非法语言 `fr` | `-F "language=fr"` | 422 | `不支持的语言 'fr'，仅支持 zh / en / auto` |
| 5 | 伪造 wav（文本内容伪装 .wav） | `echo "not audio" > /tmp/fake.wav` | 400 | `文件无法解码，格式可能损坏：[Errno ...] Invalid data ... '/var/folders/.../tmpXXX.wav'` |
| 6 | 字段名错误（`audio` 而非 `file`） | `-F "audio=@..."` | 422 | `Field required, loc:["body","file"]` |

**结果**：✅ 所有边界情况均被捕获并返回合理 HTTP 状态码。
**问题**：⚠️ 场景 5 的错误信息泄露了服务器临时文件绝对路径（见问题 #4）。

---

## 4. 代码静态检查

### 4.1 实测：事件循环阻塞

```
基线 /health 延迟：0.0014s / 0.0009s / 0.0010s
转写进行中并发探测 /health：
  during-transcribe health 1: 1.0258s   ← 被排队
  during-transcribe health 2: 0.0008s
  during-transcribe health 3: 0.0010s
```

转写期间首个 /health 排队 1.02s（≈ 单次转写时长），证实同步 ASR 阻塞事件循环。

### 4.2 完整问题清单（见第 7 节）

---

## 5. requirements.txt 核对

```
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
python-multipart>=0.0.9
av>=12.0.0
faster-whisper>=1.0.0
pytest>=8.0.0
httpx>=0.27.0
```

后端实际 import（含懒加载）：
- `fastapi`（main.py）✅
- `uvicorn`（启动入口）✅
- `python-multipart`（FastAPI `Form`/`File` 必需）✅
- `av`（main.py `_probe_media`、asr.py 兼容补丁）✅
- `faster_whisper`（asr.py 懒加载）✅
- `pytest` / `httpx`（仅 tests/ 使用）⚠️ 见问题 #6

**结论**：无缺失依赖；版本下界合理；`pytest`、`httpx` 属测试依赖混入运行时清单。

---

## 6. start.sh 审查

```bash
$ bash -n start.sh && echo OK
start.sh syntax OK
```

静态逻辑要点：
- `set -e`：任一步失败即退出 ✅
- Python 版本选择：优先 3.12/3.13，拒绝 3.14+（av 无预编译包）✅ 合理
- 首次运行自动 `python -m venv .venv` + `source .venv/bin/activate` ✅
- 自动导出 `HF_ENDPOINT=https://hf-mirror.com` ✅
- 模型检测：`models/faster-whisper-small/model.bin` 或 `base/model.bin` 任一存在即跳过下载 ✅
- 启动命令：`python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- 后台开浏览器：`(sleep 2 && open http://127.0.0.1:8000) &`

**未实跑**（8000 已被 PID 2983 占用，实跑会因端口冲突失败；按硬约束未试跑、未恢复）。

问题见第 7 节 #3、#12。

---

## 7. 问题清单（按严重程度排序）

### 🔴 严重

**S1. 同步 ASR 调用阻塞 uvicorn 事件循环**
- 位置：`app/main.py:89`
  ```python
  result = asr.transcribe_with_timing(temp_path, language)
  ```
- 现象：`transcribe` 是 `async def`，但内部直接调用 CPU-bound 的同步函数 `asr.transcribe_with_timing()`（faster-whisper 推理，实测 1–3s）。
- 影响：转写期间整个事件循环被阻塞，所有并发请求（包括 `/health`、其他用户的上传）排队等待。实测基线 /health 1ms → 转写期间 1.02s。
- 复现：后台 `curl -X POST /api/transcribe -F file=@samples/chinese.wav`，同时 `curl /health`。
- 建议：改用 `from fastapi.concurrency import run_in_threadpool`：
  ```python
  result = await run_in_threadpool(asr.transcribe_with_timing, temp_path, language)
  ```
  配合现有 `_transcribe_lock` 即可在线程池中串行化推理、不阻塞事件循环。

**S2. 文件整体读入内存后才校验大小**
- 位置：`app/main.py:65,73-74`
  ```python
  content = await file.read()          # ← 整个请求体先读进内存
  ...
  if len(content) > 200 * 1024 * 1024: raise ...
  ```
- 现象：无论文件多大，`await file.read()` 都会把全部 body 读入内存，然后才判断是否超限。
- 影响：恶意客户端上传 1GB 文件会在内存中占用 1GB 后才被拒绝；并发几个即可 OOM。音频分支同理（100MB 限制在 `audio.py:34` 也是读完后才检查）。
- 复现：`curl -F "file=@/dev/zero" --max-time 5 ...`（大文件）观察内存占用。
- 建议：流式读取并在超过上限时立即截断报错；或在 uvicorn/反向代理层配置 body size 上限；或先 `UploadFile.size`（Starlette 提供）做预检。

---

### 🟡 中等

**M1. start.sh 无端口冲突预检**
- 位置：`start.sh` 末尾 `python -m uvicorn ... --port 8000`
- 现象：8000 被占用时 uvicorn 直接报 `[Errno 48] Address already in use` 退出，脚本无预检、无提示、无自动选端口。
- 复现：在已运行服务的情况下执行 `./start.sh`。
- 建议：启动前 `lsof -iTCP:8000 -sTCP:LISTEN` 检测，占用时提示"服务已在运行，是否直接打开浏览器"或询问换端口。

**M2. 错误信息泄露服务器临时文件绝对路径**
- 位置：`app/main.py:51`
  ```python
  raise AudioValidationError(f"文件无法解码，格式可能损坏：{e}") from e
  ```
- 现象：PyAV 异常字符串包含 `/var/folders/q1/.../tmpXXX.wav`，被原样拼进 HTTP 响应 `detail`。
- 实测复现：上传伪造 wav，返回 `"文件无法解码，格式可能损坏：[Errno ...] Invalid data ... '/var/folders/q1/n4xcgh_x69x7_swzr4kjg8z40000gn/T/tmpu5pw_yzp.wav'"`
- 影响：泄露服务器用户名（短路径推断）、临时目录结构，对本地工具风险低，但不规范。
- 建议：对外只返回 `"文件无法解码或无音频流"`，详细异常写日志而非响应。

**M3. `WHISPER_MODEL` 环境变量对本地模型选择无效，误导测试**
- 位置：`app/asr.py:31-36,64-69`
  ```python
  MODEL_DIRS = [small_dir, base_dir]   # 固定优先级
  MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
  ...
  local = _find_local_model()          # 永远优先 small
  ```
- 现象：`MODEL_SIZE` 仅在"无本地模型、走 HuggingFace 下载"分支使用；本地加载路径固定 small > base。
- 影响：`tests/conftest.py:13` 设置 `os.environ["WHISPER_MODEL"] = "base"`，但本地有 small 模型时实际加载的仍是 small，该环境变量形同虚设，读代码者会被误导。
- 建议：`_find_local_model()` 按 `MODEL_SIZE` 选择对应目录；或删除 conftest 里这行误导性设置。

**M4. requirements.txt 混入测试依赖**
- 位置：`requirements.txt` 末两行
- 现象：`pytest`、`httpx` 仅被 `tests/` 使用，运行时 `app/` 不依赖。
- 影响：生产部署/容器镜像会安装无用包；版本约束耦合测试与运行时。
- 建议：拆分为 `requirements.txt`（运行时）+ `requirements-dev.txt`（含 pytest/httpx）。

---

### 🟢 轻微

**L1. app.js 死引用 DOM id**
- 位置：`static/app.js:29,31`
  ```js
  const micVisual = $("micVisual");
  const historyList = $("historyList");
  ```
- 现象：`index.html` 中不存在 `micVisual`、`historyList` 元素，`$()` 返回 `null`。
- 影响：当前未被使用，无运行时错误；属于重构残留。
- 建议：删除两行死代码。

**L2. 测试 docstring 与实际常量不符**
- 位置：`tests/test_audio.py:18`
  ```python
  """超过 10MB 应报错。"""
  ```
- 现象：实际 `MAX_FILE_SIZE = 100MB`（audio.py:13）。
- 建议：改为"超过 100MB 应报错"。

**L3. `waveCtx.roundRect` 浏览器兼容性**
- 位置：`static/app.js:412`
  ```js
  waveCtx.beginPath();
  waveCtx.roundRect(x + 1, y, barWidth - 2, barHeight, 2);
  ```
- 现象：`CanvasRenderingContext2D.roundRect` 在 Safari < 16.0 不支持。
- 影响：旧 Safari 上录音波形绘制抛 TypeError，录音功能本身不受影响但可视化崩溃。
- 建议：加 polyfill 或改用 `arcTo`/手动圆角。

**L4. 无 CORS 中间件**
- 位置：`app/main.py`（未配置 `CORSMiddleware`）
- 现象：前端与 API 同源部署时无问题；若未来前后端分离或从 file:// 打开页面，`fetch('/api/transcribe')` 会被浏览器跨域拦截。
- 建议：当前本地工具可不动；若要支持跨域，加 `app.add_middleware(CORSMiddleware, allow_origins=["*"])`（注意仅本地用途）。

**L5. 音频/视频大小限制硬编码两处且不一致**
- 位置：`app/audio.py:13`（音频 100MB）、`app/main.py:73`（视频 200MB）
- 现象：两个常量分散在两处，且数值不同。
- 影响：维护时容易漏改；错误信息模板在 audio.py 里硬编码 `100MB`。
- 建议：集中到 `app/config.py` 或顶部常量。

**L6. start.sh 后台浏览器子进程无清理**
- 位置：`start.sh` 末尾
  ```bash
  (sleep 2 && open "http://127.0.0.1:8000") &
  ```
- 现象：uvicorn 前台运行，该 subshell 挂在后台；Ctrl+C 退出 uvicorn 时 subshell 若已 sleep 完则已无害，但若用户在 2s 内 Ctrl+C，subshell 仍会执行 `open`。
- 影响：极小；日志全部打到 stdout，无 `--daemon`/日志文件选项。
- 建议：可加 `trap 'kill 0' EXIT` 清理子进程；或提供 `--log` 选项。

---

## 8. 通过项清单 ✅

1. `/health` 返回 200 `{"status":"ok"}`。
2. 首页 `/` 200，HTML 内容完整（10883 B）。
3. `index.html` 引用的 `/static/style.css`、`/static/app.js` 均 200 且非空；不存在路径拼接错误。
4. 中文样本转写结果与参考文本语义完全一致（仅标点风格差异）。
5. 英文样本转写结果与参考文本几乎逐字一致。
6. `language=auto` 正确检测出英文。
7. 边界情况全部优雅返回合理状态码：缺文件 422、不支持格式 400、空文件 400、非法语言 422、伪造 wav 400、字段名错误 422。
8. pytest 套件：`16 passed, 3 deselected in 3.08s`（3 个 real_model 按 marker 默认跳过）。
9. `start.sh` 语法检查通过（`bash -n`）。
10. 模型从本地 `models/faster-whisper-small` 加载成功，未触发网络下载。
11. 临时上传文件在 `finally: cleanup_temp(temp_path)` 中可靠清理。
12. 录音锁 `_transcribe_lock` 防止模型并发崩溃的设计已落实（虽因事件循环阻塞问题未完全发挥作用，见 S1）。
13. 前端字段名 `file`（app.js:626 `fd.append("file", ...)`）与后端 `File(...)` 一致，无字段名错配。
14. 扩展名大小写不敏感（audio.py:40 `.lower()`）。
15. 对 PyAV 不兼容 `metadata_errors` 参数做了兼容补丁（asr.py:21-26），实测可正常解码 wav。

---

## 9. 总体结论

**功能层面：完全可用。** 健康检查、首页、静态资源、中英文转写、auto 检测、边界错误处理全部符合预期；pytest 全绿；真实模型端到端识别准确率高。

**工程层面：有两个需要尽快修的严重问题：**
1. **S1 事件循环阻塞** — 一行 `await run_in_threadpool(...)` 即可解决，直接影响并发体验。
2. **S2 内存读取无上限截断** — 本地单用户风险低，但属于明显的健壮性缺陷。

其余问题为中低危，不影响当前本地单人使用，但建议在发布/给他人用之前清理 M1–M4、L1–L6。

**测试未覆盖（受硬约束限制）：**
- 未实际试跑 `start.sh`（8000 已被占用，按约束未重启服务）。
- 未测试视频文件上传（samples/ 下无视频样本）。
- 未测试麦克风录音端到端（需浏览器交互）。
- 未测试 `tests/test_real_model.py` 中的 3 个 real_model 用例（已通过真实 HTTP 转写间接验证等价路径）。
