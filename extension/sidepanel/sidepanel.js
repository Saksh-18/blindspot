// sidepanel.js — Vision Shield side panel
// Same message contract as before: START_TASK / STOP_TASK to the background,
// STEP_STARTED / STEP_FINISHED back, CAPTURE_AND_SANITIZE to the content script.
// Optional new hook: background may send { type: "STAGE", stage: 0..4 } to drive
// the pipeline strip with real timings instead of the optimistic animation below.

const $ = (id) => document.getElementById(id);

const el = {
  rail: $("rail"), railBtn: $("railBtn"), scrim: $("scrim"),
  themeBtn: $("themeBtn"), themeIcon: $("themeIcon"), themeLabel: $("themeLabel"),
  paneTitle: $("paneTitle"), paneSub: $("paneSub"), statusChip: $("statusChip"),
  stageName: $("stageName"), stageNote: $("stageNote"),
  log: $("log"), emptyState: $("emptyState"),
  shieldDot: $("shieldDot"), shieldCount: $("shieldCount"),
  statFaces: $("statFaces"), statFields: $("statFields"), maskedList: $("maskedList"),
  previewFrame: $("previewFrame"),
  tTotal: $("tTotal"), tModel: $("tModel"), tDom: $("tDom"), tVlm: $("tVlm"),
  wModel: $("wModel"), wDom: $("wDom"), wVlm: $("wVlm"), bars: $("bars"),
  history: $("history"),
  taskInput: $("taskInput"), primaryBtn: $("primaryBtn"), primaryIcon: $("primaryIcon"),
  primaryLabel: $("primaryLabel"), resetBtn: $("resetBtn"),
  micBtn: $("micBtn"), micIcon: $("micIcon"),
  redactSolidBtn: $("redactSolidBtn"), redactBlurBtn: $("redactBlurBtn"),
  toggleModel: $("toggleModel"), toggleDom: $("toggleDom"),
  captureBtn: $("captureBtn"), debugStatus: $("debugStatus"), debugDom: $("debugDom")
};

const PANES = {
  agent:  ["Agent", "Live reasoning loop"],
  shield: ["Privacy", "What actually left the browser"],
  tele:   ["Latency", "Where the time goes, per step"],
  hist:   ["History", "Runs from this session"],
  cfg:    ["Settings", "Pipeline and endpoint"]
};

const STAGES = ["Capture", "Redact", "Send", "Reason", "Execute"];
const NOTES = [
  "Screenshotting the tab, snapshotting the DOM",
  "Blacking out faces, stripping sensitive text",
  "Sending the sanitized frame upstream",
  "Choosing the next action",
  "Performing the action in the page"
];
const ACTION_ICON = {
  click: "ph-cursor-click", type: "ph-keyboard",
  scroll: "ph-arrows-out-line-vertical", done: "ph-check"
};
const ACTION_LABEL = {
  click: "Clicked an element", type: "Typed into a field",
  scroll: "Scrolled the page", done: "Objective satisfied"
};

let options = { redactionMode: "blackout", runModel: true, runDom: true };
let prefs = { theme: "cream", pane: "agent" };
let history = [];
let stepDurations = [];
let running = false;
let stageTimers = [];
let ranAnything = false;

/* ------------------------------- chrome shims ------------------------------ */
const store = {
  get(keys) {
    return new Promise((res) => {
      try { chrome.storage.local.get(keys, (r) => res(r || {})); }
      catch { res({}); }
    });
  },
  set(obj) { try { chrome.storage.local.set(obj); } catch {} }
};

/* --------------------------------- theme ---------------------------------- */
function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme === "espresso" ? "espresso" : "";
  const dark = prefs.theme === "espresso";
  el.themeIcon.className = "ph-duotone " + (dark ? "ph-sun" : "ph-moon-stars");
  el.themeLabel.textContent = dark ? "Cream" : "Espresso";
}
el.themeBtn.addEventListener("click", () => {
  prefs.theme = prefs.theme === "espresso" ? "cream" : "espresso";
  applyTheme();
  store.set({ agentUiPrefs: prefs });
});

/* ---------------------------------- rail ---------------------------------- */
// Overlay drawer, not a reflowing column: a Chrome side panel is only 320-500px
// wide, so a persistent 184px rail would eat half the content. Expanded state is
// momentary — the scrim dismisses it and picking a pane closes it.
let railOpen = false;
function setRail(open) {
  railOpen = open;
  el.rail.classList.toggle("open", open);
  el.scrim.classList.toggle("on", open);
  el.railBtn.title = open ? "Hide labels" : "Show labels";
}
el.railBtn.addEventListener("click", () => setRail(!railOpen));
el.scrim.addEventListener("click", () => setRail(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && railOpen) setRail(false); });

/* ---------------------------------- panes --------------------------------- */
function goPane(name) {
  prefs.pane = name;
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("on", b.dataset.pane === name));
  document.querySelectorAll(".pane").forEach((p) => p.classList.remove("on"));
  const pane = $("pane-" + name);
  if (pane) { pane.classList.add("on"); pane.style.animation = "none"; void pane.offsetWidth; pane.style.animation = ""; }
  const [t, s] = PANES[name];
  el.paneTitle.textContent = t;
  el.paneSub.textContent = s;
  setRail(false);
  store.set({ agentUiPrefs: prefs });
}
document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => goPane(b.dataset.pane)));

/* -------------------------------- pipeline -------------------------------- */
function setStage(i) {
  document.querySelectorAll(".stage").forEach((s) => {
    const n = +s.dataset.stage;
    s.classList.toggle("live", n === i);
    s.classList.toggle("done", i < 0 ? ranAnything : n < i);
  });
  el.stageName.textContent = i >= 0 ? STAGES[i] : (ranAnything ? "Clear" : "Ready");
  el.stageNote.textContent = i >= 0 ? NOTES[i] : (ranAnything ? "Loop idle, five stages clear" : "Everything local until Send");
}
function clearStageTimers() { stageTimers.forEach(clearTimeout); stageTimers = []; }
// Optimistic walk: capture -> redact -> send -> reason, then hold on "reason"
// until STEP_FINISHED arrives. Replace with real STAGE messages when ready.
function walkStages() {
  clearStageTimers();
  [0, 1, 2, 3].forEach((s, k) => stageTimers.push(setTimeout(() => setStage(s), k * 260)));
}

/* --------------------------------- options -------------------------------- */
function applyOptions() {
  const blur = options.redactionMode === "blur";
  el.redactBlurBtn.classList.toggle("on", blur);
  el.redactSolidBtn.classList.toggle("on", !blur);
  el.toggleModel.classList.toggle("on", !!options.runModel);
  el.toggleModel.setAttribute("aria-checked", String(!!options.runModel));
  el.toggleDom.classList.toggle("on", !!options.runDom);
  el.toggleDom.setAttribute("aria-checked", String(!!options.runDom));
}
function saveOptions() { store.set({ agentOptions: options }); }

el.redactSolidBtn.addEventListener("click", () => { options.redactionMode = "blackout"; applyOptions(); saveOptions(); });
el.redactBlurBtn.addEventListener("click", () => { options.redactionMode = "blur"; applyOptions(); saveOptions(); });
el.toggleModel.addEventListener("click", () => { options.runModel = !options.runModel; applyOptions(); saveOptions(); });
el.toggleDom.addEventListener("click", () => { options.runDom = !options.runDom; applyOptions(); saveOptions(); });

/* --------------------------------- history -------------------------------- */
function renderHistory() {
  if (!history.length) {
    el.history.innerHTML =
      '<div class="empty"><div class="badge"><i class="ph-duotone ph-clock-counter-clockwise"></i></div>' +
      "<h3>No runs yet</h3><p>Finished runs land here so you can re-run them with one tap.</p></div>";
    return;
  }
  el.history.innerHTML = history.map((h) => `
    <button class="hrow" data-task="${escapeAttr(h.task)}">
      <span class="ic"><i class="ph-duotone ${h.success ? "ph-check-circle" : "ph-stop-circle"}"></i></span>
      <span style="flex:1;min-width:0">
        <span class="task">${escapeHtml(h.task)}</span>
        <span class="meta num"><span>${escapeHtml(h.timestamp)}</span><span>${h.steps} steps</span><span>${h.success ? "completed" : "stopped"}</span></span>
      </span>
      <i class="ph-duotone ph-arrow-counter-clockwise" style="font-size:14px;color:var(--tx3);flex-shrink:0;margin-top:5px"></i>
    </button>`).join("");
  el.history.querySelectorAll(".hrow").forEach((row) => {
    row.addEventListener("click", () => { el.taskInput.value = row.dataset.task; goPane("agent"); });
  });
}
function saveToHistory(task, steps, success) {
  history.unshift({
    id: Date.now(), task, steps, success,
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  });
  history = history.slice(0, 20);
  store.set({ agentHistory: history });
  renderHistory();
}

/* -------------------------------- telemetry ------------------------------- */
function resetTelemetry() {
  ["tTotal", "tModel", "tDom", "tVlm"].forEach((k) => (el[k].textContent = "—"));
  el.wModel.style.width = el.wDom.style.width = el.wVlm.style.width = "0";
  el.statFaces.textContent = "0";
  el.statFields.textContent = "0";
  el.shieldCount.textContent = "0";
  el.shieldDot.classList.remove("show");
  el.maskedList.innerHTML = maskedRow("nothing masked yet", "—");
  stepDurations = [];
  renderBars();
}
function maskedRow(sel, kind) {
  return `<div class="list-row"><span class="led"></span><span class="sel">${escapeHtml(sel)}</span><span class="kind">${escapeHtml(kind)}</span></div>`;
}
function renderBars() {
  if (!stepDurations.length) {
    el.bars.innerHTML = '<div style="flex:1;font-size:12px;color:var(--tx3);text-align:center;align-self:center">No runs measured yet.</div>';
    return;
  }
  const max = Math.max(...stepDurations);
  el.bars.innerHTML = stepDurations.map((ms, i) =>
    `<div class="col"><div class="b" style="height:${Math.max(12, (ms / max) * 100)}%"></div><div class="n num">${i + 1}</div></div>`
  ).join("");
}
let faces = 0, fields = 0;
function updateTelemetry(t) {
  if (!t) return;
  const model = Math.round(t.detectSensitiveRegionsMs || 0);
  const dom = Math.round((t.sanitizeDomMs || 0) + (t.findTextPiiMs || 0));
  const vlm = Math.round(t.serverRoundTripMs || 0);
  const total = Math.round(t.totalStepMs || model + dom + vlm);
  el.tModel.textContent = model;
  el.tDom.textContent = dom;
  el.tVlm.textContent = vlm;
  el.tTotal.textContent = total;
  const sum = Math.max(1, model + dom + vlm);
  el.wModel.style.width = (model / sum) * 100 + "%";
  el.wDom.style.width = (dom / sum) * 100 + "%";
  el.wVlm.style.width = (vlm / sum) * 100 + "%";
  stepDurations.push(total);
  renderBars();

  const boxes = t.redactedBoxes || [];
  faces += boxes.filter((b) => b.type === "face").length;
  fields += boxes.filter((b) => b.type !== "face").length;
  el.statFaces.textContent = faces;
  el.statFields.textContent = fields;
  el.shieldCount.textContent = faces + fields;
  el.shieldDot.classList.toggle("show", faces + fields > 0);

  if (boxes.length) {
    const rows = boxes.slice(0, 6).map((b) => maskedRow(b.selector || b.label || "visual region", b.type || "region")).join("");
    el.maskedList.innerHTML = rows;
  }
  return { faces, fields };
}

/* -------------------------------- step cards ------------------------------ */
function stepCard(step, action) {
  const kind = (action && action.action) || "pending";
  const exec = action && action.executionResult;
  const target = action && (action.selector || (action.text ? `"${action.text}"` : ""));
  const redacted = action && action.telemetry && action.telemetry.redactedBoxes
    ? action.telemetry.redactedBoxes.length : 0;
  const ms = action && action.telemetry ? Math.round(action.telemetry.totalStepMs || 0) : 0;
  return `
    <div class="step a-${escapeAttr(kind)}" id="step-${step}">
      <div class="step-head">
        <span class="step-badge"><i class="ph-duotone ${ACTION_ICON[kind] || "ph-circle-dashed"}"></i></span>
        <span class="step-label">${escapeHtml(ACTION_LABEL[kind] || "Working…")}</span>
        <span class="step-ms num">${ms ? ms + "ms" : ""}</span>
      </div>
      ${target ? `<div class="step-target">${escapeHtml(target)}</div>` : ""}
      <div class="step-reason">${escapeHtml((action && action.reasoning) || "Running the local anonymizer and reading the layout…")}</div>
      <div class="step-meta">
        ${exec
          ? (exec.matched
              ? '<span class="ok"><i class="ph-duotone ph-check-circle"></i>executed</span>'
              : `<span class="bad"><i class="ph-duotone ph-x-circle"></i>${escapeHtml(exec.reason || "execution failed")}</span>`)
          : ""}
        <span><i class="ph-duotone ph-shield"></i>${redacted} redacted</span>
      </div>
    </div>`;
}

/* ----------------------------------- run ---------------------------------- */
function setRunning(on) {
  running = on;
  document.body.classList.toggle("running", on);
  el.primaryIcon.className = "ph-duotone " + (on ? "ph-stop-circle" : "ph-play-circle");
  el.primaryLabel.textContent = on ? "Halt agent" : "Run agent";
}

el.primaryBtn.addEventListener("click", async () => {
  if (running) {
    el.statusChip.textContent = "stopping…";
    try { await chrome.runtime.sendMessage({ type: "STOP_TASK" }); } catch (e) { console.warn(e); }
    return;
  }

  const task = el.taskInput.value.trim();
  if (!task) { el.statusChip.textContent = "enter a task"; el.taskInput.focus(); return; }

  setRunning(true);
  ranAnything = true;
  faces = 0; fields = 0;
  resetTelemetry();
  el.log.innerHTML = "";
  el.statusChip.textContent = "starting";
  goPane("agent");

  try {
    const result = await chrome.runtime.sendMessage({ type: "START_TASK", task, options });
    if (!result) {
      el.statusChip.textContent = "no response";
      saveToHistory(task, 0, false);
    } else if (result.stopped) {
      el.statusChip.textContent = `halted · ${result.steps} steps`;
      saveToHistory(task, result.steps, false);
    } else if (result.needsUserInput) {
      el.statusChip.textContent = `needs you · ${result.steps} steps`;
      const field = (result.action && result.action.selector) || "a field";
      appendNotice(`Everything else is done — ${field} needs your own input (it's redacted, so the agent can't see or fill it). Fill it in yourself, then re-run to continue.`);
      saveToHistory(task, result.steps, true);
    } else if (result.error) {
      el.statusChip.textContent = `error · ${result.steps} steps`;
      appendError(result.error);
      saveToHistory(task, result.steps, false);
    } else {
      el.statusChip.textContent = `done · ${result.steps} steps`;
      saveToHistory(task, result.steps, true);
    }
  } catch (err) {
    el.statusChip.textContent = "error";
    appendError(err.message);
    saveToHistory(task, 0, false);
    console.error(err);
  } finally {
    setRunning(false);
    clearStageTimers();
    setStage(-1);
  }
});

function appendError(msg) {
  el.log.insertAdjacentHTML("beforeend",
    `<div class="step a-done" style="--ac:var(--warn)">
       <div class="step-head"><span class="step-badge"><i class="ph-duotone ph-warning"></i></span>
       <span class="step-label">Run stopped</span></div>
       <div class="step-reason">${escapeHtml(msg)}</div>
     </div>`);
}

function appendNotice(msg) {
  el.log.insertAdjacentHTML("beforeend",
    `<div class="step a-done" style="--ac:var(--ok)">
       <div class="step-head"><span class="step-badge"><i class="ph-duotone ph-hand-tap"></i></span>
       <span class="step-label">Needs your input</span></div>
       <div class="step-reason">${escapeHtml(msg)}</div>
     </div>`);
}

el.resetBtn.addEventListener("click", () => {
  clearStageTimers();
  ranAnything = false;
  faces = 0; fields = 0;
  resetTelemetry();
  setStage(-1);
  el.statusChip.textContent = "idle";
  el.log.innerHTML =
    '<div class="empty" id="emptyState"><div class="badge"><i class="ph-duotone ph-scan-smiley"></i></div>' +
    "<h3>Nothing running</h3><p>Give the agent an objective. Every move it makes is narrated here, with the redaction receipt one icon away.</p></div>";
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => { el.taskInput.value = chip.dataset.task; goPane("agent"); });
});

/* ----------------------------------- mic --------------------------------- */
// Dictation only — never sent anywhere itself, just fills the task box the
// same as typing would. Uses the browser's own SpeechRecognition, which
// triggers the standard mic permission prompt on first use.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

function setListening(on) {
  listening = on;
  el.micBtn.classList.toggle("listening", on);
  el.micIcon.className = "ph-duotone " + (on ? "ph-stop-circle" : "ph-microphone");
  el.micBtn.title = on ? "Listening… click to stop" : "Dictate task";
}

if (!SpeechRecognition) {
  el.micBtn.disabled = true;
  el.micBtn.title = "Voice dictation isn't supported in this browser";
} else {
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;

  let baseText = "";

  recognition.addEventListener("result", (e) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    const sep = baseText && !/\s$/.test(baseText) ? " " : "";
    el.taskInput.value = baseText + sep + (finalText || interimText);
  });

  recognition.addEventListener("error", (e) => {
    setListening(false);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      el.statusChip.textContent = "mic permission denied";
    } else if (e.error === "no-speech") {
      el.statusChip.textContent = "didn't catch that";
    } else {
      el.statusChip.textContent = `mic error: ${e.error}`;
    }
  });

  recognition.addEventListener("end", () => setListening(false));

  el.micBtn.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }
    baseText = el.taskInput.value.trim();
    try {
      recognition.start(); // prompts for mic permission the first time
      setListening(true);
      el.statusChip.textContent = "listening";
    } catch (err) {
      console.error("Failed to start speech recognition:", err);
      el.statusChip.textContent = "mic unavailable";
    }
  });
}

/* ------------------------------ step messages ----------------------------- */
const hasRuntime = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage;
if (hasRuntime) chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  if (msg.type === "STAGE" && typeof msg.stage === "number") {
    clearStageTimers();
    setStage(msg.stage);
    return;
  }

  if (msg.type === "STEP_STARTED") {
    el.statusChip.textContent = `step ${msg.step}`;
    walkStages();
    const existing = $("step-" + msg.step);
    if (existing) existing.outerHTML = stepCard(msg.step, null);
    else el.log.insertAdjacentHTML("beforeend", stepCard(msg.step, null));
  }

  if (msg.type === "STEP_FINISHED") {
    clearStageTimers();
    setStage(4);
    const node = $("step-" + msg.step);
    if (node) node.outerHTML = stepCard(msg.step, msg.action);
    else el.log.insertAdjacentHTML("beforeend", stepCard(msg.step, msg.action));
    updateTelemetry(msg.action && msg.action.telemetry);
    if (msg.action && msg.action.redactedImageDataUrl) showPreview(msg.action.redactedImageDataUrl);
  }
});

function showPreview(dataUrl) {
  el.previewFrame.innerHTML = `<img src="${dataUrl}" alt="Sanitized frame"><div class="tag">Sanitized frame</div>`;
}

/* --------------------------- capture-only harness ------------------------- */
el.captureBtn.addEventListener("click", async () => {
  el.debugStatus.textContent = "Capturing and redacting…";
  el.debugDom.innerHTML = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_AND_SANITIZE", options });

    if (result && result.error) { el.debugStatus.textContent = `Error: ${result.error}`; return; }
    if (!result || !result.redactedImageDataUrl) { el.debugStatus.textContent = "No result — check the console."; return; }

    showPreview(result.redactedImageDataUrl);
    const r = result.redactionReport || {};
    el.debugStatus.textContent =
      `${result.sanitizedDom.length} DOM nodes · ${r.domFieldsRedacted || 0} inputs masked · ` +
      `${r.textPiiRedacted || 0} text PII · ${r.visualRegionsRedacted || 0} faces`;

    faces = r.visualRegionsRedacted || 0;
    fields = (r.domFieldsRedacted || 0) + (r.textPiiRedacted || 0);
    el.statFaces.textContent = faces;
    el.statFields.textContent = fields;
    el.shieldCount.textContent = faces + fields;
    el.shieldDot.classList.toggle("show", faces + fields > 0);

    el.debugDom.innerHTML = result.sanitizedDom.slice(0, 30).map((n) =>
      `<div class="${n.sensitive ? "sensitive" : ""}">${escapeHtml(n.tag)} ${escapeHtml(n.selector)}: "${escapeHtml(n.text)}"</div>`
    ).join("");
  } catch (err) {
    el.debugStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  }
});

/* --------------------------------- helpers -------------------------------- */
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
function escapeAttr(str) { return escapeHtml(str).replace(/"/g, "&quot;"); }

/* ---------------------------------- boot --------------------------------- */
(async function boot() {
  const saved = await store.get(["agentOptions", "agentHistory", "agentUiPrefs"]);
  if (saved.agentOptions) options = { ...options, ...saved.agentOptions };
  if (saved.agentUiPrefs) prefs = { ...prefs, ...saved.agentUiPrefs };
  if (Array.isArray(saved.agentHistory)) history = saved.agentHistory;

  applyTheme();
  setRail(false);
  applyOptions();
  renderHistory();
  resetTelemetry();
  setStage(-1);
  goPane(prefs.pane || "agent");
})();
