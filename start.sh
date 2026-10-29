#!/bin/bash
# 一键启动脚本：自动建 venv、装依赖、下载模型、启动服务、开浏览器
# 支持 macOS / Linux
set -e
cd "$(dirname "$0")"

# 选择合适的 Python 版本（优先 3.12，其次 3.13；3.14 太新 av 无预编译包）
PY=""
for candidate in python3.12 python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.13; do
    if command -v "$candidate" >/dev/null 2>&1; then
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

echo "=== 使用 $PY ($("$PY" --version)) ==="

# 首次运行自动创建 venv；若 venv 已损坏（缺解释器）则重建
if [ ! -d ".venv" ] || [ ! -x ".venv/bin/python" ]; then
    if [ -d ".venv" ]; then
        echo "=== 检测到损坏的虚拟环境，重建 .venv ==="
        rm -rf .venv
    else
        echo "=== 首次运行，创建虚拟环境 ==="
    fi
    "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

# 国内镜像加速（备用）
export HF_ENDPOINT=https://hf-mirror.com

echo "=== 安装依赖 ==="
if ! pip install --upgrade pip --quiet; then
    echo "警告：pip 升级失败，继续尝试安装项目依赖"
fi
if ! pip install -r requirements.txt; then
    echo "=========================================="
    echo "  错误：依赖安装失败，请检查网络后重试"
    echo "  可手动执行: pip install -r requirements.txt"
    echo "=========================================="
    exit 1
fi

# 如果本地没有模型文件，自动下载（默认 small，准确率更高；base 为回退）
if [ ! -f "models/faster-whisper-small/model.bin" ] && [ ! -f "models/faster-whisper-base/model.bin" ]; then
    echo "=== 首次运行，下载 ASR 模型 (small, 约 460MB) ==="
    if ! bash download_model.sh small; then
        echo "=========================================="
        echo "  警告：模型自动下载失败"
        echo "  可稍后手动执行: bash download_model.sh small"
        echo "  服务仍会启动，但首次识别时可能触发在线下载"
        echo "=========================================="
    fi
else
    echo "=== 检测到本地模型，跳过下载 ==="
fi

echo "=== 启动服务 ==="
echo ">>> 浏览器访问: http://127.0.0.1:8000"

# 端口预检。若 8000 已被占用，直接提示并打开浏览器退出，避免 uvicorn EADDRINUSE 崩溃。
# 优先 lsof（macOS/Linux 常见）；缺失时用 Python 探测，保证脚本可移植。
port_in_use() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:8000 -sTCP:LISTEN -t >/dev/null 2>&1
    else
        python -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',8000))==0 else 1)" >/dev/null 2>&1
    fi
}

open_browser() {
    local url="http://127.0.0.1:8000"
    if command -v open >/dev/null 2>&1; then
        open "$url"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url"
    fi
}

if port_in_use; then
    echo "服务已在运行 http://127.0.0.1:8000"
    open_browser || true
    exit 0
fi

# 后台延迟打开浏览器的子 shell 需要被追踪，退出时清理，避免 Ctrl+C 后残留 sleep/open 进程。
BROWSER_PID=""
cleanup_browser() {
    if [ -n "$BROWSER_PID" ]; then
        kill "$BROWSER_PID" >/dev/null 2>&1 || true
    fi
}
trap cleanup_browser EXIT INT TERM

(sleep 2 && open_browser) &
BROWSER_PID=$!

python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
