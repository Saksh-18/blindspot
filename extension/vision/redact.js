// vision/redact.js
// Draws black boxes (or blur) over detected regions on a captured image,
// entirely client-side, before the image is ever sent to the server.

/**
 * @param {string} imageDataUrl - raw screenshot
 * @param {Array<{x:number,y:number,w:number,h:number}>} regions - from detector.js, in CSS pixels (getBoundingClientRect)
 * @param {"blackout"|"blur"} mode
 * @param {{maxDimension?: number}} options - maxDimension caps the longest
 *        side of the output image (default 1280px). Full-resolution
 *        screenshots — especially on high-DPI/retina displays — add real
 *        seconds of upload + VLM processing time per step for no accuracy
 *        benefit at typical UI-element sizes.
 * @returns {Promise<string>} redacted image as a data URL
 */
export async function redactImage(imageDataUrl, regions, mode = "blackout", options = {}) {
  const { maxDimension = 1280 } = options;
  const img = await loadImage(imageDataUrl);

  // captureVisibleTab captures at device-pixel resolution, but region boxes
  // come from getBoundingClientRect() in CSS pixels — on a high-DPI display
  // (devicePixelRatio > 1) those don't match 1:1. Scale regions into the
  // image's actual pixel space, or redaction lands in the wrong place.
  const scaleX = img.width / window.innerWidth;
  const scaleY = img.height / window.innerHeight;

  const outputScale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const outWidth = Math.round(img.width * outputScale);
  const outHeight = Math.round(img.height * outputScale);

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, outWidth, outHeight);

  for (const r of regions) {
    const rx = r.x * scaleX * outputScale;
    const ry = r.y * scaleY * outputScale;
    const rw = r.w * scaleX * outputScale;
    const rh = r.h * scaleY * outputScale;

    if (mode === "blackout") {
      ctx.fillStyle = "black";
      ctx.fillRect(rx, ry, rw, rh);
    } else {
      // simple box blur: downscale then upscale the region
      const tmp = new OffscreenCanvas(Math.max(1, rw / 8), Math.max(1, rh / 8));
      const tctx = tmp.getContext("2d");
      tctx.drawImage(canvas, rx, ry, rw, rh, 0, 0, tmp.width, tmp.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, rx, ry, rw, rh);
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}