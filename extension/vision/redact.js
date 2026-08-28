// vision/redact.js
// Draws black boxes (or blur) over detected regions on a captured image,
// entirely client-side, before the image is ever sent to the server.

/**
 * @param {string} imageDataUrl - raw screenshot
 * @param {Array<{x:number,y:number,w:number,h:number}>} regions - from detector.js
 * @param {"blackout"|"blur"} mode
 * @returns {Promise<string>} redacted image as a data URL
 */
export async function redactImage(imageDataUrl, regions, mode = "blackout") {
  const img = await loadImage(imageDataUrl);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  for (const r of regions) {
    if (mode === "blackout") {
      ctx.fillStyle = "black";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else {
      // simple box blur: downscale then upscale the region
      const tmp = new OffscreenCanvas(Math.max(1, r.w / 8), Math.max(1, r.h / 8));
      const tctx = tmp.getContext("2d");
      tctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, tmp.width, tmp.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, r.x, r.y, r.w, r.h);
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
