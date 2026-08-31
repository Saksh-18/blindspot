// sidepanel.js
// Unlike the old popup, this stays open for the whole task — so we stream
// progress step-by-step via chrome.runtime messages from background.js,
// instead of blocking silently until the entire loop finishes.

const runTaskBtn = document.getElementById("runTaskBtn");
const stopBtn = document.getElementById("stopBtn");
const taskInput = document.getElementById("taskInput");
const statusLine = document.getElementById("statusLine");
const log = document.getElementById("log");
const emptyState = document.getElementById("emptyState");

runTaskBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    statusLine.textContent = "Enter a task first.";
    return;
  }

  runTaskBtn.disabled = true;
  stopBtn.style.display = "flex";
  statusLine.innerHTML = '<span class="spinner"></span> Starting...';
  log.innerHTML = "";

  try {
    // background.js owns the full loop: capture -> sanitize -> POST to
    // server -> get one AgentAction -> execute -> repeat until done.
    // Progress arrives via STEP_STARTED / STEP_FINISHED messages below;
    // this only resolves once the whole loop is over.
    const result = await chrome.runtime.sendMessage({ type: "START_TASK", task });

    if (!result) {
      statusLine.textContent = "No response from background script — check its console.";
    } else if (result.stopped) {
      statusLine.textContent = `Stopped by you after ${result.steps} step(s).`;
    } else if (result.error) {
      statusLine.textContent = `Stopped after ${result.steps} step(s): ${result.error}`;
    } else {
      statusLine.textContent = `Finished in ${result.steps} step(s).`;
    }
  } catch (err) {
    statusLine.textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    runTaskBtn.disabled = false;
    stopBtn.style.display = "none";
  }
});

stopBtn.addEventListener("click", async () => {
  statusLine.innerHTML = '<span class="spinner"></span> Stopping after current step...';
  await chrome.runtime.sendMessage({ type: "STOP_TASK" });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STEP_STARTED") {
    emptyState.style.display = "none";
    statusLine.innerHTML = `<span class="spinner"></span> Step ${msg.step} running...`;
    const div = document.createElement("div");
    div.className = "step pending";
    div.id = `step-${msg.step}`;
    div.innerHTML = `<div class="step-header"><span><span class="step-num">${msg.step}</span>Working...</span><span class="spinner"></span></div>`;
    log.appendChild(div);
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
        ? '<div class="step-exec exec-ok">&#x2713; executed</div>'
        : `<div class="step-exec exec-fail">&#x2717; failed: ${escapeHtml(execResult.reason || "unknown")}</div>`;
    }
    div.innerHTML =
      `<div class="step-header"><span><span class="step-num">${msg.step}</span>${escapeHtml(a.action)}</span></div>` +
      (a.selector ? `<div class="step-selector">on <code>${escapeHtml(a.selector)}</code></div>` : "") +
      (a.text ? `<div class="step-selector">text: "${escapeHtml(a.text)}"</div>` : "") +
      `<div class="step-reasoning">${escapeHtml(a.reasoning || "")}</div>` +
      execLine;
    log.scrollTop = log.scrollHeight;
  }
});

// --- Debug capture-only harness ---

const debugBtn = document.getElementById("captureBtn");
const debugStatus = document.getElementById("debugStatus");
const debugPreview = document.getElementById("debugPreview");
const debugDomList = document.getElementById("debugDomList");

debugBtn.addEventListener("click", async () => {
  debugStatus.textContent = "Capturing...";
  debugDomList.innerHTML = "";
  debugPreview.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_AND_SANITIZE" });

    if (result && result.error) {
      debugStatus.textContent = `Error: ${result.error}`;
      return;
    }
    if (!result || !result.redactedImageDataUrl) {
      debugStatus.textContent = "No result — check the service worker console for errors.";
      return;
    }

    debugPreview.src = result.redactedImageDataUrl;
    debugPreview.style.display = "block";

    debugStatus.textContent =
      `Captured. ${result.sanitizedDom.length} DOM elements, ` +
      `${result.redactionReport.domFieldsRedacted} flagged sensitive, ` +
      `${result.redactionReport.textPiiRedacted} text-PII matches, ` +
      `${result.redactionReport.visualRegionsRedacted} model-detected regions.`;

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