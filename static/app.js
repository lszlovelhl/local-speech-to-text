/**
 * Local Speech-to-Text v2.0
 * - 单次识别模式：录完再识别
 * - 会议模式：持续录音，每 4 秒分片识别，实时追加文字
 * - 自动语言检测（auto / zh / en）
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
let conferenceChunks = [];      // 会议模式累积的分片
let conferenceTimer = null;     // 会议模式分片定时器
let isBusy = false;

// ---------- Language / Mode selectors ----------
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
        ? "会议模式：持续录音，实时识别，手动停止"
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

// ---------- Recording ----------
btnStart.addEventListener("click", async () => {
    if (isBusy) return;
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(mediaStream);
        chunks = [];
        conferenceChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data);
                if (currentMode === "conference") conferenceChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
            const ext = mediaRecorder.mimeType.includes("ogg") ? "ogg" : "webm";
            if (currentMode === "single") {
                submitAudio(blob, `recording.${ext}`);
            }
            cleanupRecording();
        };

        mediaRecorder.start(4000); // 每4秒触发一次 ondataavailable（会议模式分片用）
        recordStartTs = Date.now();
        btnStart.hidden = true;
        btnStop.hidden = false;
        setStatus("recording", "录音中");
        hintText.textContent = currentMode === "conference"
            ? "会议模式进行中… 实时识别会自动追加"
            : "正在录音，点击停止结束";

        timerInt = setInterval(() => {
            timerText.textContent = fmtTime((Date.now() - recordStartTs) / 1000);
        }, 200);

        // 会议模式：每 4 秒发一个分片识别
        if (currentMode === "conference") {
            conferenceTimer = setInterval(async () => {
                if (conferenceChunks.length === 0) return;
                const blob = new Blob(conferenceChunks, { type: mediaRecorder.mimeType });
                conferenceChunks = [];
                await submitAudio(blob, `chunk.webm`, true);
            }, 4000);
        }
    } catch (err) {
        if (err.name === "NotAllowedError") {
            setStatus("error", "权限被拒绝");
            hintText.textContent = "请在浏览器地址栏允许麦克风权限";
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
    if (conferenceTimer) { clearInterval(conferenceTimer); conferenceTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    // 会议模式下最后再处理一次剩余分片
    if (currentMode === "conference" && conferenceChunks.length > 0) {
        const blob = new Blob(conferenceChunks, { type: mediaRecorder.mimeType });
        submitAudio(blob, "final.webm", true);
        conferenceChunks = [];
    }
});

function cleanupRecording() {
    clearInterval(timerInt);
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
        isBusy = true;
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
            // 会议模式：追加文本
            if (data.text) {
                resultText.classList.remove("placeholder");
                resultText.textContent += (resultText.textContent.endsWith("…") ? "" : " ") + data.text + " ";
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
            isBusy = false;
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
