#!/bin/bash
# 一键启动脚本：自动建 venv、装依赖、下载模型、启动服务、开浏览器
# 支持 macOS / Linux
set -e
cd "$(dirname "$0")"

# 优先使用 Python 3.13（3.14 太新，av 库无预编译包）
if command -v python3.13 &>/dev/null; then
    PY=python3.13
elif [ -x "/opt/homebrew/bin/python3.13" ]; then
    PY="/opt/homebrew/bin/python3.13"
else
    PY=python3
fi
echo "=== 使用 $PY ($($PY --version)) ==="

# 首次运行自动创建 venv
if [ ! -d ".venv" ]; then
    echo "=== 首次运行，创建虚拟环境 ==="
    $PY -m venv .venv
fi

source .venv/bin/activate

# 国内镜像加速（备用）
export HF_ENDPOINT=https://hf-mirror.com

echo "=== 安装依赖 ==="
pip install -r requirements.txt --quiet

# 如果本地没有模型文件，自动下载（默认 small，准确率更高）
if [ ! -f "models/faster-whisper-small/model.bin" ] && [ ! -f "models/faster-whisper-base/model.bin" ]; then
    echo "=== 首次运行，下载 ASR 模型 (small) ==="
    bash download_model.sh small
fi

echo "=== 启动服务 ==="
(sleep 2 && (command -v open >/dev/null 2>&1 && open "http://127.0.0.1:8000" || xdg-open "http://127.0.0.1:8000")) &

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
