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
const themeToggle = $("themeToggle");
const uploadProgress = $("uploadProgress");
const uploadProgressBar = $("uploadProgressBar");
const uploadProgressText = $("uploadProgressText");
const uploadCancel = $("uploadCancel");
const btnRetry = $("btnRetry");

// ---------- State ----------
let currentLang = "auto";
let currentMode = "single";
let mediaRecorder = null;
let mediaStream = null;
let recordStartTs = 0;
let timerInt = null;
let chunks = [];
let isRecording = false;
let starting = false; // 防止 getUserMedia 异步返回前重复点击触发第二路采集
let isProcessing = false;
let lastResultText = "";
let lastSegments = []; // 最近一次识别的有效分段（用于带时间戳导出 TXT）
let lastUploadBlob = null; // 最近一次文件上传内容，用于失败后重试
let lastUploadName = "";
let lastTapeObjectUrl = null;
let currentTapeId = null; // 当前弹窗打开的历史条目 id，用于手动删除
let chunkFailedNotified = false; // 会议切片失败提示去抖，避免连续 toast 刷屏

// 录音安全上限：单次最长 10 分钟，到点自动停止，防止异常失控占用麦克风
const RECORD_MAX_SECONDS = 600;
const SUBMIT_TIMEOUT_MS = 300000; // 普通提交超时 5 分钟（大文件视频转码+识别）
const CHUNK_TIMEOUT_MS = 90000;   // 会议切片超时 90 秒

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
let conferenceSlices = []; // 会议模式逐片切片记录，停止后归入历史分段供单独复制导出
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
        // 旧版本连接占用数据库时打开被阻塞：不卡死，交由调用方 catch 降级
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
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

// 删除孤儿音频：历史条目被裁剪/过期后，其 IDB blob 必须同步清除，避免只增不减占配额。
// 事务任何失败都静默 resolve，清理逻辑绝不影响主流程。
async function deleteAudio(id) {
    if (!db || !id) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction("audio", "readwrite");
            tx.objectStore("audio").delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

const VAD_MIN_SPEECH_MS = 300;
const VAD_MIN_SILENCE_MS = 600;
const VAD_MAX_CHUNK_MS = 10000;
const VAD_NOISE_MEASURE_MS = 500;
const VAD_SENSITIVITY = 2.5;

// ---------- History ----------
function isValidHistoryItem(h) {
    return h && typeof h.id === "string" && h.id.length > 0 &&
        typeof h.text === "string" && h.text.trim().length > 0 &&
        Number.isFinite(h.ts);
}

function loadHistory() {
    try {
        let parsed = [];
        try {
            parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        } catch { parsed = []; }
        if (!Array.isArray(parsed)) parsed = [];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        // 单条坏数据直接剔除，不能污染整列渲染；被剔除项（过期/坏数据）同步清理 IDB 音频
        const kept = [];
        const stale = [];
        parsed.forEach((h) => {
            if (isValidHistoryItem(h) && h.ts > cutoff) kept.push(h);
            else stale.push(h);
        });
        history = kept;
        stale.forEach((h) => {
            if (h && typeof h.id === "string" && h.id) deleteAudio(h.id);
        });
        saveHistory();
    } catch { history = []; }
    renderHistory();
}

function saveHistory() {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
        // 存储配额已满等情况：不阻塞主流程，仅提示
        showToast("本地存储空间不足，历史记录可能无法完整保存");
    }
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
    if (history.length > 20) {
        // 先取出被裁剪淘汰的尾部条目，删除其 IDB 音频后再保留前 20 条
        const dropped = history.slice(20);
        dropped.forEach((h) => {
            if (h && typeof h.id === "string" && h.id) deleteAudio(h.id);
        });
        history = history.slice(0, 20);
    }
    saveHistory();
    renderHistory();
    // Save audio blob to IndexedDB
    if (audioBlob) saveAudio(id, audioBlob);
}

function formatHistoryLabel(ts) {
    try {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return "--";
        return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
    } catch { return "--"; }
}

function buildTapeCard(h) {
    try {
        const idx = history.indexOf(h);
        const label = formatHistoryLabel(h.ts);
        const text = escapeHtml(String(h.text || ""));
        const duration = fmtTime(Number(h.duration) || 0);
        return `<div class="tape" data-idx="${idx}" title="${text}">
            <div class="tape-label">${escapeHtml(label)}</div>
            <div class="tape-duration">${duration}</div>
        </div>`;
    } catch {
        return "";
    }
}

function renderHistory() {
    const singleShelf = $("tapeSingle");
    const confShelf = $("tapeConf");
    if (!singleShelf || !confShelf) return;

    const singles = history.filter((h) => isValidHistoryItem(h) && h.mode !== "conference");
    const confs = history.filter((h) => isValidHistoryItem(h) && h.mode === "conference");

    try {
        singleShelf.innerHTML = singles.map(buildTapeCard).join("");
        confShelf.innerHTML = confs.map(buildTapeCard).join("");
    } catch {
        singleShelf.innerHTML = "";
        confShelf.innerHTML = "";
        return;
    }

    // Click tape to open modal（每次渲染重新绑定，避免残留旧索引）
    document.querySelectorAll(".tape").forEach((t) => {
        t.addEventListener("click", () => {
            const idx = parseInt(t.dataset.idx, 10);
            const h = history[idx];
            if (!isValidHistoryItem(h)) return;
            openTapeModal(h);
        });
    });
}

function revokeTapeAudioUrl() {
    const audio = $("modalAudio");
    if (audio) {
        try { audio.pause(); } catch {}
        audio.removeAttribute("src");
        audio.load();
    }
    if (lastTapeObjectUrl) {
        URL.revokeObjectURL(lastTapeObjectUrl);
        lastTapeObjectUrl = null;
    }
}

async function openTapeModal(h) {
    const modal = $("tapeModal");
    modal.classList.remove("closing");
    $("modalTitle").textContent = formatHistoryLabel(h.ts);
    $("modalTime").textContent = fmtTime(Number(h.duration) || 0);
    $("modalText").textContent = String(h.text || "");
    // 会议多段切片：弹窗内逐片展示并支持单独复制导出
    const slicesBox = $("modalSlices");
    const segs = Array.isArray(h.segments)
        ? h.segments.filter((s) => s && typeof s.text === "string" && s.text.trim())
        : [];
    if (segs.length > 1) {
        slicesBox.classList.remove("hidden");
        slicesBox.innerHTML = segs.map((s, i) => {
            const st = fmtTimestamp(Number(s.start) || 0);
            const en = fmtTimestamp(Number(s.end) || 0);
            return `<div class="slice-row"><span class="slice-time">[${st}-${en}]</span><span class="slice-text">${escapeHtml(s.text)}</span><button class="slice-copy" data-i="${i}">复制片段</button></div>`;
        }).join("");
        slicesBox.querySelectorAll(".slice-copy").forEach((btn) => {
            btn.addEventListener("click", () => {
                const seg = segs[Number(btn.dataset.i)];
                const txt = String(seg ? seg.text : "").trim();
                if (!txt) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt)
                        .then(() => showToast("已复制该片段"))
                        .catch(() => showToast("复制失败，请手动选中文字"));
                } else {
                    showToast("当前浏览器不支持一键复制");
                }
            });
        });
    } else {
        slicesBox.classList.add("hidden");
        slicesBox.innerHTML = "";
    }
    // 记录当前条目；无 id 的坏数据不暴露删除操作
    currentTapeId = (h && typeof h.id === "string" && h.id) ? h.id : null;
    const delBtn = $("modalDelete");
    if (delBtn) delBtn.disabled = !currentTapeId;
    // 先释放上一条录音的临时 URL，避免内存泄漏
    revokeTapeAudioUrl();
    const audio = $("modalAudio");
    audio.style.display = "none";
    modal.classList.add("open");
    if (h.id) {
        try {
            const blob = await getAudio(h.id);
            // 等待期间用户可能已关闭弹窗，回来时再校验 open 状态，避免给隐藏的弹窗挂音频
            if (blob && modal.classList.contains("open")) {
                lastTapeObjectUrl = URL.createObjectURL(blob);
                audio.src = lastTapeObjectUrl;
                audio.style.display = "block";
            }
        } catch { /* 单条音频读取失败不影响文字展示 */ }
    }
}

function closeTapeModal() {
    const modal = $("tapeModal");
    modal.classList.add("closing");
    const slicesBox = $("modalSlices");
    if (slicesBox) { slicesBox.classList.add("hidden"); slicesBox.innerHTML = ""; }
    revokeTapeAudioUrl();
    currentTapeId = null;
    const delBtn = $("modalDelete");
    if (delBtn) delBtn.disabled = true;
    setTimeout(() => {
        modal.classList.remove("open", "closing");
    }, 200);
}

$("modalClose").addEventListener("click", closeTapeModal);
$("tapeModal").querySelector(".tape-modal-backdrop").addEventListener("click", closeTapeModal);

// 手动删除当前历史条目：同步清 IndexedDB 音频 blob，两列列表即时刷新
$("modalDelete").addEventListener("click", () => {
    if (!currentTapeId) return;
    try {
        revokeTapeAudioUrl();
        history = history.filter((h) => !(h && h.id === currentTapeId));
        deleteAudio(currentTapeId); // 静默清理，失败不打断主流程
        saveHistory();
        renderHistory();
        currentTapeId = null;
        closeTapeModal();
        showToast("已删除");
    } catch (e) {
        console.warn("delete history failed:", e);
        showToast("删除失败，请重试");
    }
});

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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
    lastSegments = [];
    conferenceSlices = [];
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
    // 浏览器自动播放策略下 AudioContext 可能处于 suspended，主动恢复保证波形/VAD 有数据
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
            const blob = new Blob(currentChunkChunks, { type: mediaRecorder ? mediaRecorder.mimeType : "" });
            if (blob.size > 0) {
                chunkQueue.push(blob);
                processChunkQueue();
            }
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
            // 单切片失败隔离，不影响后续切片；用户侧只提示一次
            if (!chunkFailedNotified) {
                chunkFailedNotified = true;
                showToast("一段语音识别失败，已自动跳过继续");
            }
        }
    }
    chunkProcessing = false;
}

// 等待队列真正排空（含正在飞行中的切片请求），供会议停止后合并文本使用
async function waitChunkQueueDrained() {
    for (let i = 0; i < 900; i++) {
        if (!chunkProcessing && chunkQueue.length === 0) return;
        await new Promise((r) => setTimeout(r, 100));
    }
}

function stopVAD() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    vadRafId = null;
    stopWave();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
}

// ---------- 录音控制 ----------
function releaseStream() {
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        mediaStream = null;
    }
}

btnRecord.addEventListener("click", () => {
    if (isProcessing || starting) return;
    isRecording ? stopRecording() : startRecording();
});

async function startRecording() {
    if (isRecording || starting || isProcessing) return;
    starting = true;
    chunkFailedNotified = false;

    // 环境不支持（非安全上下文 / 旧浏览器）时给出明确提示，而不是静默失败
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        starting = false;
        setStatus("error", "启动失败");
        hintText.textContent = "当前浏览器不支持麦克风采集，请使用最新版 Chrome / Edge，并通过 localhost 或 HTTPS 访问";
        showToast("无法访问麦克风");
        setRecordButton("idle");
        return;
    }

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
        });

        // 拿到流但没有可用音轨（极端设备异常）
        if (!mediaStream.getAudioTracks || mediaStream.getAudioTracks().length === 0) {
            releaseStream();
            throw new DOMException("未检测到音频轨", "NotFoundError");
        }

        try {
            mediaRecorder = new MediaRecorder(mediaStream);
        } catch (recErr) {
            releaseStream();
            throw recErr;
        }
        chunks = [];
        currentChunkChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) { chunks.push(e.data); currentChunkChunks.push(e.data); }
        };
        mediaRecorder.onerror = (e) => {
            console.warn("MediaRecorder error:", e);
            showToast("录音出现异常，请停止后重试");
            cleanupRecording();
        };
        mediaRecorder.onstop = async () => {
            const duration = (Date.now() - recordStartTs) / 1000;
            if (currentMode === "single") {
                const blob = new Blob(chunks, { type: mediaRecorder ? mediaRecorder.mimeType : "" });
                // 空录音（立即停止 / 全程静音被浏览器丢弃）不发无效请求
                if (!chunks.length || blob.size === 0) {
                    showToast("未录到有效语音，请重试");
                    cleanupRecording();
                    return;
                }
                const ext = mediaRecorder && mediaRecorder.mimeType.includes("ogg") ? "ogg" : "webm";
                submitAudio(blob, `recording.${ext}`, false, duration, blob);
            } else {
                // 会议模式：末片并入串行队列；无论有无末片都等待队列（含在飞切片）排空，
                // 确保所有切片文本已追加到 lastResultText 后再合并入库
                if (currentChunkChunks.length > 0) {
                    const finalBlob = new Blob(currentChunkChunks, { type: mediaRecorder ? mediaRecorder.mimeType : "" });
                    if (finalBlob.size > 0) chunkQueue.push(finalBlob);
                    currentChunkChunks = [];
                }
                processChunkQueue();
                await waitChunkQueueDrained();

                // 合并规范化：仅折叠多余连续空白/换行，不改写识别文字内容
                const mergedText = (lastResultText || "").trim().replace(/\s+/g, " ");
                // 逐片切片换算为相对时间分段，供磁带弹窗内单独复制导出
                const slices = conferenceSlices.map((s, i) => {
                    const start = Math.max(0, (s.ts - recordStartTs) / 1000);
                    const next = conferenceSlices[i + 1];
                    const end = next
                        ? Math.max(start + 0.5, (next.ts - recordStartTs) / 1000)
                        : start + 4;
                    return { start, end, text: s.text };
                });
                // 整段录音：chunks 全程累积，停止后一次性打包入库供回放；为空则只存文字
                const wholeBlob = new Blob(chunks, { type: mediaRecorder ? mediaRecorder.mimeType : "" });
                const hasWholeAudio = !!(wholeBlob && wholeBlob.size > 0);
                if (mergedText) {
                    addHistory(
                        "conference",
                        mergedText,
                        duration,
                        slices,
                        hasWholeAudio ? wholeBlob : null
                    );
                }
            }
            cleanupRecording();
        };

        mediaRecorder.start(250);
        recordStartTs = Date.now();
        isRecording = true;
        starting = false;
        setRecordButton("recording");
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference" ? "会议模式：正在监听…" : "正在录音，点击按钮或空格停止";

        // Clear previous result
        resultText.textContent = "";
        resultText.classList.add("placeholder");
        segmentList.classList.add("hidden");
        segmentList.innerHTML = "";
        lastResultText = "";
        currentTapeId = null;
        btnCopy.disabled = true;
        btnExport.disabled = true;

        timerInt = setInterval(() => {
            const elapsed = (Date.now() - recordStartTs) / 1000;
            timerText.textContent = fmtTime(elapsed);
            // 超长兜底：到上限自动停止，避免麦克风被长期占用
            if (elapsed >= RECORD_MAX_SECONDS) {
                showToast("录音时长已达上限，已自动停止");
                stopRecording();
            }
        }, 200);
        initVAD(mediaStream);
        if (currentMode === "conference") vadLoop();
    } catch (err) {
        starting = false;
        releaseStream();
        const msgs = {
            NotAllowedError: "麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试",
            PermissionDeniedError: "麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试",
            NotFoundError: "未检测到麦克风设备，请检查设备连接",
            DevicesNotFoundError: "未检测到麦克风设备，请检查设备连接",
            NotReadableError: "麦克风被其他应用占用，请关闭后重试",
            TrackStartError: "麦克风被其他应用占用，请关闭后重试",
            OverconstrainedError: "当前麦克风参数不受支持，请更换设备或浏览器",
            SecurityError: "浏览器安全策略阻止了麦克风访问",
        };
        const friendly = msgs[err && err.name] || "麦克风启动失败，请检查设备状态后重试";
        setStatus("error", "启动失败");
        hintText.textContent = friendly;
        showToast(friendly);
        setRecordButton("idle");
    }
}

function stopRecording() {
    if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try { mediaRecorder.stop(); } catch { cleanupRecording(); }
    } else {
        cleanupRecording();
    }
}

function cleanupRecording() {
    clearInterval(timerInt);
    timerInt = null;
    stopVAD();
    releaseStream();
    // 注意：不在这里强制 chunkProcessing=false，避免正在飞行中的切片请求与下一次录音并发；
    // 队列会自然排空并自行复位
    chunkQueue = [];
    conferenceSlices = [];
    // 重置本轮缓冲，避免上一轮整段音频/文本串到下一次录音
    chunks = [];
    currentChunkChunks = [];
    currentTapeId = null;
    mediaRecorder = null;
    isRecording = false;
    starting = false;
    // 单次录音停止后 submitAudio 已同步进入识别态（isProcessing=true），
    // 这里不能把按钮强行复位成 idle，避免识别中按钮状态与徽标不一致
    if (!isProcessing) setRecordButton("idle");
    timerText.textContent = "00:00";
    tapeTime.textContent = "00:00";
    if (currentMode === "conference") {
        setStatus("idle", "待机");
        hintText.textContent = "可以再次录音，或按空格键继续";
    }
}

// ---------- 空格快捷键 ----------
document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && !isProcessing && !starting) {
        e.preventDefault();
        isRecording ? stopRecording() : startRecording();
    }
});

// ---------- 上传白名单（与后端 app/config.py 保持一致） ----------
const AUDIO_EXTS = [".wav", ".webm", ".ogg", ".mp3", ".m4a", ".flac"];
const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"];
const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB

function formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function validateUploadFile(f) {
    if (!f) return "未选择有效文件";
    const name = (f.name || "未命名").toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const isVideo = VIDEO_EXTS.includes(ext);
    const isAudio = AUDIO_EXTS.includes(ext);
    if (!isVideo && !isAudio) {
        return `不支持的格式「${ext || "无扩展名"}」，支持音频 wav/webm/ogg/mp3/m4a/flac，视频 mp4/mov/mkv/avi/webm/m4v`;
    }
    if (f.size === 0) return "文件为空，请选择有效的音视频文件";
    const limit = isVideo ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE;
    if (f.size > limit) {
        return `文件大小超过限制（${isVideo ? "视频最大 200MB" : "音频最大 100MB"}），请截取或压缩后重试`;
    }
    return null;
}

// ---------- 拖拽上传 ----------
["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
});
["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); });
});
dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
    else showToast("请拖拽音视频文件到录音面板区域");
});

// ---------- 文件上传 ----------
btnUpload.addEventListener("click", () => { if (!isProcessing) fileInput.click(); });
fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    // 重置 input，否则再次选择同一文件不会触发 change 事件
    fileInput.value = "";
});

function handleFile(f) {
    const invalid = validateUploadFile(f);
    if (invalid) {
        fileName.textContent = "";
        showToast(invalid);
        return;
    }
    fileName.textContent = `${f.name}（${formatSize(f.size)}）`;
    submitFileWithProgress(f, f.name);
}

// ---------- API ----------
// 从响应体中提取面向用户的中文错误文案：
// HTTPException.detail 可能是字符串，也可能是 FastAPI 校验错误数组；非 JSON 响应兜底
async function extractErrorMessage(resp) {
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (data && typeof data.detail === "string") return data.detail;
    if (data && Array.isArray(data.detail) && data.detail.length > 0) {
        const first = data.detail[0];
        if (first && typeof first.msg === "string") return first.msg;
        if (typeof first === "string") return first;
    }
    return `识别服务暂时不可用（HTTP ${resp.status}），请稍后重试`;
}

function resolveSubmitError(err) {
    if (err && err.name === "AbortError") return "识别超时，请缩短录音或稍后重试";
    if (err && err.name === "TypeError") return "无法连接识别服务，请确认后端服务已启动后重试";
    if (err && err.message) return err.message;
    return "识别失败，请检查文件格式后重试";
}

// ---------- 文件转写结果渲染（录音上传 / 单文件上传共用） ----------
// LCD 屏自动滚到底，保证最新识别文字可见（边录边看）
function scrollLcdToBottom() {
    if (!resultText) return;
    resultText.scrollTop = resultText.scrollHeight;
}

function applyFileResult(data, duration, audioBlob) {
    const okText = (typeof data.text === "string" ? data.text : "").trim();
    // 强制语言模式下被过滤为空时，给出明确的“切换语言”引导，而不是笼统说没声音
    const emptyHint = data.language === "zh"
        ? "当前为中文模式：未得到中文结果；若说的是英文，可切换 English 或自动模式重试"
        : data.language === "en"
        ? "当前为英文模式：未得到英文结果；若说的是中文，可切换中文或自动模式重试"
        : "（未识别到语音，请确认文件含清晰人声）";
    resultText.classList.remove("placeholder", "fade-in");
    void resultText.offsetWidth;
    resultText.classList.add("fade-in");
    resultText.textContent = okText || emptyHint;
    scrollLcdToBottom();
    lastResultText = okText;
    metaLang.textContent = data.language || currentLang;
    metaDuration.textContent = Number.isFinite(data.duration_seconds) ? data.duration_seconds : "--";
    metaProcessing.textContent = Number.isFinite(data.processing_seconds) ? data.processing_seconds : "--";
    btnCopy.disabled = !okText;
    btnExport.disabled = !okText;

    // 分段时间戳渲染：过滤缺字段/空文本的坏项，缺时间戳时兜底为 0
    const rawSegs = Array.isArray(data.segments) ? data.segments : [];
    const validSegs = rawSegs.filter(
        (s) => s && typeof s.text === "string" && s.text.trim()
    );
    lastSegments = validSegs;
    if (validSegs.length > 1) {
        segmentList.classList.remove("hidden");
        segmentList.innerHTML = validSegs.map((s) => {
            const start = fmtTimestamp(Number(s.start) || 0);
            const end = fmtTimestamp(Number(s.end) || 0);
            return `<div class="segment-item"><span class="segment-time">[${start} - ${end}]</span><span class="segment-text">${escapeHtml(s.text)}</span></div>`;
        }).join("");
    } else {
        segmentList.classList.add("hidden");
        segmentList.innerHTML = "";
    }

    setStatus("done", "完成");
    hintText.textContent = okText
        ? "可以再次录音、上传文件，或按空格键继续"
        : emptyHint;
    addHistory(currentMode, okText, data.duration_seconds || duration, validSegs, audioBlob);
}

// ---------- 上传进度条（XHR 原生支持 upload.onprogress，fetch 不支持上传进度） ----------
function setUploadProgress(ratio, label) {
    uploadProgressBar.style.width = `${Math.round(ratio * 100)}%`;
    uploadProgressText.textContent = label;
}
function showUploadProgress(label) {
    uploadProgress.classList.remove("hidden");
    setUploadProgress(0, label);
}
function hideUploadProgress() {
    uploadProgress.classList.add("hidden");
    uploadProgressBar.style.width = "0%";
}

let activeUploadXhr = null; // 当前进行中的文件上传，供取消按钮调用 abort

function submitFileWithProgress(blob, filename, audioBlob = null) {
    return new Promise((resolve) => {
        const fd = new FormData();
        fd.append("file", blob, filename);
        fd.append("language", currentLang);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/transcribe", true);
        xhr.timeout = SUBMIT_TIMEOUT_MS;
        let userAborted = false;
        activeUploadXhr = xhr;

        showUploadProgress("准备上传…");
        uploadCancel.disabled = false;
        btnRetry.classList.add("hidden");
        btnRetry.disabled = true;
        isProcessing = true;
        setRecordButton("processing");
        btnUpload.disabled = true;
        fileInput.disabled = true;
        setStatus("processing", "识别中");
        hintText.textContent = "正在上传文件，请稍候…";

        // 暴露取消入口：用户点击取消时置标记并中断 XHR
        xhr.__cancel = () => {
            userAborted = true;
            xhr.abort();
        };

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) {
                const ratio = e.loaded / e.total;
                const pct = ratio >= 1 ? "上传完成，识别中…" : `已上传 ${Math.round(ratio * 100)}%`;
                const shortName = filename.length > 18 ? filename.slice(0, 17) + "…" : filename;
                setUploadProgress(ratio, `${shortName} · ${pct}`);
            }
        };
        xhr.upload.onloadstart = () => setUploadProgress(0, "正在上传…");

        // 失败时保留文件内容并展示“重试上传”按钮（用户主动取消不展示）
        function rememberForRetry() {
            lastUploadBlob = blob;
            lastUploadName = filename;
            btnRetry.classList.remove("hidden");
            btnRetry.disabled = false;
        }

        xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch { data = null; }

            if (xhr.status >= 200 && xhr.status < 300 && data && typeof data === "object") {
                setUploadProgress(1, "识别完成");
                applyFileResult(data, 0, audioBlob);
            } else {
                let msg = `识别服务返回错误（HTTP ${xhr.status}）`;
                if (data) {
                    if (typeof data.detail === "string") msg = data.detail;
                    else if (Array.isArray(data.detail) && data.detail[0]) msg = data.detail[0].msg || data.detail[0];
                }
                setStatus("error", "识别失败");
                hintText.textContent = msg;
                showToast(msg);
                rememberForRetry();
            }
            finishFileSubmit();
            resolve();
        };
        // 用户主动取消走 onabort，与网络错误区分开，不报错
        xhr.onabort = () => {
            if (userAborted) {
                setStatus("idle", "待机");
                hintText.textContent = "已取消上传，可以重新选择文件";
                showToast("已取消上传");
            }
            finishFileSubmit();
            resolve();
        };
        xhr.onerror = () => {
            const msg = "无法连接识别服务，请确认后端服务已启动后重试";
            setStatus("error", "识别失败");
            hintText.textContent = msg;
            showToast(msg);
            rememberForRetry();
            finishFileSubmit();
            resolve();
        };
        xhr.ontimeout = () => {
            const msg = "识别超时，请缩短文件时长或稍后重试";
            setStatus("error", "识别失败");
            hintText.textContent = msg;
            showToast(msg);
            rememberForRetry();
            finishFileSubmit();
            resolve();
        };

        try {
            xhr.send(fd);
        } catch (err) {
            showToast(resolveSubmitError(err));
            rememberForRetry();
            finishFileSubmit();
            resolve();
        }
    });

    function finishFileSubmit() {
        hideUploadProgress();
        uploadCancel.disabled = true;
        activeUploadXhr = null; // 同一时刻只允许一个文件上传，直接清空句柄即可
        isProcessing = false;
        setRecordButton("idle");
        btnUpload.disabled = false;
        fileInput.disabled = false;
    }
}

uploadCancel.addEventListener("click", () => {
    if (activeUploadXhr && typeof activeUploadXhr.__cancel === "function") {
        activeUploadXhr.__cancel();
    }
});

btnRetry.addEventListener("click", () => {
    if (isProcessing || !lastUploadBlob) return;
    btnRetry.classList.add("hidden");
    submitFileWithProgress(lastUploadBlob, lastUploadName);
});

async function submitAudio(blob, filename, isChunk = false, duration = 0, audioBlob = null) {
    if (!isChunk) {
        isProcessing = true;
        setRecordButton("processing");
        btnUpload.disabled = true;
        fileInput.disabled = true;
        setStatus("processing", "识别中");
        hintText.textContent = "正在识别，请稍候…";
    }

    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("language", currentLang);
    // 会议切片标记为 chunk：后端放宽 webm 片段的严格媒体探测，失败也按单片隔离
    fd.append("source", isChunk ? "chunk" : "file");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), isChunk ? CHUNK_TIMEOUT_MS : SUBMIT_TIMEOUT_MS);

    try {
        const resp = await fetch("/api/transcribe", {
            method: "POST",
            body: fd,
            signal: controller.signal,
        });
        if (!resp.ok) throw new Error(await extractErrorMessage(resp));

        let data = null;
        try { data = await resp.json(); } catch { data = null; }
        if (!data || typeof data !== "object") throw new Error("识别结果格式异常，请稍后重试");

        if (isChunk) {
            const chunkText = (typeof data.text === "string" ? data.text : "").trim();
            if (chunkText) {
                resultText.classList.remove("placeholder");
                const needSpace = resultText.textContent &&
                    !resultText.textContent.endsWith(" ") &&
                    !resultText.textContent.endsWith("…");
                resultText.textContent += (needSpace ? " " : "") + chunkText + " ";
                lastResultText = resultText.textContent;
                // 记录单片切片（含绝对时间戳），停止合并时换算为相对时间分段
                conferenceSlices.push({ text: chunkText, ts: Date.now() });
                scrollLcdToBottom();
            }
        } else {
            applyFileResult(data, duration, audioBlob);
        }
    } catch (err) {
        if (isChunk) {
            console.warn("chunk transcribe failed:", err);
        } else {
            const friendly = resolveSubmitError(err);
            setStatus("error", "识别失败");
            hintText.textContent = friendly;
            showToast(friendly);
        }
    } finally {
        clearTimeout(timeoutId);
        if (!isChunk) {
            isProcessing = false;
            setRecordButton("idle");
            btnUpload.disabled = false;
            fileInput.disabled = false;
        }
    }
}

// ---------- Copy / Export / Clear ----------
btnCopy.addEventListener("click", () => {
    if (btnCopy.disabled || resultText.classList.contains("placeholder")) return;
    const text = resultText.textContent;
    if (!text.trim()) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(text)
            .then(() => showToast("已复制"))
            .catch(() => showToast("复制失败，请手动选中文字复制"));
    } else {
        // 非安全上下文 / 旧浏览器兜底，避免点了没反应也没提示
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand("copy");
            showToast("已复制");
        } catch {
            showToast("复制失败，请手动选中文字复制");
        }
        document.body.removeChild(ta);
    }
});

btnExport.addEventListener("click", () => {
    if (btnExport.disabled || !lastResultText) return;
    try {
        let content;
        if (lastSegments && lastSegments.length > 1) {
            // 带时间戳分段导出，便于对照音视频定位
            content = lastSegments.map((s) => {
                const start = fmtTimestamp(Number(s.start) || 0);
                const end = fmtTimestamp(Number(s.end) || 0);
                return `[${start} - ${end}] ${s.text.trim()}`;
            }).join("\n\n");
        } else {
            content = lastResultText;
        }
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `transcript_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(lastSegments && lastSegments.length > 1 ? "已导出带时间戳 TXT" : "已导出 TXT");
    } catch {
        showToast("导出失败，请重试");
    }
});

btnClear.addEventListener("click", () => {
    resultText.textContent = "识别文字将显示在这里…";
    resultText.classList.add("placeholder");
    resultText.scrollTop = 0;
    segmentList.classList.add("hidden");
    segmentList.innerHTML = "";
    btnCopy.disabled = true;
    btnExport.disabled = true;
    lastResultText = "";
    lastSegments = [];
    lastUploadBlob = null;
    lastUploadName = "";
    btnRetry.classList.add("hidden");
    btnRetry.disabled = true;
    setStatus("idle", "待机");
});

// ---------- 主题切换（手动覆盖系统偏好，持久化到 localStorage） ----------
function getSystemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
        document.documentElement.setAttribute("data-theme", theme);
    } else {
        document.documentElement.removeAttribute("data-theme");
    }
    // 图标反映当前主题：深色显示太阳（点击转浅色），浅色显示月亮（点击转深色）
    const effective = document.documentElement.getAttribute("data-theme") || getSystemTheme();
    themeToggle.textContent = effective === "dark" ? "☀️" : "🌙";
}
themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || getSystemTheme();
    const next = current === "dark" ? "light" : "dark";
    try { localStorage.setItem("stt_theme", next); } catch (e) {}
    applyTheme(next);
});
applyTheme((() => { try { return localStorage.getItem("stt_theme"); } catch (e) { return null; } })());

// 取消按钮初始禁用，仅在上传进行中可点
uploadCancel.disabled = true;

// ---------- Init ----------
loadHistory();
applyModeTheme("single");
initDB().catch(() => {
    console.warn("IndexedDB 打开失败，历史音频将不持久化");
    showToast("本地存储不可用，本次录音仅保留文字记录");
});
