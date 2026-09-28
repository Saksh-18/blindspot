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
    if (!r || r.w <= 0 || r.h <= 0) continue;
    const rx = r.x * scaleX * outputScale;
    const ry = r.y * scaleY * outputScale;
    const rw = r.w * scaleX * outputScale;
    const rh = r.h * scaleY * outputScale;

    // Clamp coordinates within the target canvas boundaries to prevent drawImage errors
    const clampX = Math.max(0, Math.min(outWidth, rx));
    const clampY = Math.max(0, Math.min(outHeight, ry));
    const clampW = Math.max(0, Math.min(outWidth - clampX, rw - (clampX - rx)));
    const clampH = Math.max(0, Math.min(outHeight - clampY, rh - (clampY - ry)));
    if (clampW <= 0 || clampH <= 0) continue;

    if (mode === "blackout") {
      ctx.fillStyle = "black";
      ctx.fillRect(clampX, clampY, clampW, clampH);
    } else {
      applyFrostedPrivacyBlur(ctx, clampX, clampY, clampW, clampH, outWidth, outHeight);
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

/**
 * Heavy privacy blur that completely destroys character contours and text glyphs
 * by combining mosaic block-averaging, 2-pass box blur smoothing, and a frosted tint overlay.
 */
function applyFrostedPrivacyBlur(ctx, rx, ry, rw, rh, canvasW, canvasH) {
  const ix = Math.max(0, Math.floor(rx));
  const iy = Math.max(0, Math.floor(ry));
  const iw = Math.max(1, Math.min(canvasW - ix, Math.ceil(rw)));
  const ih = Math.max(1, Math.min(canvasH - iy, Math.ceil(rh)));

  try {
    const imgData = ctx.getImageData(ix, iy, iw, ih);
    const data = imgData.data;

    // Dynamic block size based on region dimensions to guarantee complete illegibility
    const blockSize = Math.max(8, Math.min(18, Math.floor(Math.min(iw, ih) / 2.5) || 8));

    // 1. Mosaic color cell aggregation: completely dissolves any letter/digit shapes
    for (let by = 0; by < ih; by += blockSize) {
      for (let bx = 0; bx < iw; bx += blockSize) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        const bw = Math.min(blockSize, iw - bx);
        const bh = Math.min(blockSize, ih - by);

        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const idx = ((by + py) * iw + (bx + px)) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            count++;
          }
        }

        if (count > 0) {
          const avgR = Math.round(r / count);
          const avgG = Math.round(g / count);
          const avgB = Math.round(b / count);
          const avgA = Math.round(a / count);

          for (let py = 0; py < bh; py++) {
            for (let px = 0; px < bw; px++) {
              const idx = ((by + py) * iw + (bx + px)) * 4;
              data[idx] = avgR;
              data[idx + 1] = avgG;
              data[idx + 2] = avgB;
              data[idx + 3] = avgA;
            }
          }
        }
      }
    }

    // 2. Horizontal + Vertical box blur to smooth mosaic block edges into a natural Gaussian look
    boxBlurImageData(data, iw, ih, Math.max(4, Math.floor(blockSize * 0.75)));

    ctx.putImageData(imgData, ix, iy);

    // 3. Frosted glass tint overlay to ensure high aesthetic polish while locking privacy
    ctx.save();
    ctx.fillStyle = "rgba(225, 230, 240, 0.35)";
    ctx.fillRect(ix, iy, iw, ih);
    ctx.restore();
  } catch {
    // Solid opaque fallback in case getImageData fails
    ctx.fillStyle = "rgba(0, 0, 0, 0.88)";
    ctx.fillRect(ix, iy, iw, ih);
  }
}

function boxBlurImageData(data, w, h, radius) {
  if (radius < 1 || w <= 1 || h <= 1) return;
  const copy = new Uint8ClampedArray(data);

  // Horizontal blur pass
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, count = 0;
      const minX = Math.max(0, x - radius);
      const maxX = Math.min(w - 1, x + radius);
      for (let kx = minX; kx <= maxX; kx++) {
        const idx = (rowOffset + kx) * 4;
        r += copy[idx];
        g += copy[idx + 1];
        b += copy[idx + 2];
        count++;
      }
      const dstIdx = (rowOffset + x) * 4;
      data[dstIdx] = Math.round(r / count);
      data[dstIdx + 1] = Math.round(g / count);
      data[dstIdx + 2] = Math.round(b / count);
    }
  }

  copy.set(data);

  // Vertical blur pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let r = 0, g = 0, b = 0, count = 0;
      const minY = Math.max(0, y - radius);
      const maxY = Math.min(h - 1, y + radius);
      for (let ky = minY; ky <= maxY; ky++) {
        const idx = (ky * w + x) * 4;
        r += copy[idx];
        g += copy[idx + 1];
        b += copy[idx + 2];
        count++;
      }
      const dstIdx = (y * w + x) * 4;
      data[dstIdx] = Math.round(r / count);
      data[dstIdx + 1] = Math.round(g / count);
      data[dstIdx + 2] = Math.round(b / count);
    }
  }
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