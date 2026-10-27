# AI 辅助开发记录

## 开发工具

本项目使用了 AI 辅助编程工具完成开发：

- **OpenCode**（终端 AI 编程 Agent，v1.19.4）：用于需求拆解、技术方案讨论、代码生成辅助
- **豆包/Doubao**：用于架构设计、代码审查、问题排查、文档撰写

## 阶段一：需求理解与技术设计

### 过程

1. 阅读题目全部要求，梳理必做功能（F1-F5）与加分项（F6）
2. 讨论 ASR 模型选型：对比 faster-whisper / openai-whisper / whisper.cpp / Vosk
3. 确定技术栈：FastAPI + 原生 HTML/CSS/JS + faster-whisper base
4. 设计项目目录结构，对齐题目要求的统一启动命令和接口格式

### AI 承担的任务

- 快速对比多个 ASR 方案的优劣和依赖体积
- 生成项目骨架代码和接口定义
- 协助分析题目中的隐含约束（CPU-only、不依赖 Docker/Node/数据库）

### 自己做出的关键决策

- **选择 faster-whisper 而非原版 Whisper**：CTranslate2 在 CPU 上快 4 倍，pip 安装无需编译
- **选择 base 模型而非 small**：普通笔记本 CPU 上速度优先，base 已足够演示
- **采用懒加载模型**：避免 pytest 启动时触发模型下载
- **mock 与真实测试分离**：`pytest -q` 秒级完成，真实模型测试单独运行
- **默认 auto 语言检测**：让 Whisper 自动检测中英文混说，不需要用户手动切换

## 阶段二：功能开发与集成

### 过程

1. 搭建 FastAPI 骨架：/health、/、/api/transcribe 三个端点
2. 实现音频校验模块：文件大小、格式白名单、空文件检测
3. 集成 faster-whisper：封装 transcribe_with_timing，含耗时统计
4. 编写前端页面：录音按钮、计时器、状态显示、文件上传、结果展示
5. 实现 VAD 自适应切片：浏览器硬件降噪 + 自适应音量阈值 + 最短/最长保护
6. 实现会议模式：持续录音，VAD 检测停嘴切片，文字实时追加
7. 苹果风格 UI redesign：SF Pro 字体、毛玻璃卡片、iOS 分段选择器、移动端响应式

### AI 承担的任务

- 生成前端 MediaRecorder API + Web Audio AnalyserNode 完整交互逻辑
- 生成 pytest 测试用例骨架（mock ASR）
- 生成异常处理的边界情况列表
- 协助设计 VAD 三层防护策略

### 自己做出的关键决策

- **VAD 三层防护**：浏览器降噪（第一层）+ 自适应阈值（第二层）+ 后端 vad_filter（第三层）
- **阈值倍率 2.5×**：经过权衡，2.5 倍底噪在普通环境下误触率最低
- **8 秒最大切片**：安全网，防止一直说话不切
- **临时文件即用即删**：不持久化存储音频，保护隐私
- **移动端响应式**：按钮最小 44px 点击区域，<480px 布局自适应

## 阶段三：测试与问题修复

### 过程

1. 编写 pytest 测试，默认 mock ASR 避免模型下载
2. 配置 pytest.ini：`-m "not real_model"` 默认跳过真实模型测试
3. 生成样本音频：macOS `say` 命令合成中英文语音
4. 验证接口返回格式与题目要求一致

### 遇到的问题及解决

| 问题 | 解决方式 |
|------|----------|
| pytest 启动时会触发 faster-whisper 导入 | monkeypatch 在 fixture 中 mock 掉 ASR 函数 |
| 样本音频生成 | macOS 内置 `say` + `afconvert` 生成 WAV |
| 浏览器录音格式是 WebM 而非 WAV | faster-whisper 底层 PyAV 原生支持 WebM/Opus |
| VAD 在嘈杂环境误触发 | 加浏览器硬件降噪 + 自适应阈值 + 最短说话时长过滤 |

## 关于 AI 生成代码的质量确认

- 每个接口都对照题目要求的返回格式验证
- 异常路径（空文件、坏格式、非法参数）逐一编写测试
- 前端错误处理区分了权限拒绝和设备缺失两种场景
- 统一启动命令验证：`pip install -r requirements.txt` + `uvicorn app.main:app`
- 16 个自动化测试全部通过

## 如果继续优化，优先改进

1. **说话人区分**：集成 pyannote.audio 做会议说话人分离（需 GPU）
2. **视频提取音频**：上传视频文件，后端用 ffmpeg 提取音轨再识别
3. **模型可配置**：通过环境变量切换 tiny/base/small/medium，适配不同硬件
4. **并发队列**：识别请求队列，避免多用户阻塞
