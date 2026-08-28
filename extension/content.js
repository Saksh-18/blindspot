// content.js
// Runs in the page context. Owns two responsibilities:
//   1. DOM-level PII heuristics (fast, no ML) — see sanitizeDom()
//   2. Executing actions the server sends back
// Actual screenshot capture + local vision redaction is delegated to
// vision/detector.js and vision/redact.js (imported dynamically below).

const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete*="cc-"]',
  'input[type="email"]',
  'input[autocomplete="email"]',
  '[data-sensitive]',
];

const SENSITIVE_KEYWORD_REGEX = /ssn|social security|credit card|cvv|password|otp/i;

/**
 * Walks the DOM, strips/replaces text and attribute values that look
 * sensitive, and returns a lightweight structural snapshot (tag, role,
 * bounding box, id/selector) for the server to reason over.
 * This intentionally never sends innerText of matched elements.
 */
function sanitizeDom() {
  const nodes = [];
  document.querySelectorAll("button, a, input, select, textarea, [role]").forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const isSensitive =
      SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
      SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
      SENSITIVE_KEYWORD_REGEX.test(el.name || "");

    const selector = el.id ? `#${el.id}` : `[data-agent-idx="${i}"]`;
    if (!el.id) el.setAttribute("data-agent-idx", i);

    nodes.push({
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: isSensitive ? "[REDACTED]" : (el.innerText || el.value || "").slice(0, 80),
      box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      sensitive: isSensitive,
    });
  });
  return nodes;
}

async function captureAndSanitize() {
  const dom = sanitizeDom();
  // Screenshot capture requires chrome.tabs.captureVisibleTab, which only
  // works from the background/service-worker context — so we request the
  // raw screenshot from background.js, then run local vision redaction here.
  const { detectSensitiveRegions } = await import(chrome.runtime.getURL("vision/detector.js"));
  const { redactImage } = await import(chrome.runtime.getURL("vision/redact.js"));

  const rawImageDataUrl = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
  const regions = await detectSensitiveRegions(rawImageDataUrl); // faces, on-screen PII text, etc.
  const redactedImageDataUrl = await redactImage(rawImageDataUrl, regions);

  return {
    redactedImageDataUrl,
    sanitizedDom: dom,
    redactionReport: { domFieldsRedacted: dom.filter((n) => n.sensitive).length, visualRegionsRedacted: regions.length },
  };
}

function executeAction(action) {
  if (action.action === "click") {
    document.querySelector(action.selector)?.click();
  } else if (action.action === "type") {
    const el = document.querySelector(action.selector);
    if (el) {
      el.value = action.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } else if (action.action === "scroll") {
    window.scrollBy(0, action.scroll_direction === "down" ? action.scroll_amount_px : -action.scroll_amount_px);
  }
  // "wait" / "done" / "ask_user" are no-ops at the DOM level.
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CAPTURE_AND_SANITIZE") {
    captureAndSanitize().then(sendResponse);
    return true;
  }
  if (msg.type === "EXECUTE_ACTION") {
    executeAction(msg.action);
    sendResponse({ ok: true });
  }
});
