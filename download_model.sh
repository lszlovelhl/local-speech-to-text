#!/bin/bash
# 下载 ASR 模型（从 ModelScope，国内直连，无需科学上网）
# 默认下载 small 模型（准确率更高）
set -e
cd "$(dirname "$0")"

SIZE="${1:-small}"
MODEL_DIR="models/faster-whisper-${SIZE}"
BASE="https://modelscope.cn/api/v1/models/pengzhendong/faster-whisper-${SIZE}/repo?Revision=master&FilePath="

mkdir -p "$MODEL_DIR"

echo "=== 下载 Whisper ${SIZE} 模型到 $MODEL_DIR ==="
for f in config.json model.bin tokenizer.json vocabulary.txt preprocessor_config.json; do
  if [ -f "$MODEL_DIR/$f" ]; then
    echo "  已存在: $f"
  else
    echo "  下载: $f"
    curl -sL "${BASE}${f}" -o "$MODEL_DIR/$f"
  fi
done

echo "=== 模型下载完成 ==="
ls -lh "$MODEL_DIR/"
