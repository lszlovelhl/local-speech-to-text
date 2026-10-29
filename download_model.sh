#!/bin/bash
# 下载 ASR 模型（从 ModelScope，国内直连，无需科学上网）
# 用法: bash download_model.sh [small|base]，默认 small（准确率更高）
set -e
cd "$(dirname "$0")"

SIZE="${1:-small}"
case "$SIZE" in
    small|base) ;;
    *)
        echo "错误：模型规格仅支持 small 或 base，收到: $SIZE"
        echo "用法: bash download_model.sh [small|base]"
        exit 1
        ;;
esac

if ! command -v curl >/dev/null 2>&1; then
    echo "错误：未找到 curl，请先安装 curl 后重试"
    exit 1
fi

MODEL_DIR="models/faster-whisper-${SIZE}"
BASE="https://modelscope.cn/api/v1/models/pengzhendong/faster-whisper-${SIZE}/repo?Revision=master&FilePath="

mkdir -p "$MODEL_DIR"

echo "=== 下载 Whisper ${SIZE} 模型到 $MODEL_DIR ==="
for f in config.json model.bin tokenizer.json vocabulary.txt preprocessor_config.json; do
  target="$MODEL_DIR/$f"
  if [ -s "$target" ]; then
    echo "  已存在: $f"
  else
    echo "  下载: $f"
    if ! curl -fL --retry 2 --connect-timeout 15 "${BASE}${f}" -o "$target"; then
      echo "错误：下载 $f 失败，请检查网络后重试（可重复执行本脚本，已下载文件会跳过）"
      rm -f "$target"
      exit 1
    fi
    if [ ! -s "$target" ]; then
      echo "错误：$f 下载结果为空文件，请删除后重试"
      exit 1
    fi
  fi
done

echo "=== 模型下载完成 ==="
ls -lh "$MODEL_DIR/"
