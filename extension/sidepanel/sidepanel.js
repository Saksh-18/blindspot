// sidepanel.js
// Handles tab navigation, pipeline state controls, metric dashboard updates, and history tracking.

const runTaskBtn = document.getElementById("runTaskBtn");
const stopBtn = document.getElementById("stopBtn");
const taskInput = document.getElementById("taskInput");
const statusLine = document.getElementById("statusLine");
const log = document.getElementById("log");
const emptyState = document.getElementById("emptyState");

// Tabs Selection Elements
const tabRunBtn = document.getElementById("tabRunBtn");
const tabPipelineBtn = document.getElementById("tabPipelineBtn");
const tabHistoryBtn = document.getElementById("tabHistoryBtn");

const tabContentRun = document.getElementById("tabContentRun");
const tabContentPipeline = document.getElementById("tabContentPipeline");
const tabContentHistory = document.getElementById("tabContentHistory");

// Configuration State Toggles
const redactSolidBtn = document.getElementById("redactSolidBtn");
const redactBlurBtn = document.getElementById("redactBlurBtn");
const toggleModel = document.getElementById("toggleModel");
const toggleDom = document.getElementById("toggleDom");

// Live Telemetry Elements
const metricModelTime = document.getElementById("metricModelTime");
const metricDomTime = document.getElementById("metricDomTime");
const metricVlmTime = document.getElementById("metricVlmTime");
const metricTotalTime = document.getElementById("metricTotalTime");
const statFacesCount = document.getElementById("statFacesCount");
const statDomFieldsCount = document.getElementById("statDomFieldsCount");

// Options Configuration
let options = {
  redactionMode: "blackout",
  runModel: true,
  runDom: true
};

// --- Tab Switching Logic ---
const tabs = [
  { btn: tabRunBtn, content: tabContentRun },
  { btn: tabPipelineBtn, content: tabContentPipeline },
  { btn: tabHistoryBtn, content: tabContentHistory }
];

tabs.forEach(t => {
  t.btn.addEventListener("click", () => {
    tabs.forEach(x => {
      x.btn.classList.remove("active");
      x.content.classList.remove("active");
    });
    t.btn.classList.add("active");
    t.content.classList.add("active");
  });
});

// --- Pipeline Settings Handlers ---
redactSolidBtn.addEventListener("click", () => {
  options.redactionMode = "blackout";
  redactSolidBtn.classList.add("active");
  redactBlurBtn.classList.remove("active");
  saveOptions();
});

redactBlurBtn.addEventListener("click", () => {
  options.redactionMode = "blur";
  redactBlurBtn.classList.add("active");
  redactSolidBtn.classList.remove("active");
  saveOptions();
});

toggleModel.addEventListener("change", () => {
  options.runModel = toggleModel.checked;
  saveOptions();
});

toggleDom.addEventListener("change", () => {
  options.runDom = toggleDom.checked;
  saveOptions();
});

function saveOptions() {
  chrome.storage.local.set({ agentOptions: options }).catch(console.warn);
}

function loadOptions() {
  chrome.storage.local.get("agentOptions", (res) => {
    if (res && res.agentOptions) {
      options = { ...options, ...res.agentOptions };
      // Sync UI components
      if (options.redactionMode === "blur") {
        redactBlurBtn.classList.add("active");
        redactSolidBtn.classList.remove("active");
      } else {
        redactSolidBtn.classList.add("active");
        redactBlurBtn.classList.remove("active");
      }
      toggleModel.checked = options.runModel;
      toggleDom.checked = options.runDom;
    }
  });
}
loadOptions();

// --- Suggestion Chips Handler ---
document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    taskInput.value = chip.getAttribute("data-task");
    tabRunBtn.click(); // Auto navigate to agent run pane
  });
});

// --- History Tracker ---
let sessionHistory = [];

const historyList = document.getElementById("historyList");

function saveToHistory(task, steps, success) {
  const item = {
    id: Date.now(),
    task,
    steps,
    success,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  sessionHistory.unshift(item);
  chrome.storage.local.set({ agentHistory: sessionHistory }).catch(console.warn);
  renderHistory();
}

function renderHistory() {
  if (sessionHistory.length === 0) {
    historyList.innerHTML = `
      <div class="empty-state" style="margin-top: 10px;">
        <div class="empty-text">No runs in this session yet. Completed tasks will show up here.</div>
      </div>`;
    return;
  }

  historyList.innerHTML = sessionHistory.map(item => `
    <div class="history-card" data-task="${escapeHtml(item.task)}">
      <div class="history-task-text">${escapeHtml(item.task)}</div>
      <div class="history-meta">
        <span>🕒 ${item.timestamp}</span>
        <span style="color: ${item.success ? 'var(--accent-teal)' : 'var(--danger)'}">
          ${item.success ? '✓ Completed' : '✗ Stopped'} (${item.steps} steps)
        </span>
      </div>
    </div>
  `).join("");

  // Add click listener to cards to load tasks
  historyList.querySelectorAll(".history-card").forEach(card => {
    card.addEventListener("click", () => {
      taskInput.value = card.getAttribute("data-task");
      tabRunBtn.click();
    });
  });
}

function loadHistory() {
  chrome.storage.local.get("agentHistory", (res) => {
    if (res && res.agentHistory) {
      sessionHistory = res.agentHistory;
      renderHistory();
    }
  });
}
loadHistory();

// --- Agent Execution Control ---
runTaskBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    statusLine.textContent = "Enter a task first.";
    return;
  }

  runTaskBtn.disabled = true;
  stopBtn.style.display = "flex";
  statusLine.innerHTML = '<span class="spinner"></span> Working...';
  
  // Clear log and empty state
  log.innerHTML = `<div class="step-timeline" id="timeline"></div>`;
  emptyState.style.display = "none";

  // Reset telemetry display
  resetTelemetry();

  try {
    const result = await chrome.runtime.sendMessage({
      type: "START_TASK",
      task,
      options
    });

    if (!result) {
      statusLine.textContent = "No response from background script — check its console.";
      saveToHistory(task, 0, false);
    } else if (result.stopped) {
      statusLine.textContent = `Stopped by you after ${result.steps} step(s).`;
      saveToHistory(task, result.steps, false);
    } else if (result.error) {
      statusLine.textContent = `Stopped after ${result.steps} step(s): ${result.error}`;
      saveToHistory(task, result.steps, false);
    } else {
      statusLine.textContent = `Finished in ${result.steps} step(s).`;
      saveToHistory(task, result.steps, true);
    }
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
    console.error(err);
    saveToHistory(task, 0, false);
  } finally {
    runTaskBtn.disabled = false;
    stopBtn.style.display = "none";
  }
});

stopBtn.addEventListener("click", async () => {
  statusLine.innerHTML = '<span class="spinner"></span> Stopping after current step...';
  await chrome.runtime.sendMessage({ type: "STOP_TASK" });
});

// Reset Telemetry display
function resetTelemetry() {
  metricModelTime.childNodes[0].textContent = "-";
  metricDomTime.childNodes[0].textContent = "-";
  metricVlmTime.childNodes[0].textContent = "-";
  metricTotalTime.childNodes[0].textContent = "-";
  statFacesCount.textContent = "0";
  statDomFieldsCount.textContent = "0";
}

// Update Dashboard timings
function updateTelemetryDashboard(telemetry) {
  if (!telemetry) return;
  metricModelTime.childNodes[0].textContent = Math.round(telemetry.detectSensitiveRegionsMs);
  metricDomTime.childNodes[0].textContent = Math.round(telemetry.sanitizeDomMs + telemetry.findTextPiiMs);
  metricVlmTime.childNodes[0].textContent = Math.round(telemetry.serverRoundTripMs);
  metricTotalTime.childNodes[0].textContent = Math.round(telemetry.totalStepMs);
  
  const faceCount = telemetry.redactedBoxes.filter(b => b.type === "face").length;
  const domCount = telemetry.redactedBoxes.filter(b => b.type !== "face").length;
  
  statFacesCount.textContent = faceCount;
  statDomFieldsCount.textContent = domCount;
}

// Listen to step events
chrome.runtime.onMessage.addListener((msg) => {
  const timeline = document.getElementById("timeline");
  if (!timeline) return;

  if (msg.type === "STEP_STARTED") {
    statusLine.innerHTML = `<span class="spinner"></span> Step ${msg.step} running...`;
    
    const div = document.createElement("div");
    div.className = "step pending";
    div.id = `step-${msg.step}`;
    div.innerHTML = `
      <div class="step-header">
        <span class="step-action-badge">Step ${msg.step}</span>
        <span class="spinner"></span>
      </div>
      <div class="step-reasoning">Running local anonymizer and analyzing layout...</div>
    `;
    timeline.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  if (msg.type === "STEP_FINISHED") {
    const div = document.getElementById(`step-${msg.step}`);
    if (!div) return;
    const a = msg.action;
    div.className = `step action-${a.action}`;

    const execResult = a.executionResult;
    let execLine = "";
    if (execResult) {
      execLine = execResult.matched
        ? '<div class="step-exec exec-ok">✓ executed successfully</div>'
        : `<div class="step-exec exec-fail">✗ execution failed: ${escapeHtml(execResult.reason || "unknown")}</div>`;
    }
    
    div.innerHTML = `
      <div class="step-header">
        <span class="step-action-badge">${a.action}</span>
        <span class="step-number">Step ${msg.step}</span>
      </div>
      ${a.selector ? `<div class="step-selector">Element: <code>${escapeHtml(a.selector)}</code></div>` : ""}
      ${a.text ? `<div class="step-selector">Input content: "${escapeHtml(a.text)}"</div>` : ""}
      <div class="step-reasoning">${escapeHtml(a.reasoning || "Reasoning not provided.")}</div>
      ${execLine}
    `;
    log.scrollTop = log.scrollHeight;

    // Update the live metrics timing panel!
    updateTelemetryDashboard(a.telemetry);
  }
});

// --- Debug capture-only harness ---
const debugBtn = document.getElementById("captureBtn");
const debugStatus = document.getElementById("debugStatus");
const debugPreview = document.getElementById("debugPreview");
const debugDomList = document.getElementById("debugDomList");

debugBtn.addEventListener("click", async () => {
  debugStatus.innerHTML = '<span class="spinner"></span> Capturing and redacting...';
  debugDomList.innerHTML = "";
  debugPreview.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Pass user options
    const result = await chrome.tabs.sendMessage(tab.id, { 
      type: "CAPTURE_AND_SANITIZE", 
      options 
    });

    if (result && result.error) {
      debugStatus.textContent = `Error: ${result.error}`;
      return;
    }
    if (!result || !result.redactedImageDataUrl) {
      debugStatus.textContent = "No result — check console logs.";
      return;
    }

    debugPreview.src = result.redactedImageDataUrl;
    debugPreview.style.display = "block";

    debugStatus.textContent =
      `Done. ${result.sanitizedDom.length} DOM elements, ` +
      `${result.redactionReport.domFieldsRedacted} masked HTML inputs, ` +
      `${result.redactionReport.textPiiRedacted} OTP/text PII matches, ` +
      `${result.redactionReport.visualRegionsRedacted} faces redacted.`;

    debugDomList.innerHTML = result.sanitizedDom
      .slice(0, 30)
      .map(
        (n) =>
          `<div class="${n.sensitive ? "sensitive" : ""}">${n.tag} ${n.selector}: "${escapeHtml(n.text)}"</div>`
      )
      .join("");
  } catch (err) {
    debugStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}