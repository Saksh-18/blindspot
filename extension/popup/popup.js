// popup.js
// This is a debug harness, not the real agent loop (that lives in
// background.js's START_TASK handler). It exists so you can confirm
// capture -> sanitize actually works before wiring in the server/VLM.

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
      `${result.redactionReport.visualRegionsRedacted} visual regions redacted.`;

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