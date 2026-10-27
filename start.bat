@echo off
REM 一键启动脚本 (Windows)
cd /d "%~dp0"

echo === 检查依赖 ===
python -m pip install -r requirements.txt --quiet

echo === 启动服务 ===
start "" "http://127.0.0.1:8000"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
