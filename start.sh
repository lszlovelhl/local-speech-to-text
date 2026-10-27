#!/bin/bash
# 一键启动脚本：自动建 venv、装依赖、下载模型、启动服务、开浏览器
# 支持 macOS / Linux
set -e
cd "$(dirname "$0")"

# 选择合适的 Python 版本（优先 3.12，其次 3.13；3.14 太新 av 无预编译包）
PY=""
for candidate in python3.12 python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.13; do
    if command -v "$candidate" &>/dev/null; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    # 检查默认 python3 版本
    DEFAULT_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")
    MAJOR=$(echo "$DEFAULT_VER" | cut -d. -f1)
    MINOR=$(echo "$DEFAULT_VER" | cut -d. -f2)
    if [ "$MAJOR" = "3" ] && [ "$MINOR" -le "13" ]; then
        PY=python3
    else
        echo "=========================================="
        echo "  错误：需要 Python 3.12 或 3.13"
        echo "  当前系统 Python: $DEFAULT_VER"
        echo ""
        echo "  安装方法："
        echo "    macOS:  brew install python@3.12"
        echo "    Ubuntu: sudo apt install python3.12 python3.12-venv"
        echo "=========================================="
        exit 1
    fi
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
pip install --upgrade pip --quiet
pip install -r requirements.txt

# 如果本地没有模型文件，自动下载（默认 small，准确率更高）
if [ ! -f "models/faster-whisper-small/model.bin" ] && [ ! -f "models/faster-whisper-base/model.bin" ]; then
    echo "=== 首次运行，下载 ASR 模型 (small, 约 460MB) ==="
    bash download_model.sh small
fi

echo "=== 启动服务 ==="
echo ">>> 浏览器访问: http://127.0.0.1:8000"

# M1: 端口预检。若 8000 已被占用，直接提示并打开浏览器退出，避免 uvicorn EADDRINUSE 崩溃。
#     lsof -iTCP:8000 -sTCP:LISTEN -t 在 macOS 与 Linux 上均可用。
if lsof -iTCP:8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "服务已在运行 http://127.0.0.1:8000"
    (command -v open >/dev/null 2>&1 && open "http://127.0.0.1:8000" || command -v xdg-open &>/dev/null && xdg-open "http://127.0.0.1:8000") || true
    exit 0
fi

# L6: 后台延迟打开浏览器的子 shell 需要被追踪，退出时清理，避免 Ctrl+C 后残留 sleep/open 进程。
BROWSER_PID=""
cleanup_browser() {
    if [ -n "$BROWSER_PID" ]; then
        kill "$BROWSER_PID" >/dev/null 2>&1 || true
    fi
}
trap cleanup_browser EXIT INT TERM

(sleep 2 && (command -v open >/dev/null 2>&1 && open "http://127.0.0.1:8000" || command -v xdg-open &>/dev/null && xdg-open "http://127.0.0.1:8000")) &
BROWSER_PID=$!

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
