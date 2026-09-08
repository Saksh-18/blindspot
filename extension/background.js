// background.js
// Orchestrates the agent loop. Runs in the extension's service worker context
// (no DOM access here — DOM work happens in content.js).

const SERVER_URL = "http://localhost:8000/agent/step";

// Makes clicking the toolbar icon open the side panel (instead of doing
// nothing, now that there's no default_popup). The side panel stays open
// across page navigation and doesn't close on losing focus like a popup
// did — no more reloading the extension just to click it again.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

/**
 * One iteration of the loop:
 *  1. ask content.js for a sanitized DOM snapshot + trigger a screenshot capture
 *  2. run local redaction over the screenshot (delegated to content.js/vision module,
 *     since canvas work is easiest there)
 *  3. POST sanitized {image, dom} + task to the server
 *  4. get back one AgentAction (see shared/action_schema.json)
 *  5. tell content.js to execute it
 *  6. repeat until action.action === "done" (never trust task_complete alone —
 *     see the loop in the START_TASK handler below)
 */
async function runAgentStep(tabId, task, history = [], signal, options = {}) {
  const tTotalStart = performance.now();
  console.time("capture+sanitize (content script)");
  const capture = await chrome.tabs.sendMessage(tabId, {
    type: "CAPTURE_AND_SANITIZE",
    options,
  });
  console.timeEnd("capture+sanitize (content script)");
  if (!capture || capture.error || !capture.redactedImageDataUrl) {
    throw new Error(capture?.error || "capture+sanitize returned no image");
  }
  // capture = { redactedImageDataUrl, sanitizedDom, timings, redactionReport }
  console.log(`Sending ${capture.sanitizedDom.length} DOM elements, image ~${Math.round(capture.redactedImageDataUrl.length / 1024)}KB`);

  const tNetworkStart = performance.now();
  console.time("server round-trip (network + VLM inference)");
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      image: capture.redactedImageDataUrl,
      dom: capture.sanitizedDom,
      history,
    }),
    signal,
  });
  console.timeEnd("server round-trip (network + VLM inference)");
  const serverRoundTripMs = performance.now() - tNetworkStart;

  if (!response.ok) {
    let errMsg = `Server error ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson && errJson.detail) {
        errMsg += `: ${errJson.detail}`;
      }
    } catch (_) {}
    throw new Error(errMsg);
  }

  const action = await response.json(); // matches shared/action_schema.json

  let executeMs = 0;
  if (action.action !== "done" && action.action !== "wait" && action.action !== "ask_user") {
    const tExecStart = performance.now();
    const execResult = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_ACTION",
      action,
    });
    executeMs = performance.now() - tExecStart;
    // Attach what actually happened so the model sees it on the *next* turn —
    // it shouldn't be trusted to already know this about its own action.
    action.executionResult = execResult;
    if (!execResult.matched) {
      console.warn(`Selector not found on page: ${action.selector}`);
    }
  }

  const totalStepMs = performance.now() - tTotalStart;

  // Aggregate telemetry timings
  const telemetry = {
    sanitizeDomMs: capture.timings?.sanitizeDomMs || 0,
    findTextPiiMs: capture.timings?.findTextPiiMs || 0,
    captureVisibleTabMs: capture.timings?.captureVisibleTabMs || 0,
    detectSensitiveRegionsMs: capture.timings?.detectSensitiveRegionsMs || 0,
    redactImageMs: capture.timings?.redactImageMs || 0,
    serverRoundTripMs,
    executeMs,
    totalStepMs,
    redactedBoxes: capture.redactedBoxes || [],
    redactionReport: capture.redactionReport || {}
  };

  console.log("Step Telemetry Data:", telemetry);

  // Send to eval telemetry endpoint on server
  const evalUrl = SERVER_URL.replace("/agent/step", "") + "/eval/telemetry";
  fetch(evalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(telemetry),
  }).catch((e) => console.warn("Failed to POST telemetry payload:", e));

  action.telemetry = telemetry;
  return action;
}

let taskAborted = false;
// Aborts whatever fetch is currently in flight (the VLM round-trip is the
// longest single wait in a step) so STOP_TASK takes effect immediately
// instead of only being checked between steps.
let currentAbortController = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CAPTURE_TAB") {
    // Only the background/service-worker context can capture a screenshot,
    // so content.js asks us for it. sender.tab is the page that asked.
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error("captureVisibleTab failed:", chrome.runtime.lastError.message);
        sendResponse(null);
        return;
      }
      sendResponse(dataUrl);
    });
    return true; // async response
  }

  if (msg.type === "STOP_TASK") {
    taskAborted = true;
    currentAbortController?.abort();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "START_TASK") {
    taskAborted = false;
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let history = [];
      let action;
      let steps = 0;
      let lastAskUserSelector = null;
      const MAX_STEPS = 15; // safety cap

      // Free win before spending a single token: fill whatever standard
      // autocomplete-tagged fields (email, tel, street-address, ...) match
      // the stored profile, entirely client-side. Whatever's left for the
      // VLM to figure out shrinks accordingly.
      try {
        const autofillResult = await chrome.tabs.sendMessage(tab.id, { type: "AUTOFILL_STANDARD_FIELDS" });
        if (autofillResult?.filled) {
          console.log(`Instant autofill: ${autofillResult.filled} standard field(s) filled from profile`);
        }
      } catch (err) {
        console.warn("Instant autofill pass failed (continuing without it):", err);
      }

      try {
        do {
          if (taskAborted) {
            sendResponse({ done: false, stopped: true, steps, history });
            return;
          }

          // Let the side panel know a step is starting — it stays open for
          // the whole loop, so it can show live progress instead of one
          // blank "Running..." for however long the whole task takes.
          chrome.runtime.sendMessage({ type: "STEP_STARTED", step: steps + 1 }).catch(() => {});

          currentAbortController = new AbortController();
          action = await runAgentStep(tab.id, msg.task, history, currentAbortController.signal, msg.options);
          currentAbortController = null;
          history.push(action);
          steps++;

          chrome.runtime.sendMessage({ type: "STEP_FINISHED", step: steps, action }).catch(() => {});

          // ask_user isn't executed and isn't "done", so without a check
          // here the loop just re-asks the model next step with the same
          // screenshot+DOM — nothing forces it to move on, and it can spend
          // every remaining step (and the tokens with it) re-flagging the
          // exact same sensitive field. One repeat on the same selector is
          // enough to know it's stuck, not reconsidering.
          if (action.action === "ask_user") {
            if (lastAskUserSelector === (action.selector || null)) {
              sendResponse({ done: false, needsUserInput: true, steps, history, action });
              return;
            }
            lastAskUserSelector = action.selector || null;
          } else {
            lastAskUserSelector = null;
          }

          // IMPORTANT: we only stop on action === "done" — a click/type
          // response claiming task_complete: true in the SAME turn it
          // performed the action is not trusted, since the model hasn't
          // actually seen the result of its own action yet. It gets one
          // more round-trip (fresh screenshot + DOM) to confirm before it
          // can legitimately say "done".
        } while (action.action !== "done" && steps < MAX_STEPS);

        sendResponse({ done: true, steps, history });
      } catch (err) {
        currentAbortController = null;
        if (err.name === "AbortError" || taskAborted) {
          sendResponse({ done: false, stopped: true, steps, history });
          return;
        }
        console.error("Agent loop failed:", err);
        sendResponse({ done: false, error: err.message, steps, history });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});