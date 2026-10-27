/**
 * Local Speech-to-Text v2.2
 * - VAD 自适应切片
 * - 会议模式实时出字
 * - 单按钮防连点
 * - 拖拽上传
 * - 空格快捷键
 * - 导出 TXT
 * - 时间戳分段显示
 * - 视频音轨提取识别
 */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const btnRecord = $("btnRecord");
const btnRecordText = $("btnRecordText");
const btnUpload = $("btnUpload");
const btnCopy = $("btnCopy");
const btnExport = $("btnExport");
const btnClear = $("btnClear");
const fileInput = $("fileInput");
const dropZone = $("dropZone");
const statusBadge = $("statusBadge");
const timerText = $("timerText");
const hintText = $("hintText");
const resultText = $("resultText");
const segmentList = $("segmentList");
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
let lastResultText = "";

// VAD
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

const VAD_MIN_SPEECH_MS = 300;
const VAD_MIN_SILENCE_MS = 500;
const VAD_MAX_CHUNK_MS = 8000;
const VAD_NOISE_MEASURE_MS = 500;
const VAD_SENSITIVITY = 2.5;

// ---------- Segmented Control with draggable thumb ----------
function getThumbPos(container, btn) {
    const btnRect = btn.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
        x: btnRect.left - containerRect.left - 2,
        w: btnRect.width,
    };
}

function moveThumb(container, btn) {
    const thumb = container.querySelector(".seg-thumb");
    if (!thumb) return;
    const pos = getThumbPos(container, btn);
    thumb.style.width = pos.w + "px";
    thumb.style.transform = `translateX(${pos.x}px)`;
}

function setupSegmented(containerId, onChange) {
    const container = $(containerId);
    const thumb = container.querySelector(".seg-thumb");
    const btns = Array.from(container.querySelectorAll(".seg"));
    const active = container.querySelector(".seg.active");
    if (active) moveThumb(container, active);

    // Click to jump
    btns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
            if (btn.classList.contains("active")) return;
            btns.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            moveThumb(container, btn);
            onChange(btn);
        });
    });

    // Draggable thumb
    let dragging = false;
    let moved = false;
    let startX = 0;
    let thumbStartX = 0;

    container.addEventListener("pointerdown", (e) => {
        const btn = e.target.closest(".seg");
        if (!btn) return;
        dragging = true;
        moved = false;
        startX = e.clientX;
        const activeBtn = container.querySelector(".seg.active");
        if (activeBtn) {
            const pos = getThumbPos(container, activeBtn);
            thumbStartX = pos.x;
        }
    });

    window.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 3) moved = true; // threshold to distinguish click vs drag
        if (!moved) return;
        thumb.style.transition = "none";
        thumb.classList.add("dragging");
        const containerRect = container.getBoundingClientRect();
        const maxX = containerRect.width - thumb.offsetWidth - 2;
        let newX = Math.max(2, Math.min(maxX, thumbStartX + dx));
        thumb.style.transform = `translateX(${newX}px)`;

        // Find which button the thumb center is over
        const thumbCenter = newX + thumb.offsetWidth / 2;
        for (const btn of btns) {
            const btnRect = btn.getBoundingClientRect();
            const btnCenter = btnRect.left - containerRect.left + btnRect.width / 2;
            if (Math.abs(thumbCenter - btnCenter) < btnRect.width / 2) {
                if (!btn.classList.contains("active")) {
                    btns.forEach((b) => b.classList.remove("active"));
                    btn.classList.add("active");
                    onChange(btn);
                }
                break;
            }
        }
    });

    window.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            thumb.classList.remove("dragging");
            thumb.style.transition = "";
            const activeBtn = container.querySelector(".seg.active");
            if (activeBtn) moveThumb(container, activeBtn);
        }
    });
}

setupSegmented("langGroup", (btn) => {
    currentLang = btn.dataset.lang;
    metaLang.textContent = currentLang;
});

setupSegmented("modeGroup", (btn) => {
    currentMode = btn.dataset.mode;
    hintText.textContent = currentMode === "conference"
        ? "会议模式：持续录音，自动检测停嘴切片"
        : "单次识别：录完一段后识别";
});

// Reposition thumbs on window resize
window.addEventListener("resize", () => {
    ["langGroup", "modeGroup"].forEach((id) => {
        const c = $(id);
        const active = c.querySelector(".seg.active");
        if (active) moveThumb(c, active);
    });
});

// ---------- Utils ----------
function setStatus(state, text) {
    statusBadge.className = `badge ${state}`;
    statusBadge.textContent = text;
    micVisual.className = "mic-visual" + (state === "recording" ? " recording" : state === "processing" ? " processing" : "");
    $("waveform").classList.toggle("active", state === "recording");
}

function setRecordButton(state) {
    btnRecord.className = `record-btn ${state}`;
    btnRecordText.textContent = state === "idle" ? "开始录音" : state === "recording" ? "停止录音" : "识别中…";
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

function fmtTimestamp(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, "0");
    return `${m}:${s}`;
}

// ---------- VAD ----------
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
    for (let i = 0; i < vadData.length; i++) sum += vadData[i] * vadData[i];
    const rms = Math.sqrt(sum / vadData.length);
    const now = Date.now();

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

    const threshold = noiseFloor * VAD_SENSITIVITY;
    const isSpeech = rms > threshold;
    if (isSpeech) {
        if (!speechStartTs) speechStartTs = now;
        silenceStartTs = now;
    } else {
        if (speechStartTs && now - speechStartTs < VAD_MIN_SPEECH_MS) speechStartTs = 0;
        if (!silenceStartTs) silenceStartTs = now;
    }

    const longEnoughSilence = now - silenceStartTs > VAD_MIN_SILENCE_MS;
    const hasSpoken = speechStartTs !== 0;
    const maxChunkReached = now - chunkStartTime > VAD_MAX_CHUNK_MS;

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
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    analyser = null;
}

// ---------- 录音控制 ----------
btnRecord.addEventListener("click", () => {
    if (isProcessing) return;
    isRecording ? stopRecording() : startRecording();
});

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });
        mediaRecorder = new MediaRecorder(mediaStream);
        chunks = [];
        currentChunkChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) { chunks.push(e.data); currentChunkChunks.push(e.data); }
        };
        mediaRecorder.onstop = () => {
            if (currentMode === "single") {
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
                submitAudio(blob, `recording.${mediaRecorder.mimeType.includes("ogg") ? "ogg" : "webm"}`);
            } else if (currentChunkChunks.length > 0) {
                submitAudio(new Blob(currentChunkChunks, { type: mediaRecorder.mimeType }), "final.webm", true);
            }
            cleanupRecording();
        };

        mediaRecorder.start(250);
        recordStartTs = Date.now();
        isRecording = true;
        setRecordButton("recording");
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference" ? "会议模式：正在监听…" : "正在录音，点击按钮或空格停止";

        timerInt = setInterval(() => { timerText.textContent = fmtTime((Date.now() - recordStartTs) / 1000); }, 200);
        if (currentMode === "conference") { initVAD(mediaStream); vadLoop(); }
    } catch (err) {
        const msgs = { NotAllowedError: "请在浏览器设置中允许麦克风权限", NotFoundError: "未检测到麦克风设备" };
        setStatus("error", err.name === "NotAllowedError" ? "权限被拒绝" : "启动失败");
        hintText.textContent = msgs[err.name] || err.message;
        setRecordButton("idle");
    }
}

function stopRecording() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function cleanupRecording() {
    clearInterval(timerInt);
    stopVAD();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    isRecording = false;
    setRecordButton("idle");
}

// ---------- 空格快捷键 ----------
document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && !isProcessing) {
        e.preventDefault();
        isRecording ? stopRecording() : startRecording();
    }
});

// ---------- 拖拽上传 ----------
["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
});
["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); });
});
dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
});

// ---------- 文件上传 ----------
btnUpload.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (f) handleFile(f);
});

function handleFile(f) {
    fileName.textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    submitAudio(f, f.name);
}

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
                resultText.textContent += (resultText.textContent.endsWith("…") ? "" : " ") + data.text + " ";
                lastResultText = resultText.textContent;
            }
        } else {
            resultText.classList.remove("placeholder", "fade-in");
            void resultText.offsetWidth; // 重触发动画
            resultText.classList.add("fade-in");
            resultText.textContent = data.text || "（未识别到语音）";
            lastResultText = data.text || "";
            metaLang.textContent = data.language;
            metaDuration.textContent = data.duration_seconds;
            metaProcessing.textContent = data.processing_seconds;
            btnCopy.disabled = false;
            btnExport.disabled = false;

            // 渲染时间戳分段
            if (data.segments && data.segments.length > 1) {
                segmentList.classList.remove("hidden");
                segmentList.innerHTML = data.segments.map((s) =>
                    `<div class="segment-item"><span class="segment-time">[${fmtTimestamp(s.start)} - ${fmtTimestamp(s.end)}]</span><span class="segment-text">${s.text}</span></div>`
                ).join("");
            } else {
                segmentList.classList.add("hidden");
            }

            setStatus("done", "完成");
            hintText.textContent = "可以再次录音、上传文件，或按空格键继续";
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

// ---------- Copy / Export / Clear ----------
btnCopy.addEventListener("click", () => {
    if (resultText.classList.contains("placeholder")) return;
    navigator.clipboard.writeText(resultText.textContent).then(() => showToast("已复制"));
});

btnExport.addEventListener("click", () => {
    if (!lastResultText) return;
    const blob = new Blob([lastResultText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 TXT");
});

btnClear.addEventListener("click", () => {
    resultText.textContent = "识别文字将显示在这里…";
    resultText.classList.add("placeholder");
    segmentList.classList.add("hidden");
    segmentList.innerHTML = "";
    btnCopy.disabled = true;
    btnExport.disabled = true;
    lastResultText = "";
});
