#!/bin/bash
# 一键启动脚本：安装依赖 + 启动服务 + 自动打开浏览器
set -e
cd "$(dirname "$0")"

echo "=== 检查依赖 ==="
python3 -m pip install -r requirements.txt --quiet

echo "=== 启动服务 ==="
# 后台启动后自动打开浏览器
(sleep 2 && open "http://127.0.0.1:8000") &

python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
