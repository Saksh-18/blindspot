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

const SENSITIVE_KEYWORD_REGEX =
  /ssn|social security|national insurance\b|credit card|debit card|\bcvv\b|password|\botp\b|passcode|security code|aadhaar|\bpan\b|passport|driving licen[cs]e|voter id|ration card|account number|routing number|\bifsc\b|\bswift\b|\biban\b|\bupi\b|bank(?:\s|$)|salary|policy number|insurance|medical record|diagnosis|prescription|employee id|mobile|phone|contact number|date of birth|\bdob\b|(?:home|current|residential|street) address|pincode|postal code|\bzip\b/i;

/**
 * Field purpose is usually declared through a separate <label> element, not
 * aria-label/name — "Mobile(10 Digits)", "Date of Birth", "Current Address"
 * are all plain <label> text on real forms. Checking only aria-label/name
 * (as this used to) misses the vast majority of real-world labeled fields.
 */
function getFieldLabelText(el) {
  let text = "";
  if (el.id && window.CSS && CSS.escape) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) text += " " + (label.textContent || "");
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) text += " " + (wrappingLabel.textContent || "");
  if (el.placeholder) text += " " + el.placeholder;
  return text;
}

// Only actual interactive widget roles — NOT layout/landmark roles like
// "main", "grid", "list", "navigation". A real app (Gmail, etc.) wraps huge
// chunks of the page in those, and testing a landmark's full aggregated
// innerText against the PII patterns flags — and blacks out — the entire
// container the moment any match appears anywhere inside it.
const INTERACTIVE_ROLES = [
  "button", "checkbox", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "switch", "tab", "textbox", "combobox", "searchbox",
  "slider", "spinbutton",
];

// Patterns for PII that shows up as plain rendered TEXT rather than a form
// field — an OTP printed in a <span>, a receipt/order number in a table,
// a card number in a confirmation screen, etc. These run against every text
// node on the page, not just inputs.
const TEXT_PII_PATTERNS = [
  // Catches "your OTP is 123456" — keyword and digits in the SAME text node.
  { type: "otp", regex: /\b(?:otp|one[- ]?time (?:password|code)|verification code)\b[^0-9]{0,20}(\d{4,8})\b/i },
  // The far more common real phrasing is the OTHER order — subject lines
  // and email bodies routinely lead with the code: "104456 is your
  // verification code" / "104456 is your OTP". The pattern above can't
  // match this at all since it only looks for keyword-then-digits.
  { type: "otp", regex: /\b(\d{4,8})\b[^0-9]{0,30}\b(?:is\s+(?:your|the)\s+)?(?:otp|one[- ]?time (?:password|code)|verification code|security code|passcode|pin|code)\b/i },
  { type: "email", regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\b/ },
  { type: "receipt_no", regex: /\b(?:receipt|invoice|order|txn|transaction)[\s#:.-]*(?:no\.?|number|id)?[\s#:.-]*[A-Z0-9-]{5,}/i },
  // Requires the grouped/separated formatting a card number is actually
  // displayed with (e.g. "4111 1111 1111 1111") — a bare 13-19 digit run
  // (message IDs, timestamps, thread counts — everywhere in a real web app
  // like Gmail) used to match this and got flagged as a card number.
  { type: "card_number", regex: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/ },
  { type: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Aadhaar (India): 12 digits, almost always shown grouped as 4-4-4.
  { type: "aadhaar", regex: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/ },
  // PAN (India): 5 letters, 4 digits, 1 letter — a fixed, unambiguous format.
  { type: "pan", regex: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
];

// Most real OTP emails put the keyword ("verification code", "verify your
// email", etc.) in one element and the bare digits in a separate, visually
// isolated block (a big bold/highlighted code) — the two never share a
// single text node, so the same-node "otp" pattern above can't see them
// together. Instead: check once whether OTP-context wording appears
// ANYWHERE on the page, and if so, treat any text node that's ENTIRELY just
// a 4-8 digit code (not digits embedded in a longer sentence/price/date) as
// a probable OTP.
const OTP_CONTEXT_REGEX = /\b(?:otp|one[- ]?time (?:password|code)|verification|verify|confirmation code|security code|passcode|access code|sign-?in code|login code)\b/i;
const BARE_CODE_REGEX = /^\d[\d -]{2,10}\d$/;
function looksLikeBareCode(trimmed) {
  if (!BARE_CODE_REGEX.test(trimmed)) return false;
  const digitCount = (trimmed.match(/\d/g) || []).length;
  return digitCount >= 4 && digitCount <= 8;
}

/**
 * Walks visible text nodes on the page (skipping script/style) and finds
 * ones matching a PII pattern. Returns both the masked replacement text
 * (for the DOM JSON sent to the server) and the bounding box of the
 * containing element (so the same region can be blacked out on the actual
 * screenshot — DOM redaction alone doesn't touch the rendered pixels).
 */
function findTextPii(pageHasOtpContext) {
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
      let hasPiiMatch = pageHasOtpContext && looksLikeBareCode(val.trim());
      if (!hasPiiMatch) {
        for (const { regex } of TEXT_PII_PATTERNS) {
          if (regex.test(val)) {
            hasPiiMatch = true;
            break;
          }
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
    const trimmed = val.trim();

    if (pageHasOtpContext && looksLikeBareCode(trimmed)) {
      const parent = node.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        if (isInViewport(rect)) {
          matches.push({ type: "otp_bare", matchedText: trimmed, box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
          continue; // this node's already flagged — skip the pattern loop below
        }
      }
    }

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

/**
 * Segmented-OTP display: many templates (and OTP input fields) render each
 * digit in its own boxed element — six sibling nodes each containing just
 * "1", "0", "4"... — rather than one text node holding "104456". No single
 * node ever has 4+ digits, so findTextPii()'s bare-code check can't see it.
 *
 * Grouping by shared DOM parent doesn't work in practice — real markup
 * often wraps each digit in its OWN individual container (so all six
 * digits have six different immediate parents). What's actually reliable
 * is that they're always laid out as a horizontal row visually, regardless
 * of DOM nesting — so this clusters by position (same line, small
 * horizontal gaps) instead of by ancestor.
 *
 * Only runs when OTP-context wording is present on the page (cheap-checked
 * by the caller) — a full-DOM scan isn't worth doing otherwise.
 */
function findSegmentedOtpGroups() {
  const digitRects = [];
  const all = document.body.querySelectorAll("*");

  for (const el of all) {
    if (el.children.length > 0) continue; // only leaf elements
    const text = (el.textContent || "").trim();
    if (!/^\d$/.test(text)) continue; // exactly one digit, nothing else

    const rect = el.getBoundingClientRect();
    if (!isInViewport(rect)) continue;
    digitRects.push(rect);
  }
  if (digitRects.length < 4) return [];

  // Cluster into rows: rects whose vertical centers land close together.
  const rows = [];
  for (const rect of digitRects) {
    const cy = rect.y + rect.height / 2;
    let row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(6, rect.height * 0.4));
    if (!row) {
      row = { cy, rects: [] };
      rows.push(row);
    }
    row.rects.push(rect);
  }

  const regions = [];
  for (const row of rows) {
    row.rects.sort((a, b) => a.x - b.x);
    // Split each row into contiguous horizontal runs — boxes close enough
    // together (generous gap allowance for box borders/spacing) belong to
    // the same code; a big jump starts a new run.
    let run = [row.rects[0]];
    const flushRun = () => {
      if (run.length >= 4 && run.length <= 8) {
        const x = Math.min(...run.map((r) => r.x));
        const y = Math.min(...run.map((r) => r.y));
        const right = Math.max(...run.map((r) => r.x + r.width));
        const bottom = Math.max(...run.map((r) => r.y + r.height));
        regions.push({ x, y, w: right - x, h: bottom - y });
      }
    };
    for (let i = 1; i < row.rects.length; i++) {
      const prev = row.rects[i - 1];
      const curr = row.rects[i];
      const gap = curr.x - (prev.x + prev.width);
      const avgW = (prev.width + curr.width) / 2;
      if (gap <= avgW * 3) {
        run.push(curr);
      } else {
        flushRun();
        run = [curr];
      }
    }
    flushRun();
  }

  console.log(`[otp-debug] segmented OTP regions found: ${regions.length}`, regions);
  return regions;
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
  const roleSelectors = INTERACTIVE_ROLES.map((r) => `[role="${r}"]`).join(", ");
  const candidates = document.querySelectorAll(`button, a, input, select, textarea, ${roleSelectors}`);
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
      SENSITIVE_KEYWORD_REGEX.test(getFieldLabelText(el)) ||
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

async function captureAndSanitize(options = {}) {
  const timings = {};
  const runModel = options.runModel !== false;
  const runDom = options.runDom !== false;
  const redactionMode = options.redactionMode || "blackout";

  const t0 = performance.now();
  const dom = sanitizeDom();
  timings.sanitizeDomMs = performance.now() - t0;

  const t1 = performance.now();
  const pageHasOtpContext = runDom && OTP_CONTEXT_REGEX.test(document.body.innerText || "");
  console.log(`[otp-debug] pageHasOtpContext: ${pageHasOtpContext}`);
  const textPiiMatches = runDom ? findTextPii(pageHasOtpContext) : []; // OTPs, receipt/order numbers, card numbers, SSNs in plain text
  // Segmented OTP display (one digit per boxed element) needs a separate
  // element-level scan — no single text node ever holds the full code.
  const segmentedOtpRegions = pageHasOtpContext ? findSegmentedOtpGroups() : [];
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
  const modelRegions = runModel ? await detectSensitiveRegions(rawImageDataUrl) : [];
  timings.detectSensitiveRegionsMs = performance.now() - t3;

  const textRegions = textPiiMatches.map((m) => m.box);
  // sanitizeDom() flags password/email/[data-sensitive] inputs as sensitive
  // and redacts their TEXT in the DOM JSON, but their value is never a text
  // node (findTextPii walks SHOW_TEXT only), so without this their box never
  // reaches the image — the field would show [REDACTED] in the DOM snapshot
  // while the actual screenshot pixels stayed untouched.
  const domRegions = dom.filter((n) => n.sensitive).map((n) => n.box);
  const regions = [...modelRegions, ...textRegions, ...domRegions, ...segmentedOtpRegions];

  const t4 = performance.now();
  const redactedImageDataUrl = await redactImage(rawImageDataUrl, regions, redactionMode);
  timings.redactImageMs = performance.now() - t4;

  console.log(`sanitizeDom returned ${dom.length} elements (capped at 150)`);

  return {
    redactedImageDataUrl,
    sanitizedDom: dom,
    timings,
    redactedBoxes: [
      ...modelRegions.map(r => ({ type: "face", box: { x: r.x, y: r.y, w: r.w, h: r.h } })),
      ...textPiiMatches.map(m => ({ type: m.type, box: m.box })),
      ...dom.filter((n) => n.sensitive).map((n) => ({ type: "form_field", box: n.box })),
      ...segmentedOtpRegions.map((box) => ({ type: "otp_segmented", box }))
    ],
    redactionReport: {
      domFieldsRedacted: dom.filter((n) => n.sensitive).length,
      textPiiRedacted: textPiiMatches.length + segmentedOtpRegions.length,
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
    SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
    SENSITIVE_KEYWORD_REGEX.test(getFieldLabelText(el));
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
    captureAndSanitize(msg.options)
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