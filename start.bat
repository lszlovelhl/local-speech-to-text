@echo off
REM 一键启动脚本 (Windows)
cd /d "%~dp0"

if not exist .venv (
    echo === 首次运行，创建虚拟环境 ===
    python -m venv .venv
)

call .venv\Scripts\activate.bat

REM 国内镜像加速模型下载
set HF_ENDPOINT=https://hf-mirror.com

echo === 安装依赖 ===
pip install -r requirements.txt --quiet

echo === 启动服务 ===
start "" "http://127.0.0.1:8000"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
