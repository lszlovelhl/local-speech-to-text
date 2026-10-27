/**
 * Local Speech-to-Text v2.1
 * - VAD 自适应切片（浏览器降噪 + 自适应阈值 + 最短/最长保护）
 * - 移动端响应式适配
 * - 会议模式：持续录音，VAD 检测停嘴自动切片
 */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnUpload = $("btnUpload");
const btnCopy = $("btnCopy");
const btnClear = $("btnClear");
const fileInput = $("fileInput");
const statusBadge = $("statusBadge");
const timerText = $("timerText");
const hintText = $("hintText");
const resultText = $("resultText");
const metaLang = $("metaLang");
const metaDuration = $("metaDuration");
const metaProcessing = $("metaProcessing");
const fileName = $("fileName");
const micVisual = $("micVisual");
const toast = $("toast");

// ---------- State ----------
let currentLang = "auto";
let currentMode = "single";
let mediaRecorder = null;
let mediaStream = null;
let recordStartTs = 0;
let timerInt = null;
let chunks = [];

// VAD 相关
let audioCtx = null;
let analyser = null;
let vadData = null;
let vadRafId = null;
let noiseFloor = 0;
let noiseFloorSamples = [];
let isMeasuringNoise = true;
let silenceStartTs = 0;
let speechStartTs = 0;
let currentChunkChunks = [];   // 当前累积的切片
let chunkStartTime = 0;
let vadTimer = null;

// VAD 参数
const VAD_MIN_SPEECH_MS = 300;    // 最短说话时长
const VAD_MIN_SILENCE_MS = 1500;   // 最短静音判定
const VAD_MAX_CHUNK_MS = 8000;     // 最大切片时长
const VAD_NOISE_MEASURE_MS = 500;  // 噪音采样时长
const VAD_SENSITIVITY = 2.5;       // 阈值倍率（相对噪音底噪）

// ---------- Language / Mode ----------
$("langGroup").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    $("langGroup").querySelectorAll(".seg").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    currentLang = btn.dataset.lang;
    metaLang.textContent = currentLang;
});

$("modeGroup").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    $("modeGroup").querySelectorAll(".seg").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
    hintText.textContent = currentMode === "conference"
        ? "会议模式：持续录音，自动检测停嘴切片"
        : "单次识别：录完一段后识别";
});

// ---------- Utils ----------
function setStatus(state, text) {
    statusBadge.className = `badge ${state}`;
    statusBadge.textContent = text;
    micVisual.className = "mic-visual" + (state === "recording" ? " recording" : state === "processing" ? " processing" : "");
}

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
}

// ---------- VAD 核心 ----------
function initVAD(stream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    vadData = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    noiseFloorSamples = [];
    isMeasuringNoise = true;
    noiseFloor = 0;
    chunkStartTime = Date.now();
    currentChunkChunks = [];
}

function vadLoop() {
    if (!analyser) return;
    analyser.getByteFrequencyData(vadData);

    // 计算当前音量（RMS 近似）
    let sum = 0;
    for (let i = 0; i < vadData.length; i++) {
        sum += vadData[i] * vadData[i];
    }
    const rms = Math.sqrt(sum / vadData.length);
    const now = Date.now();

    // 阶段1：测量噪音底噪
    if (isMeasuringNoise) {
        noiseFloorSamples.push(rms);
        if (now - chunkStartTime > VAD_NOISE_MEASURE_MS) {
            noiseFloor = noiseFloorSamples.reduce((a, b) => a + b, 0) / noiseFloorSamples.length;
            noiseFloor = Math.max(noiseFloor, 5); // 防止底噪为0
            isMeasuringNoise = false;
            silenceStartTs = now;
        }
        vadRafId = requestAnimationFrame(vadLoop);
        return;
    }

    // 阶段2：说话/静音判定
    const threshold = noiseFloor * VAD_SENSITIVITY;
    const isSpeech = rms > threshold;

    if (isSpeech) {
        if (!speechStartTs) speechStartTs = now;
        silenceStartTs = now; // 重置静音计时
    } else {
        if (speechStartTs && now - speechStartTs < VAD_MIN_SPEECH_MS) {
            // 太短，不算说话
            speechStartTs = 0;
        }
        if (!silenceStartTs) silenceStartTs = now;
    }

    // 判断是否该切片：说话过 + 静音够久
    const longEnoughSilence = now - silenceStartTs > VAD_MIN_SILENCE_MS;
    const hasSpoken = speechStartTs !== 0;
    const chunkDuration = now - chunkStartTime;
    const maxChunkReached = chunkDuration > VAD_MAX_CHUNK_MS;

    if ((hasSpoken && longEnoughSilence) || maxChunkReached) {
        // 触发切片
        if (currentChunkChunks.length > 0) {
            const blob = new Blob(currentChunkChunks, { type: mediaRecorder.mimeType });
            submitAudio(blob, "chunk.webm", true);
        }
        currentChunkChunks = [];
        chunkStartTime = now;
        speechStartTs = 0;
        silenceStartTs = now;
    }

    vadRafId = requestAnimationFrame(vadLoop);
}

function stopVAD() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    if (vadTimer) clearInterval(vadTimer);
    vadRafId = null;
    vadTimer = null;
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    analyser = null;
}

// ---------- Recording ----------
btnStart.addEventListener("click", async () => {
    try {
        // 第一层：浏览器硬件级降噪
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true,
            }
        });

        mediaRecorder = new MediaRecorder(mediaStream);
        chunks = [];
        currentChunkChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data);
                currentChunkChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            if (currentMode === "single") {
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
                const ext = mediaRecorder.mimeType.includes("ogg") ? "ogg" : "webm";
                submitAudio(blob, `recording.${ext}`);
            } else if (currentChunkChunks.length > 0) {
                // 会议模式：最后剩余的片子
                const blob = new Blob(currentChunkChunks, { type: mediaRecorder.mimeType });
                submitAudio(blob, "final.webm", true);
            }
            cleanupRecording();
        };

        mediaRecorder.start(250); // 每250ms触发一次 ondataavailable，给VAD足够数据
        recordStartTs = Date.now();
        btnStart.hidden = true;
        btnStop.hidden = false;
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference"
            ? "会议模式：正在监听，自动检测停嘴…"
            : "正在录音，点击停止结束";

        timerInt = setInterval(() => {
            timerText.textContent = fmtTime((Date.now() - recordStartTs) / 1000);
        }, 200);

        // 会议模式启动 VAD
        if (currentMode === "conference") {
            initVAD(mediaStream);
            vadLoop();
        }
    } catch (err) {
        if (err.name === "NotAllowedError") {
            setStatus("error", "权限被拒绝");
            hintText.textContent = "请在浏览器设置中允许麦克风权限";
        } else if (err.name === "NotFoundError") {
            setStatus("error", "无麦克风");
            hintText.textContent = "未检测到麦克风设备";
        } else {
            setStatus("error", "启动失败");
            hintText.textContent = err.message;
        }
    }
});

btnStop.addEventListener("click", () => {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
});

function cleanupRecording() {
    clearInterval(timerInt);
    stopVAD();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    btnStart.hidden = false;
    btnStop.hidden = true;
}

// ---------- Upload ----------
btnUpload.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileName.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    submitAudio(f, f.name);
});

// ---------- API ----------
async function submitAudio(blob, filename, isChunk = false) {
    if (!isChunk) {
        btnStart.disabled = true;
        btnUpload.disabled = true;
        if (currentMode === "single") setStatus("processing", "识别中");
    }

    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("language", currentLang);

    try {
        const resp = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        if (isChunk) {
            if (data.text) {
                resultText.classList.remove("placeholder");
                const sep = resultText.textContent.endsWith("…") ? "" : " ";
                resultText.textContent += sep + data.text + " ";
            }
        } else {
            resultText.classList.remove("placeholder");
            resultText.textContent = data.text || "（未识别到语音）";
            metaLang.textContent = data.language;
            metaDuration.textContent = data.duration_seconds;
            metaProcessing.textContent = data.processing_seconds;
            btnCopy.disabled = false;
            setStatus("done", "完成");
            hintText.textContent = "可以再次录音或上传文件";
        }
    } catch (err) {
        if (!isChunk) {
            setStatus("error", "识别失败");
            hintText.textContent = err.message;
            showToast("识别失败");
        }
    } finally {
        if (!isChunk) {
            btnStart.disabled = false;
            btnUpload.disabled = false;
        }
    }
}

// ---------- Copy / Clear ----------
btnCopy.addEventListener("click", () => {
    if (resultText.classList.contains("placeholder")) return;
    navigator.clipboard.writeText(resultText.textContent).then(() => showToast("已复制"));
});

btnClear.addEventListener("click", () => {
    resultText.textContent = "识别文字将显示在这里…";
    resultText.classList.add("placeholder");
    btnCopy.disabled = true;
});
