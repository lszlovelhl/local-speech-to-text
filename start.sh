#!/bin/bash
# 一键启动脚本：自动建 venv、装依赖、启动服务、开浏览器
set -e
cd "$(dirname "$0")"

# 首次运行自动创建 venv
if [ ! -d ".venv" ]; then
    echo "=== 首次运行，创建虚拟环境 ==="
    python3 -m venv .venv
fi

source .venv/bin/activate

echo "=== 检查依赖 ==="
pip install -r requirements.txt --quiet

echo "=== 启动服务 ==="
(sleep 2 && open "http://127.0.0.1:8000") &

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
