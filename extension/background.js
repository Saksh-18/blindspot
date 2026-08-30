// background.js
// Orchestrates the agent loop. Runs in the extension's service worker context
// (no DOM access here — DOM work happens in content.js).

const SERVER_URL = "http://localhost:8000/agent/step";

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
async function runAgentStep(tabId, task, history = []) {
  const capture = await chrome.tabs.sendMessage(tabId, {
    type: "CAPTURE_AND_SANITIZE",
  });
  // capture = { redactedImageDataUrl, sanitizedDom, redactionReport }

  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      image: capture.redactedImageDataUrl,
      dom: capture.sanitizedDom,
      history,
    }),
  });

  if (!response.ok) {
    throw new Error(`Server error ${response.status}`);
  }

  const action = await response.json(); // matches shared/action_schema.json

  if (action.action !== "done" && action.action !== "wait" && action.action !== "ask_user") {
    const execResult = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_ACTION",
      action,
    });
    // Attach what actually happened so the model sees it on the *next* turn —
    // it shouldn't be trusted to already know this about its own action.
    action.executionResult = execResult;
    if (!execResult.matched) {
      console.warn(`Selector not found on page: ${action.selector}`);
    }
  }

  return action;
}

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

  if (msg.type === "START_TASK") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let history = [];
      let action;
      let steps = 0;
      const MAX_STEPS = 15; // safety cap

      try {
        do {
          action = await runAgentStep(tab.id, msg.task, history);
          history.push(action);
          steps++;
          // IMPORTANT: we only stop on action === "done" — a click/type
          // response claiming task_complete: true in the SAME turn it
          // performed the action is not trusted, since the model hasn't
          // actually seen the result of its own action yet. It gets one
          // more round-trip (fresh screenshot + DOM) to confirm before it
          // can legitimately say "done".
        } while (action.action !== "done" && steps < MAX_STEPS);

        sendResponse({ done: true, steps, history });
      } catch (err) {
        console.error("Agent loop failed:", err);
        sendResponse({ done: false, error: err.message, steps, history });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});