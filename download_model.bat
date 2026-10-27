@echo off
REM 下载 ASR 模型（从 ModelScope，国内直连）
cd /d "%~dp0"

set MODEL_DIR=models\faster-whisper-base
set BASE=https://modelscope.cn/api/v1/models/pengzhendong/faster-whisper-base/repo?Revision=master&FilePath=

if not exist %MODEL_DIR% mkdir %MODEL_DIR%

echo === 下载 Whisper base 模型 ===
for %%f in (config.json model.bin tokenizer.json vocabulary.txt preprocessor_config.json) do (
    if exist %MODEL_DIR%\%%f (
        echo   已存在: %%f
    ) else (
        echo   下载: %%f
        curl -sL "%BASE%%%f" -o "%MODEL_DIR%\%%f"
    )
)

echo === 模型下载完成 ===
dir %MODEL_DIR%
