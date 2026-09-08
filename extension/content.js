// content.js
// Runs in the page context. Owns two responsibilities:
//   1. DOM-level PII heuristics (fast, no ML) — see sanitizeDom()
//   2. Executing actions the server sends back
// Actual screenshot capture + local vision redaction is delegated to
// vision/detector.js and vision/redact.js (imported dynamically below).

// Hard-blocked: never autofillable, never resolvable from a stored
// profile, under any circumstance. Note email/phone/address/DOB are
// deliberately NOT here — those have a legitimate local-profile resolution
// path now (see PROFILE_LABEL_PATTERNS below) instead of being a dead end.
const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete*="cc-"]',
  '[data-sensitive]',
];

const SENSITIVE_KEYWORD_REGEX =
  /ssn|social security|national insurance\b|credit card|debit card|\bcvv\b|password|\botp\b|passcode|security code|aadhaar|\bpan\b|passport|driving licen[cs]e|voter id|ration card|account number|routing number|\bifsc\b|\bswift\b|\biban\b|\bupi\b|bank(?:\s|$)|salary|policy number|insurance|medical record|diagnosis|prescription|employee id/i;

/**
 * Convenience profile fields — stored locally (chrome.storage.local, never
 * synced), never sent to the server. A field that maps to one of these gets
 * shown to the model as a resolvable placeholder ("{{profile.email}}")
 * instead of "[REDACTED]" when it's empty and a value is stored: the model
 * can ask to type the placeholder verbatim, and only typeIntoElement() —
 * entirely client-side — ever resolves it to the real value.
 */
const AUTOCOMPLETE_TO_PROFILE_KEY = {
  "given-name": "first_name",
  "family-name": "last_name",
  "name": "full_name",
  "email": "email",
  "tel": "phone",
  "tel-national": "phone",
  "street-address": "address_line1",
  "address-line1": "address_line1",
  "address-line2": "address_line2",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "zip_code",
  "country": "country",
  "country-name": "country",
  "bday": "date_of_birth",
  "sex": "gender",
};

function matchFieldToProfileKeyFromAutocomplete(el) {
  const ac = (el.getAttribute("autocomplete") || "").trim().toLowerCase();
  if (!ac) return null;
  const tokens = ac.split(/\s+/); // e.g. "shipping given-name" -> last token is the real field
  return AUTOCOMPLETE_TO_PROFILE_KEY[tokens[tokens.length - 1]] || null;
}

// Ordered specific-before-generic: "address line 2" must be checked before
// the bare "address" pattern, "first/last name" before generic "name", etc.
const PROFILE_LABEL_PATTERNS = [
  { key: "email", regex: /e-?mail/i },
  { key: "first_name", regex: /first\s*name|given\s*name|\bfname\b/i },
  { key: "last_name", regex: /last\s*name|surname|family\s*name|\blname\b/i },
  { key: "full_name", regex: /\bfull\s*name\b|^\s*name\s*$|your\s*name\b/i },
  { key: "phone", regex: /phone|mobile|contact\s*number|telephone/i },
  { key: "address_line2", regex: /address\s*line\s*2|apartment|\bapt\.?\b|suite|unit\s*(no\.?|number)?/i },
  { key: "address_line1", regex: /address\s*line\s*1|street\s*address|\baddress\b/i },
  { key: "city", regex: /\bcity\b|\btown\b/i },
  { key: "state", regex: /\bstate\b|\bprovince\b/i },
  { key: "zip_code", regex: /zip\s*code|postal\s*code|\bpincode\b|\bzip\b/i },
  { key: "country", regex: /\bcountry\b/i },
  { key: "date_of_birth", regex: /date\s*of\s*birth|\bdob\b|birth\s*date|birthday/i },
  { key: "gender", regex: /\bgender\b|\bsex\b/i },
];

function matchFieldToProfileKeyFromLabel(el) {
  const text = (el.getAttribute("aria-label") || "") + " " + (el.name || "") + " " + getFieldLabelText(el);
  for (const { key, regex } of PROFILE_LABEL_PATTERNS) {
    if (regex.test(text)) return key;
  }
  return null;
}

function matchFieldToProfileKey(el) {
  return matchFieldToProfileKeyFromAutocomplete(el) || matchFieldToProfileKeyFromLabel(el);
}

const PROFILE_PLACEHOLDER_REGEX = /^\{\{profile\.([a-z_]+)\}\}$/;

/**
 * agentProfile: the saved profile from the Profile pane.
 * agentProfileSessionOverride: written by the sidepanel right before a run
 * when the task has attachments — fields extracted locally from a text-
 * based file (see sidepanel.js's extractProfileFromText), for THIS run
 * only. Never persisted beyond the run, never sent anywhere raw; it just
 * takes precedence over the saved profile for whichever keys it sets.
 */
function getProfile() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["agentProfile", "agentProfileSessionOverride"], (r) => {
        resolve({ ...((r && r.agentProfile) || {}), ...((r && r.agentProfileSessionOverride) || {}) });
      });
    } catch {
      resolve({});
    }
  });
}

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
function findSegmentedOtpDigits() {
  const digitItems = [];
  const all = document.body.querySelectorAll("*");

  for (const el of all) {
    let text;
    if (el.tagName === "INPUT") {
      // A real OTP *entry* field (maxlength=1 per box) holds its digit in
      // .value, not textContent — an <input> never has text children at
      // all, so the leaf-element text check below can't see it.
      text = (el.value || "").trim();
    } else {
      if (el.children.length > 0) continue; // only leaf elements
      text = (el.textContent || "").trim();
    }
    if (!/^\d$/.test(text)) continue; // exactly one digit, nothing else

    const rect = el.getBoundingClientRect();
    if (!isInViewport(rect)) continue;
    digitItems.push({ el, rect });
  }
  if (digitItems.length < 4) return { regions: [], elements: new Set() };

  // Cluster into rows: rects whose vertical centers land close together.
  const rows = [];
  for (const item of digitItems) {
    const cy = item.rect.y + item.rect.height / 2;
    let row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(6, item.rect.height * 0.4));
    if (!row) {
      row = { cy, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }

  const regions = [];
  const elements = new Set();
  for (const row of rows) {
    row.items.sort((a, b) => a.rect.x - b.rect.x);
    // Split each row into contiguous horizontal runs — boxes close enough
    // together (generous gap allowance for box borders/spacing) belong to
    // the same code; a big jump starts a new run.
    let run = [row.items[0]];
    const flushRun = () => {
      if (run.length >= 4 && run.length <= 8) {
        const rects = run.map((it) => it.rect);
        const x = Math.min(...rects.map((r) => r.x));
        const y = Math.min(...rects.map((r) => r.y));
        const right = Math.max(...rects.map((r) => r.x + r.width));
        const bottom = Math.max(...rects.map((r) => r.y + r.height));
        regions.push({ x, y, w: right - x, h: bottom - y });
        run.forEach((it) => elements.add(it.el));
      }
    };
    for (let i = 1; i < row.items.length; i++) {
      const prev = row.items[i - 1];
      const curr = row.items[i];
      const gap = curr.rect.x - (prev.rect.x + prev.rect.width);
      const avgW = (prev.rect.width + curr.rect.width) / 2;
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
  return { regions, elements };
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
function sanitizeDom(otpElements, profile) {
  otpElements = otpElements || new Set();
  profile = profile || {};
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
    const isEmpty = !rawText.trim();
    const { masked, hit } = maskPiiInText(rawText);

    const isHardSensitive =
      SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
      SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
      SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
      SENSITIVE_KEYWORD_REGEX.test(getFieldLabelText(el)) ||
      otpElements.has(el);

    const profileKey = isHardSensitive ? null : matchFieldToProfileKey(el);
    const hasProfileValue = profileKey && typeof profile[profileKey] === "string" && profile[profileKey].trim();

    let text, isSensitive;
    if (!isHardSensitive && isEmpty && hasProfileValue) {
      // Nothing real is on-screen yet — safe to show a resolvable token
      // instead of blocking the field outright. Only typeIntoElement()
      // ever turns this into the actual stored value, client-side.
      text = `{{profile.${profileKey}}}`;
      isSensitive = false;
    } else {
      // A field that maps to a profile key but is already FILLED now shows
      // real personal data on screen — treat it as sensitive from here on,
      // same as any other PII, even though it isn't hard-blocked.
      isSensitive = isHardSensitive || hit || Boolean(profileKey && !isEmpty);
      text = isSensitive ? (hit ? masked : "[REDACTED]") : rawText;
    }

    const selector = el.id ? `#${el.id}` : `[data-agent-idx="${i}"]`;
    if (!el.id) {
      elementsToIndex.push({ el, idx: i });
    }

    nodes.push({
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text,
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

  // Computed before sanitizeDom() so segmented-OTP member elements (an
  // <input maxlength=1> box, or a plain digit-holding <div>/<span>) can be
  // forced sensitive in the DOM JSON too — not just blacked out in the
  // image. Without this, each box's own value would still leak as text.
  const t0b = performance.now();
  const pageHasOtpContext = runDom && OTP_CONTEXT_REGEX.test(document.body.innerText || "");
  console.log(`[otp-debug] pageHasOtpContext: ${pageHasOtpContext}`);
  const segmentedOtp = pageHasOtpContext ? findSegmentedOtpDigits() : { regions: [], elements: new Set() };
  timings.findSegmentedOtpMs = performance.now() - t0b;

  const profile = await getProfile();

  const t0 = performance.now();
  const dom = sanitizeDom(segmentedOtp.elements, profile);
  timings.sanitizeDomMs = performance.now() - t0;

  const t1 = performance.now();
  const textPiiMatches = runDom ? findTextPii(pageHasOtpContext) : []; // OTPs, receipt/order numbers, card numbers, SSNs in plain text
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
  const regions = [...modelRegions, ...textRegions, ...domRegions, ...segmentedOtp.regions];

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
      ...segmentedOtp.regions.map((box) => ({ type: "otp_segmented", box }))
    ],
    redactionReport: {
      domFieldsRedacted: dom.filter((n) => n.sensitive).length,
      textPiiRedacted: textPiiMatches.length + segmentedOtp.regions.length,
      visualRegionsRedacted: modelRegions.length,
    },
  };
}

/**
 * Performs the action and reports back whether the target element was
 * actually found — without this, a wrong/stale selector fails silently and
 * the loop has no way to know the click never happened.
 */
async function executeAction(action) {
  if (action.action === "click") {
    const el = document.querySelector(action.selector);
    if (!el) return { matched: false, reason: "not_found" };
    if (el.disabled) return { matched: false, reason: "disabled" };
    el.click();
    return { matched: true };
  }
  if (action.action === "type") {
    return await typeIntoElement(action.selector, action.text);
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
async function typeIntoElement(selector, text) {
  const el = document.querySelector(selector);
  if (!el) return { matched: false, reason: "not_found" };
  if (el.disabled || el.readOnly) return { matched: false, reason: "disabled_or_readonly" };

  // The server never saw this field's real content (it was redacted before
  // anything left the browser), so any text the model wants to type here is
  // a guess, not a legitimate value — e.g. it cannot actually know the
  // user's real password. Block it rather than let a hallucinated value
  // land in a hard-sensitive field.
  const isHardSensitive =
    SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
    SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
    SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
    SENSITIVE_KEYWORD_REGEX.test(getFieldLabelText(el));
  if (isHardSensitive) {
    return { matched: false, reason: "blocked_sensitive_field" };
  }

  // "{{profile.email}}" etc — resolved to the real stored value entirely
  // client-side, right here. The model only ever handled the token name.
  const placeholderMatch = text && text.match(PROFILE_PLACEHOLDER_REGEX);
  if (placeholderMatch) {
    const profile = await getProfile();
    const resolved = profile[placeholderMatch[1]];
    if (typeof resolved !== "string" || !resolved.trim()) {
      return { matched: false, reason: "profile_value_missing" };
    }
    text = resolved;
  } else if (matchFieldToProfileKey(el)) {
    // This field maps to a stored-profile field — the model never saw a
    // real value for it, so any literal text here is an invented guess.
    // It must go through the placeholder, or not at all.
    return { matched: false, reason: "must_use_profile_placeholder" };
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

/**
 * Zero-network instant fill: matches the standard HTML autocomplete
 * attribute (autocomplete="email", "tel", "street-address", ...) directly
 * against the stored profile and fills it right away — no VLM round-trip,
 * no tokens spent. Deliberately autocomplete-only (not label-text): that's
 * the stricter, unambiguous signal, appropriate for firing with no review
 * step. Label-text matching is looser and stays reserved for the VLM path,
 * where there's an actual decision being made per field.
 * Never overwrites a field that already has something in it.
 */
async function autofillStandardFields() {
  const profile = await getProfile();
  if (!profile || !Object.keys(profile).some((k) => (profile[k] || "").trim())) {
    return { filled: 0 };
  }

  const candidates = document.querySelectorAll("input, textarea, select");
  let filled = 0;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (!isInViewport(rect)) continue;
    if (el.disabled || el.readOnly) continue;
    if ((el.value || "").trim()) continue; // never overwrite something already filled

    const isHardSensitive =
      SENSITIVE_SELECTORS.some((sel) => el.matches(sel)) ||
      SENSITIVE_KEYWORD_REGEX.test(el.getAttribute("aria-label") || "") ||
      SENSITIVE_KEYWORD_REGEX.test(el.name || "") ||
      SENSITIVE_KEYWORD_REGEX.test(getFieldLabelText(el));
    if (isHardSensitive) continue;

    const profileKey = matchFieldToProfileKeyFromAutocomplete(el);
    const value = profileKey && profile[profileKey];
    if (typeof value !== "string" || !value.trim()) continue;

    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled++;
  }

  filled += fillGenderRadioGroups(profile.gender);
  return { filled };
}

/**
 * Gender is usually a radio GROUP (Male/Female/Other as separate <input
 * type="radio"> siblings), not one field with one value — the placeholder
 * mechanism above only resolves a single element's value/text, so it can't
 * express "click the option matching my stored gender" on its own. This is
 * instant-pass only: it's a pure DOM click based on already-visible option
 * labels ("Male"/"Female" aren't private text), so there's no server round
 * trip to protect against here either way.
 */
function fillGenderRadioGroups(genderValue) {
  if (!genderValue || !genderValue.trim()) return 0;
  const wanted = genderValue.trim().toLowerCase();

  const groups = new Map(); // name -> radios[]
  document.querySelectorAll('input[type="radio"]').forEach((r) => {
    if (!r.name) return;
    const rect = r.getBoundingClientRect();
    if (!isInViewport(rect)) return;
    if (!groups.has(r.name)) groups.set(r.name, []);
    groups.get(r.name).push(r);
  });

  let filled = 0;
  for (const radios of groups.values()) {
    if (radios.some((r) => r.checked)) continue; // already answered, leave it alone

    const groupName = radios[0].name || "";
    const legend = radios[0].closest("fieldset")?.querySelector("legend")?.textContent || "";
    if (!/\bgender\b|\bsex\b/i.test(groupName + " " + legend)) continue;

    const match = radios.find((r) => {
      const optionText = getFieldLabelText(r) + " " + (r.value || "") + " " + (r.getAttribute("aria-label") || "");
      return optionText.toLowerCase().includes(wanted);
    });
    if (match) {
      match.click();
      filled++;
    }
  }
  return filled;
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
    executeAction(msg.action)
      .then(sendResponse)
      .catch((err) => {
        console.error("executeAction failed:", err);
        sendResponse({ matched: false, reason: "internal_error" });
      });
    return true;
  }
  if (msg.type === "AUTOFILL_STANDARD_FIELDS") {
    autofillStandardFields()
      .then(sendResponse)
      .catch((err) => {
        console.error("autofillStandardFields failed:", err);
        sendResponse({ filled: 0, error: err.message });
      });
    return true;
  }
});