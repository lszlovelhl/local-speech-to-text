/**
 * Local Speech-to-Text v2.1
 * - VAD 自适应切片（浏览器降噪 + 自适应阈值 + 最短/最长保护）
 * - 会议模式：持续录音，VAD 检测停嘴自动切片
 * - 单按钮切换：开始/停止 一体化，防止连点
 */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const btnRecord = $("btnRecord");
const btnRecordText = $("btnRecordText");
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
let isRecording = false;
let isProcessing = false;

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
let currentChunkChunks = [];
let chunkStartTime = 0;

// VAD 参数
const VAD_MIN_SPEECH_MS = 300;
const VAD_MIN_SILENCE_MS = 500;
const VAD_MAX_CHUNK_MS = 8000;
const VAD_NOISE_MEASURE_MS = 500;
const VAD_SENSITIVITY = 2.5;

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

function setRecordButton(state) {
    btnRecord.className = `record-btn ${state}`;
    if (state === "idle") {
        btnRecordText.textContent = "开始录音";
    } else if (state === "recording") {
        btnRecordText.textContent = "停止录音";
    } else if (state === "processing") {
        btnRecordText.textContent = "识别中…";
    }
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
            noiseFloor = Math.max(noiseFloor, 5);
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
        silenceStartTs = now;
    } else {
        if (speechStartTs && now - speechStartTs < VAD_MIN_SPEECH_MS) {
            speechStartTs = 0;
        }
        if (!silenceStartTs) silenceStartTs = now;
    }

    const longEnoughSilence = now - silenceStartTs > VAD_MIN_SILENCE_MS;
    const hasSpoken = speechStartTs !== 0;
    const chunkDuration = now - chunkStartTime;
    const maxChunkReached = chunkDuration > VAD_MAX_CHUNK_MS;

    if ((hasSpoken && longEnoughSilence) || maxChunkReached) {
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
    vadRafId = null;
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    analyser = null;
}

// ---------- 录音控制（单按钮） ----------
btnRecord.addEventListener("click", async () => {
    if (isProcessing) return;  // 识别中不响应
    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
});

async function startRecording() {
    try {
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
                const blob = new Blob(currentChunkChunks, { type: mediaRecorder.mimeType });
                submitAudio(blob, "final.webm", true);
            }
            cleanupRecording();
        };

        mediaRecorder.start(250);
        recordStartTs = Date.now();
        isRecording = true;
        setRecordButton("recording");
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference"
            ? "会议模式：正在监听，自动检测停嘴…"
            : "正在录音，点击按钮停止";

        timerInt = setInterval(() => {
            timerText.textContent = fmtTime((Date.now() - recordStartTs) / 1000);
        }, 200);

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
        setRecordButton("idle");
    }
}

function stopRecording() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
}

function cleanupRecording() {
    clearInterval(timerInt);
    stopVAD();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    isRecording = false;
    setRecordButton("idle");
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
        isProcessing = true;
        setRecordButton("processing");
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
            isProcessing = false;
            setRecordButton("idle");
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
