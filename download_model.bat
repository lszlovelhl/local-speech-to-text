@echo off
REM 下载 ASR 模型（从 ModelScope，国内直连）
REM 用法: download_model.bat [small|base]，默认 small
setlocal
cd /d "%~dp0"

set SIZE=%1
if "%SIZE%"=="" set SIZE=small
if /i not "%SIZE%"=="small" if /i not "%SIZE%"=="base" (
    echo 错误：模型规格仅支持 small 或 base，收到: %SIZE%
    echo 用法: download_model.bat [small^|base]
    exit /b 1
)

where curl >nul 2>nul
if errorlevel 1 (
    echo 错误：未找到 curl，请先安装 curl 后重试
    exit /b 1
)

set MODEL_DIR=models\faster-whisper-%SIZE%
set BASE=https://modelscope.cn/api/v1/models/pengzhendong/faster-whisper-%SIZE%/repo?Revision=master^&FilePath=

if not exist "%MODEL_DIR%" mkdir "%MODEL_DIR%"

echo === 下载 Whisper %SIZE% 模型到 %MODEL_DIR% ===
for %%f in (config.json model.bin tokenizer.json vocabulary.txt preprocessor_config.json) do (
    if exist "%MODEL_DIR%\%%f" (
        echo   已存在: %%f
    ) else (
        echo   下载: %%f
        curl -fL --retry 2 --connect-timeout 15 "%BASE%%%f" -o "%MODEL_DIR%\%%f"
        if errorlevel 1 (
            echo 错误：下载 %%f 失败，请检查网络后重试（可重复执行本脚本，已下载文件会跳过）
            exit /b 1
        )
    )
)

echo === 模型下载完成 ===
dir "%MODEL_DIR%"
endlocal
