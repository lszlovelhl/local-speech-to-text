/**
 * Local Speech-to-Text v3.1
 * - 真实音频波形 Canvas 可视化
 * - 模式主题（单次=蓝色灵感 / 会议=橙色头脑风暴）
 * - Emoji 背景随模式切换滑入滑出
 * - 历史记录（单次/会议分列，24h自动清除）
 * - VAD 自适应切片 / 会议模式实时出字
 */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

// ---------- roundRect 兼容兜底（Safari < 16.0 等旧浏览器）----------
// 仅在原生 roundRect 不存在时补一个视觉等价实现；现代浏览器绝不覆盖原生方法。
if (typeof CanvasRenderingContext2D !== "undefined" &&
    typeof CanvasRenderingContext2D.prototype.roundRect !== "function") {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        // 规范化圆角半径，与原生行为一致：单值或数组均可，且不超过 w/2、h/2
        let radii;
        if (r === undefined || r === null) {
            radii = [0, 0, 0, 0];
        } else if (typeof r === "number") {
            radii = [r, r, r, r];
        } else if (Array.isArray(r)) {
            // 原生支持 1~4 元素数组，按顺时针四角展开
            const len = r.length;
            if (len === 1) radii = [r[0], r[0], r[0], r[0]];
            else if (len === 2) radii = [r[0], r[1], r[0], r[1]];
            else if (len === 3) radii = [r[0], r[1], r[2], r[1]];
            else radii = [r[0], r[1], r[2], r[3]];
        } else {
            radii = [r, r, r, r];
        }
        let [tl, tr, br, bl] = radii;
        tl = Math.min(tl, w / 2, h / 2);
        tr = Math.min(tr, w / 2, h / 2);
        br = Math.min(br, w / 2, h / 2);
        bl = Math.min(bl, w / 2, h / 2);

        this.moveTo(x + tl, y);
        this.lineTo(x + w - tr, y);
        this.arcTo(x + w, y, x + w, y + tr, tr);
        this.lineTo(x + w, y + h - br);
        this.arcTo(x + w, y + h, x + w - br, y + h, br);
        this.lineTo(x + bl, y + h);
        this.arcTo(x, y + h, x, y + h - bl, bl);
        this.lineTo(x, y + tl);
        this.arcTo(x, y, x + tl, y, tl);
        this.closePath();
        return this;
    };
}

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
const toast = $("toast");
const waveCanvas = $("waveCanvas");
const waveCtx = waveCanvas.getContext("2d");
const recorderLabel = $("recorderLabel");
const recLight = $("recLight");
const playLight = $("playLight");
const reelLeft = $("reelLeft");
const reelRight = $("reelRight");
const vuBar = $("vuBar");
const tapeTime = $("tapeTime");

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

// VAD + Waveform
let audioCtx = null;
let analyser = null;
let vadData = null;
let waveRafId = null;
let vadRafId = null;
let noiseFloor = 0;
let noiseFloorSamples = [];
let isMeasuringNoise = true;
let silenceStartTs = 0;
let speechStartTs = 0;
let currentChunkChunks = [];
let chunkStartTime = 0;
let chunkQueue = [];
let chunkProcessing = false;

// History
let history = [];
const HISTORY_KEY = "stt_history";
let db = null;

// IndexedDB setup
function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("stt_db", 1);
        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains("audio")) {
                d.createObjectStore("audio", { keyPath: "id" });
            }
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e);
    });
}

async function saveAudio(id, blob) {
    if (!db) return;
    return new Promise((resolve) => {
        const tx = db.transaction("audio", "readwrite");
        tx.objectStore("audio").put({ id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

async function getAudio(id) {
    if (!db) return null;
    return new Promise((resolve) => {
        const tx = db.transaction("audio", "readonly");
        const req = tx.objectStore("audio").get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => resolve(null);
    });
}

const VAD_MIN_SPEECH_MS = 300;
const VAD_MIN_SILENCE_MS = 600;
const VAD_MAX_CHUNK_MS = 10000;
const VAD_NOISE_MEASURE_MS = 500;
const VAD_SENSITIVITY = 2.5;

// ---------- History ----------
function loadHistory() {
    try {
        history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        history = history.filter((h) => h.ts > cutoff);
        saveHistory();
    } catch { history = []; }
    renderHistory();
}

function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function addHistory(mode, text, duration, segments, audioBlob = null) {
    if (!text || !text.trim()) return;
    const id = Date.now().toString();
    history.unshift({
        id,
        ts: Date.now(),
        mode,
        text: text.trim(),
        duration,
        segments: segments || [],
    });
    if (history.length > 20) history = history.slice(0, 20);
    saveHistory();
    renderHistory();
    // Save audio blob to IndexedDB
    if (audioBlob) saveAudio(id, audioBlob);
}

function renderHistory() {
    const singleShelf = $("tapeSingle");
    const confShelf = $("tapeConf");
    if (!singleShelf || !confShelf) return;

    const singles = history.filter((h) => h.mode !== "conference");
    const confs = history.filter((h) => h.mode === "conference");

    singleShelf.innerHTML = singles.map((h, i) => {
        const d = new Date(h.ts);
        const label = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
        return `<div class="tape" data-idx="${history.indexOf(h)}" title="${escapeHtml(h.text)}">
            <div class="tape-label">${escapeHtml(label)}</div>
            <div class="tape-duration">${fmtTime(h.duration||0)}</div>
        </div>`;
    }).join("");

    confShelf.innerHTML = confs.map((h) => {
        const d = new Date(h.ts);
        const label = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
        return `<div class="tape" data-idx="${history.indexOf(h)}" title="${escapeHtml(h.text)}">
            <div class="tape-label">${escapeHtml(label)}</div>
            <div class="tape-duration">${fmtTime(h.duration||0)}</div>
        </div>`;
    }).join("");

    // Click tape to open modal
    document.querySelectorAll(".tape").forEach((t) => {
        t.addEventListener("click", () => {
            const idx = parseInt(t.dataset.idx);
            const h = history[idx];
            if (!h) return;
            openTapeModal(h);
        });
    });
}

async function openTapeModal(h) {
    const modal = $("tapeModal");
    modal.classList.remove("closing");
    const d = new Date(h.ts);
    $("modalTitle").textContent = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
    $("modalTime").textContent = fmtTime(h.duration || 0);
    $("modalText").textContent = h.text;
    // Load audio from IndexedDB
    const audio = $("modalAudio");
    audio.style.display = "none";
    audio.removeAttribute("src");
    if (h.id) {
        const blob = await getAudio(h.id);
        if (blob) {
            audio.src = URL.createObjectURL(blob);
            audio.style.display = "block";
        }
    }
    modal.classList.add("open");
}

function closeTapeModal() {
    const modal = $("tapeModal");
    modal.classList.add("closing");
    setTimeout(() => {
        modal.classList.remove("open", "closing");
    }, 200);
}

$("modalClose").addEventListener("click", closeTapeModal);
$("tapeModal").querySelector(".tape-modal-backdrop").addEventListener("click", closeTapeModal);

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Mode Theme ----------
function applyModeTheme(mode) {
    if (mode === "conference") {
        document.body.classList.add("mode-conference");
        recorderLabel.textContent = "🧠 头脑风暴";
    } else {
        document.body.classList.remove("mode-conference");
        recorderLabel.textContent = "💡 灵感迸发";
    }
}

// ---------- Segmented Control ----------
function getThumbPos(container, btn) {
    const btnRect = btn.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return { x: btnRect.left - containerRect.left - 2, w: btnRect.width };
}

function moveThumb(container, btn) {
    const thumb = container.querySelector(".seg-thumb");
    if (!thumb) return;
    const pos = getThumbPos(container, btn);
    thumb.style.width = pos.w + "px";
    thumb.style.transform = `translateX(${pos.x}px)`;
}

function equalizeButtons(container) {
    const btns = container.querySelectorAll(".seg");
    let maxW = 0;
    btns.forEach((b) => {
        b.style.width = "";
        maxW = Math.max(maxW, b.offsetWidth);
    });
    btns.forEach((b) => (b.style.width = maxW + "px"));
}

function setupSegmented(containerId, onChange) {
    const container = $(containerId);
    const btns = Array.from(container.querySelectorAll(".seg"));
    equalizeButtons(container);
    const active = container.querySelector(".seg.active");
    if (active) moveThumb(container, active);

    btns.forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            btns.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            moveThumb(container, btn);
            onChange(btn);
        });
    });

    let dragging = false, moved = false, startX = 0, thumbStartX = 0;

    container.addEventListener("pointerdown", (e) => {
        const btn = e.target.closest(".seg");
        if (!btn) return;
        dragging = true; moved = false;
        startX = e.clientX;
        const activeBtn = container.querySelector(".seg.active");
        if (activeBtn) thumbStartX = getThumbPos(container, activeBtn).x;
    });

    window.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        if (!moved) return;
        const thumb = container.querySelector(".seg-thumb");
        thumb.style.transition = "none";
        thumb.classList.add("dragging");
        const containerRect = container.getBoundingClientRect();
        const maxX = containerRect.width - thumb.offsetWidth - 2;
        let newX = Math.max(2, Math.min(maxX, thumbStartX + dx));
        thumb.style.transform = `translateX(${newX}px)`;

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

    window.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            const thumb = container.querySelector(".seg-thumb");
            thumb.classList.remove("dragging");
            thumb.style.transition = "";
            const activeBtn = container.querySelector(".seg.active");
            if (activeBtn) moveThumb(container, activeBtn);
        }
    });

    // Click-to-select support
    btns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
            if (!btn.classList.contains("active")) {
                btns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                moveThumb(container, btn);
                onChange(btn);
            }
        });
    });
}

setupSegmented("langGroup", (btn) => {
    currentLang = btn.dataset.lang;
    metaLang.textContent = currentLang;
});

setupSegmented("modeGroup", (btn) => {
    currentMode = btn.dataset.mode;
    applyModeTheme(currentMode);
    hintText.textContent = currentMode === "conference"
        ? "会议模式：持续录音，自动检测停嘴切片"
        : "单次识别：录完一段后识别";
    timerText.textContent = "00:00";
    // Clear result on mode switch
    resultText.textContent = "";
    resultText.classList.add("placeholder");
    segmentList.classList.add("hidden");
    lastResultText = "";
});

window.addEventListener("resize", () => {
    ["langGroup", "modeGroup"].forEach((id) => {
        const c = $(id);
        equalizeButtons(c);
        const active = c.querySelector(".seg.active");
        if (active) moveThumb(c, active);
    });
});

// ---------- Utils ----------
function setStatus(state, text) {
    statusBadge.className = `badge ${state}`;
    statusBadge.textContent = text;
    recLight.classList.toggle("on", state === "recording" || state === "processing");
    playLight.classList.toggle("on", state === "done");
    const spinning = state === "recording" || state === "processing";
    reelLeft.classList.toggle("spinning", spinning);
    reelRight.classList.toggle("spinning", spinning);
}

function setRecordButton(state) {
    btnRecord.className = `walkman-btn ${state}`;
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

// ---------- Waveform Canvas ----------
function getWaveColor() {
    return currentMode === "conference" ? "#ff9500" : "#0071e3";
}

function drawWave() {
    if (!analyser) return;
    analyser.getByteFrequencyData(vadData);
    const w = waveCanvas.width;
    const h = waveCanvas.height;
    waveCtx.clearRect(0, 0, w, h);

    const bars = 40;
    const barWidth = w / bars;
    const color = getWaveColor();

    for (let i = 0; i < bars; i++) {
        const idx = Math.floor((i / bars) * vadData.length);
        const v = vadData[idx] / 255;
        const barHeight = Math.max(2, v * h * 0.9);
        const x = i * barWidth;
        const y = (h - barHeight) / 2;
        waveCtx.fillStyle = color;
        waveCtx.globalAlpha = 0.3 + v * 0.7;
        waveCtx.beginPath();
        waveCtx.roundRect(x + 1, y, barWidth - 2, barHeight, 2);
        waveCtx.fill();
    }
    waveCtx.globalAlpha = 1;

    // VU meter
    const avg = vadData.reduce((a, b) => a + b, 0) / vadData.length / 255;
    vuBar.style.width = `${Math.min(100, avg * 200)}%`;
    tapeTime.textContent = timerText.textContent;

    waveRafId = requestAnimationFrame(drawWave);
}

function stopWave() {
    if (waveRafId) cancelAnimationFrame(waveRafId);
    waveRafId = null;
    if (waveCtx) waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
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
    speechStartTs = 0;
    silenceStartTs = 0;
    drawWave(); // start waveform
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
            chunkQueue.push(blob);
            processChunkQueue();
        }
        currentChunkChunks = [];
        chunkStartTime = now;
        speechStartTs = 0;
        silenceStartTs = now;
    }
    vadRafId = requestAnimationFrame(vadLoop);
}

async function processChunkQueue() {
    if (chunkProcessing) return;
    chunkProcessing = true;
    while (chunkQueue.length > 0) {
        const blob = chunkQueue.shift();
        try {
            await submitAudio(blob, "chunk.webm", true);
        } catch (e) {
            console.warn("chunk failed:", e);
        }
    }
    chunkProcessing = false;
}

function stopVAD() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    vadRafId = null;
    stopWave();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
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
        mediaRecorder.onstop = async () => {
            const duration = (Date.now() - recordStartTs) / 1000;
            if (currentMode === "single") {
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
                submitAudio(blob, `recording.${mediaRecorder.mimeType.includes("ogg") ? "ogg" : "webm"}`, false, duration, blob);
            } else {
                // Submit final chunk and wait for result
                if (currentChunkChunks.length > 0) {
                    try {
                        const fd = new FormData();
                        fd.append("file", new Blob(currentChunkChunks, { type: mediaRecorder.mimeType }), "final.webm");
                        fd.append("language", currentLang);
                        const resp = await fetch("/api/transcribe", { method: "POST", body: fd });
                        const data = await resp.json();
                        if (data.text) {
                            resultText.classList.remove("placeholder");
                            resultText.textContent += " " + data.text + " ";
                            lastResultText = resultText.textContent;
                        }
                    } catch (e) { console.warn("final chunk failed:", e); }
                }
                if (lastResultText && !resultText.classList.contains("placeholder")) {
                    addHistory("conference", lastResultText, duration, []);
                }
            }
            cleanupRecording();
        };

        mediaRecorder.start(250);
        recordStartTs = Date.now();
        isRecording = true;
        setRecordButton("recording");
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference" ? "会议模式：正在监听…" : "正在录音，点击按钮或空格停止";

        // Clear previous result
        resultText.textContent = "";
        resultText.classList.add("placeholder");
        segmentList.classList.add("hidden");
        segmentList.innerHTML = "";
        lastResultText = "";
        btnCopy.disabled = true;
        btnExport.disabled = true;

        timerInt = setInterval(() => { timerText.textContent = fmtTime((Date.now() - recordStartTs) / 1000); }, 200);
        initVAD(mediaStream);
        if (currentMode === "conference") vadLoop();
    } catch (err) {
        const msgs = { NotAllowedError: "请在浏览器设置中允许麦克风权限", NotFoundError: "未检测到麦克风设备" };
        setStatus("error", err.name === "NotAllowedError" ? "权限被拒绝" : "启动失败");
        hintText.textContent = msgs[err.name] || err.message;
        setRecordButton("idle");
    }
}

function stopRecording() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    vadRafId = null;
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function cleanupRecording() {
    clearInterval(timerInt);
    stopVAD();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    isRecording = false;
    setRecordButton("idle");
    timerText.textContent = "00:00";
    chunkQueue = [];
    chunkProcessing = false;
    if (currentMode === "conference") {
        setStatus("idle", "待机");
        hintText.textContent = "可以再次录音，或按空格键继续";
    }
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
    submitAudio(f, f.name, false, 0);
}

// ---------- API ----------
async function submitAudio(blob, filename, isChunk = false, duration = 0, audioBlob = null) {
    if (!isChunk) {
        isProcessing = true;
        setRecordButton("processing");
        btnUpload.disabled = true;
        setStatus("processing", "识别中");
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
                resultText.textContent += (resultText.textContent.endsWith("…") || resultText.textContent.endsWith(" ") ? "" : " ") + data.text + " ";
                lastResultText = resultText.textContent;
            }
        } else {
            resultText.classList.remove("placeholder", "fade-in");
            void resultText.offsetWidth;
            resultText.classList.add("fade-in");
            resultText.textContent = data.text || "（未识别到语音）";
            lastResultText = data.text || "";
            metaLang.textContent = data.language;
            metaDuration.textContent = data.duration_seconds;
            metaProcessing.textContent = data.processing_seconds;
            btnCopy.disabled = false;
            btnExport.disabled = false;

            if (data.segments && data.segments.length > 1) {
                segmentList.classList.remove("hidden");
                segmentList.innerHTML = data.segments.map((s) =>
                    `<div class="segment-item"><span class="segment-time">[${fmtTimestamp(s.start)} - ${fmtTimestamp(s.end)}]</span><span class="segment-text">${escapeHtml(s.text)}</span></div>`
                ).join("");
            } else {
                segmentList.classList.add("hidden");
            }

            setStatus("done", "完成");
            hintText.textContent = "可以再次录音、上传文件，或按空格键继续";
            addHistory(currentMode, data.text || "", data.duration_seconds || duration, data.segments || [], audioBlob);
        }
    } catch (err) {
        if (isChunk) {
            console.warn("chunk transcribe failed:", err.message);
        } else {
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

// ---------- Init ----------
loadHistory();
applyModeTheme("single");
initDB();
