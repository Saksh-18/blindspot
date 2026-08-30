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

// Patterns for PII that shows up as plain rendered TEXT rather than a form
// field — an OTP printed in a <span>, a receipt/order number in a table,
// a card number in a confirmation screen, etc. These run against every text
// node on the page, not just inputs.
const TEXT_PII_PATTERNS = [
  { type: "otp", regex: /\b(?:otp|one[- ]?time (?:password|code)|verification code)\b[^0-9]{0,20}(\d{4,8})\b/i },
  { type: "otp_bare", regex: /\b\d{4,8}\b(?=[^<]{0,25}\b(?:otp|verification|one[- ]?time)\b)/i },
  { type: "receipt_no", regex: /\b(?:receipt|invoice|order|txn|transaction)[\s#:.-]*(?:no\.?|number|id)?[\s#:.-]*[A-Z0-9-]{5,}/i },
  { type: "card_number", regex: /\b(?:\d[ -]?){13,19}\b/ },
  { type: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/ },
];

/**
 * Walks visible text nodes on the page (skipping script/style) and finds
 * ones matching a PII pattern. Returns both the masked replacement text
 * (for the DOM JSON sent to the server) and the bounding box of the
 * containing element (so the same region can be blacked out on the actual
 * screenshot — DOM redaction alone doesn't touch the rendered pixels).
 */
function findTextPii() {
  const matches = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentTag = node.parentElement?.tagName;
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parentTag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    for (const { type, regex } of TEXT_PII_PATTERNS) {
      const match = node.nodeValue.match(regex);
      if (match) {
        const rect = node.parentElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        matches.push({
          type,
          matchedText: match[0],
          box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
        break; // one match per node is enough to flag + redact it
      }
    }
  }
  return matches;
}

/**
 * Masks any substring of `text` that matches a known PII pattern.
 * Shared by sanitizeDom() (interactive elements) and used to keep the two
 * text-scanning paths consistent.
 */
function maskPiiInText(text) {
  let masked = text;
  let hit = false;
  for (const { type, regex } of TEXT_PII_PATTERNS) {
    if (regex.test(masked)) {
      hit = true;
      masked = masked.replace(new RegExp(regex.source, regex.flags.replace("g", "") + "g"), `[REDACTED_${type.toUpperCase()}]`);
    }
  }
  return { masked, hit };
}

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

    const rawText = (el.innerText || el.value || "").slice(0, 80);
    const { masked, hit } = maskPiiInText(rawText);

    const isSensitive =
      SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
      SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
      SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
      hit;

    const selector = el.id ? `#${el.id}` : `[data-agent-idx="${i}"]`;
    if (!el.id) el.setAttribute("data-agent-idx", i);

    nodes.push({
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: isSensitive ? (hit ? masked : "[REDACTED]") : rawText,
      box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      sensitive: isSensitive,
    });
  });
  return nodes;
}

async function captureAndSanitize() {
  const dom = sanitizeDom();
  const textPiiMatches = findTextPii(); // OTPs, receipt/order numbers, card numbers, SSNs in plain text

  // Screenshot capture requires chrome.tabs.captureVisibleTab, which only
  // works from the background/service-worker context — so we request the
  // raw screenshot from background.js, then run local vision redaction here.
  const { detectSensitiveRegions } = await import(chrome.runtime.getURL("vision/detector.js"));
  const { redactImage } = await import(chrome.runtime.getURL("vision/redact.js"));

  const rawImageDataUrl = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });

  // Model-based regions (faces, PII in genuine image content — currently a
  // stub) PLUS the boxes we just found by scanning text nodes. The text-node
  // pass covers most real-world OTP/receipt/order-number cases since they're
  // actually rendered as DOM text, not baked into an image.
  const modelRegions = await detectSensitiveRegions(rawImageDataUrl);
  const textRegions = textPiiMatches.map((m) => m.box);
  const regions = [...modelRegions, ...textRegions];

  const redactedImageDataUrl = await redactImage(rawImageDataUrl, regions);

  return {
    redactedImageDataUrl,
    sanitizedDom: dom,
    redactionReport: {
      domFieldsRedacted: dom.filter((n) => n.sensitive).length,
      textPiiRedacted: textPiiMatches.length,
      visualRegionsRedacted: modelRegions.length,
    },
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