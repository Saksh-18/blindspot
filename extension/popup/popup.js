// popup.js

const runTaskBtn = document.getElementById("runTaskBtn");
const taskInput = document.getElementById("taskInput");
const taskStatus = document.getElementById("taskStatus");
const actionLog = document.getElementById("actionLog");

runTaskBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    taskStatus.textContent = "Enter a task first.";
    return;
  }

  runTaskBtn.disabled = true;
  taskStatus.textContent = "Running... (this can take a few seconds per step)";
  actionLog.innerHTML = "";

  try {
    // background.js owns the full loop: capture -> sanitize -> POST to
    // server -> get one AgentAction -> execute -> repeat until done.
    const result = await chrome.runtime.sendMessage({ type: "START_TASK", task });

    if (!result) {
      taskStatus.textContent = "No response from background script — check its console.";
      return;
    }

    if (result.error) {
      taskStatus.textContent = `Stopped after ${result.steps} step(s): ${result.error}`;
    } else {
      taskStatus.textContent = `Finished in ${result.steps} step(s).`;
    }
    actionLog.innerHTML = result.history
      .map(
        (a, i) =>
          `<div class="step"><b>${i + 1}. ${a.action}</b>` +
          (a.selector ? ` on <code>${escapeHtml(a.selector)}</code>` : "") +
          (a.text ? ` = "${escapeHtml(a.text)}"` : "") +
          `<br><i>${escapeHtml(a.reasoning || "")}</i></div>`
      )
      .join("");
  } catch (err) {
    taskStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    runTaskBtn.disabled = false;
  }
});

// --- Debug capture-only harness below (unchanged) ---

const btn = document.getElementById("captureBtn");
const status = document.getElementById("status");
const preview = document.getElementById("preview");
const domList = document.getElementById("domList");

btn.addEventListener("click", async () => {
  status.textContent = "Capturing...";
  domList.innerHTML = "";
  preview.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // content.js must already be injected on this page. It won't be on
    // chrome:// pages or the Chrome Web Store — try a normal http(s) page.
    const result = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_AND_SANITIZE" });

    if (!result || !result.redactedImageDataUrl) {
      status.textContent = "No result — check the service worker console for errors.";
      return;
    }

    preview.src = result.redactedImageDataUrl;
    preview.style.display = "block";

    status.textContent =
      `Captured. ${result.sanitizedDom.length} DOM elements found, ` +
      `${result.redactionReport.domFieldsRedacted} flagged sensitive, ` +
      `${result.redactionReport.textPiiRedacted} text-PII matches (OTP/receipt/card/etc), ` +
      `${result.redactionReport.visualRegionsRedacted} model-detected visual regions.`;

    domList.innerHTML = result.sanitizedDom
      .slice(0, 30)
      .map(
        (n) =>
          `<div class="${n.sensitive ? "sensitive" : ""}">${n.tag} ${n.selector}: "${escapeHtml(n.text)}"</div>`
      )
      .join("");
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    console.error(err);
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}