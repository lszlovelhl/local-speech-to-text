@echo off
REM 一键启动脚本 (Windows)
REM 用法: start.bat [small|base]  模型规格可选，默认 small
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo ==========================================
    echo   错误：未找到 python，请先安装 Python 3.12 或 3.13
    echo   安装后重新打开终端再运行本脚本
    echo ==========================================
    exit /b 1
)

REM 虚拟环境不存在或损坏（缺解释器）时重建
if not exist ".venv\Scripts\python.exe" (
    echo === 首次运行，创建虚拟环境 ===
    python -m venv .venv
    if errorlevel 1 (
        echo 错误：虚拟环境创建失败，请确认 Python 版本为 3.12/3.13
        exit /b 1
    )
)

call .venv\Scripts\activate.bat

set HF_ENDPOINT=https://hf-mirror.com

REM 依赖就绪探测：关键包全部可导入则跳过 pip 安装，避免每次启动重复联网（与 start.sh 口径一致）
python -c "import importlib.util,sys; mods=['fastapi','uvicorn','multipart','av','faster_whisper','pycorrector','symspellpy','opencc']; sys.exit(0 if all(importlib.util.find_spec(m) for m in mods) else 1)"
if errorlevel 1 (
    echo === 安装依赖 ===
    pip install -r requirements.txt --quiet
    if errorlevel 1 (
        echo ==========================================
        echo   错误：依赖安装失败，请检查网络后重试
        echo   可手动执行: pip install -r requirements.txt
        echo ==========================================
        exit /b 1
    )
) else (
    echo === 依赖已就绪，跳过安装（如需强制更新: pip install -r requirements.txt） ===
)

REM 本地 small / base 任一存在即跳过下载，与 start.sh 判断口径一致
if not exist "models\faster-whisper-small\model.bin" if not exist "models\faster-whisper-base\model.bin" (
    echo === 首次运行，下载 ASR 模型 (small, 约 460MB) ===
    call download_model.bat small
)

echo === 启动服务 ===
echo ^>^>^> 浏览器访问: http://127.0.0.1:8000

REM 延迟 2 秒再打开浏览器，避免服务尚未就绪时打开空白/报错页
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8000"

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
