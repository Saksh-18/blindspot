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
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const parentTag = parent.tagName;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parentTag)) return NodeFilter.FILTER_REJECT;

      const val = node.nodeValue;
      if (!val || !val.trim()) return NodeFilter.FILTER_REJECT;

      // Cheap regex pre-filtering before layout/computed-style reading
      let hasPiiMatch = false;
      for (const { regex } of TEXT_PII_PATTERNS) {
        if (regex.test(val)) {
          hasPiiMatch = true;
          break;
        }
      }
      if (!hasPiiMatch) return NodeFilter.FILTER_REJECT;

      // Check visibility/rendering only on potential PII matches
      if (parent.offsetParent === null && getComputedStyle(parent).position !== "fixed") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const val = node.nodeValue;
    for (const { type, regex } of TEXT_PII_PATTERNS) {
      const match = val.match(regex);
      if (match) {
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        // Only regions actually visible in the current viewport matter
        if (!isInViewport(rect)) continue;
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

function isInViewport(rect) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
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
  const MAX_NODES = 150; // hard cap — past this the prompt gets huge and slow for no benefit
  const nodes = [];
  const candidates = document.querySelectorAll("button, a, input, select, textarea, [role]");
  const elementsToIndex = [];

  for (let i = 0; i < candidates.length && nodes.length < MAX_NODES; i++) {
    const el = candidates[i];
    const rect = el.getBoundingClientRect();
    // Only elements actually visible in the current viewport
    if (!isInViewport(rect)) continue;

    const rawText = (el.innerText || el.value || "").slice(0, 80);
    const { masked, hit } = maskPiiInText(rawText);

    const isSensitive =
      SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
      SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
      SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
      hit;

    const selector = el.id ? `#${el.id}` : `[data-agent-idx="${i}"]`;
    if (!el.id) {
      elementsToIndex.push({ el, idx: i });
    }

    nodes.push({
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: isSensitive ? (hit ? masked : "[REDACTED]") : rawText,
      box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      sensitive: isSensitive,
    });
  }

  // Defer writing attributes to avoid layout thrashing while reading bounds
  for (const { el, idx } of elementsToIndex) {
    el.setAttribute("data-agent-idx", idx);
  }

  return nodes;
}

async function captureAndSanitize() {
  const timings = {};

  const t0 = performance.now();
  const dom = sanitizeDom();
  timings.sanitizeDomMs = performance.now() - t0;

  const t1 = performance.now();
  const textPiiMatches = findTextPii(); // OTPs, receipt/order numbers, card numbers, SSNs in plain text
  timings.findTextPiiMs = performance.now() - t1;

  // Screenshot capture requires chrome.tabs.captureVisibleTab, which only
  // works from the background/service-worker context — so we request the
  // raw screenshot from background.js, then run local vision redaction here.
  const { detectSensitiveRegions } = await import(chrome.runtime.getURL("vision/detector.js"));
  const { redactImage } = await import(chrome.runtime.getURL("vision/redact.js"));

  const t2 = performance.now();
  const rawImageDataUrl = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
  timings.captureVisibleTabMs = performance.now() - t2;
  if (!rawImageDataUrl) {
    throw new Error(
      "Tab capture failed — on a file:// page this usually means " +
        '"Allow access to file URLs" is off for this extension (chrome://extensions).'
    );
  }

  // Model-based regions (faces, PII in genuine image content) PLUS the boxes we just
  // found by scanning text nodes.
  const t3 = performance.now();
  const modelRegions = await detectSensitiveRegions(rawImageDataUrl);
  timings.detectSensitiveRegionsMs = performance.now() - t3;

  const textRegions = textPiiMatches.map((m) => m.box);
  const regions = [...modelRegions, ...textRegions];

  const t4 = performance.now();
  const redactedImageDataUrl = await redactImage(rawImageDataUrl, regions);
  timings.redactImageMs = performance.now() - t4;

  console.log(`sanitizeDom returned ${dom.length} elements (capped at 150)`);

  return {
    redactedImageDataUrl,
    sanitizedDom: dom,
    timings,
    redactedBoxes: [
      ...modelRegions.map(r => ({ type: "face", box: { x: r.x, y: r.y, w: r.w, h: r.h } })),
      ...textPiiMatches.map(m => ({ type: m.type, box: m.box }))
    ],
    redactionReport: {
      domFieldsRedacted: dom.filter((n) => n.sensitive).length,
      textPiiRedacted: textPiiMatches.length,
      visualRegionsRedacted: modelRegions.length,
    },
  };
}

/**
 * Performs the action and reports back whether the target element was
 * actually found — without this, a wrong/stale selector fails silently and
 * the loop has no way to know the click never happened.
 */
function executeAction(action) {
  if (action.action === "click") {
    const el = document.querySelector(action.selector);
    if (!el) return { matched: false, reason: "not_found" };
    if (el.disabled) return { matched: false, reason: "disabled" };
    el.click();
    return { matched: true };
  }
  if (action.action === "type") {
    return typeIntoElement(action.selector, action.text);
  }
  if (action.action === "scroll") {
    window.scrollBy(0, action.scroll_direction === "down" ? action.scroll_amount_px : -action.scroll_amount_px);
    return { matched: true };
  }
  // "wait" / "done" / "ask_user" are no-ops at the DOM level.
  return { matched: true };
}

/**
 * Handles the "type" action across the real variety of form fields a page
 * can have: plain inputs/textareas, React/Vue-controlled inputs (need the
 * native value setter, or the framework never sees the change), <select>
 * dropdowns, and contenteditable elements.
 */
function typeIntoElement(selector, text) {
  const el = document.querySelector(selector);
  if (!el) return { matched: false, reason: "not_found" };
  if (el.disabled || el.readOnly) return { matched: false, reason: "disabled_or_readonly" };

  // The server never saw this field's real content (it was redacted before
  // anything left the browser), so any text the model wants to type here is
  // a guess, not a legitimate value — e.g. it cannot actually know the
  // user's real password. Block it rather than let a hallucinated value
  // land in a sensitive field.
  const isSensitiveField =
    SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
    SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
    SENSITIVE_KEYWORD_REGEX.test(el.name || "");
  if (isSensitiveField) {
    return { matched: false, reason: "blocked_sensitive_field" };
  }

  el.focus();

  if (el.tagName === "SELECT") {
    const opt = Array.from(el.options).find(
      (o) => o.value === text || o.textContent.trim().toLowerCase() === text.trim().toLowerCase()
    );
    if (!opt) return { matched: false, reason: "option_not_found" };
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { matched: true };
  }

  if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return { matched: true };
  }

  if ("value" in el) {
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { matched: true };
  }

  return { matched: false, reason: "unsupported_element" };
}

/**
 * React (and some other frameworks) track input values through a custom
 * property descriptor installed on the native input/textarea prototype.
 * Setting `el.value = x` directly bypasses that tracker — the field LOOKS
 * updated on screen, but React's internal state never changes, so
 * validation and form submission silently break. Calling the native
 * setter explicitly makes React's own change-tracking fire correctly.
 */
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CAPTURE_AND_SANITIZE") {
    captureAndSanitize()
      .then(sendResponse)
      .catch((err) => {
        console.error("captureAndSanitize failed:", err);
        sendResponse({ error: err.message });
      });
    return true;
  }
  if (msg.type === "EXECUTE_ACTION") {
    const result = executeAction(msg.action);
    sendResponse(result);
  }
});