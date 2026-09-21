// vision/detector.js
// Local, in-browser detection of sensitive visual regions (faces).
// Runs via ONNX Runtime Web with local WASM binaries.

let sessionCache = null;
let priorsCache = null;

/**
 * Initializes and caches the ONNX Runtime InferenceSession.
 */
async function getSession() {
  if (sessionCache) return sessionCache;

  const browserRuntime = (typeof browser !== "undefined" && browser.runtime) ? browser.runtime : chrome.runtime;
  // Set the path to local WASM binaries in the extension package
  ort.env.wasm.wasmPaths = browserRuntime.getURL("vision/lib/");
  // Limit to single-thread to avoid SharedArrayBuffer CSP blocks
  ort.env.wasm.numThreads = 1;

  const modelUrl = browserRuntime.getURL("models/version-RFB-320.onnx");
  sessionCache = await ort.InferenceSession.create(modelUrl);
  return sessionCache;
}

/**
 * Loads an image from a URL or DataURL.
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error("Failed to load image: " + e.message));
    img.src = src;
  });
}

/**
 * Generates SSD anchor boxes (priors) for the 320x240 input resolution.
 */
function generatePriors() {
  if (priorsCache) return priorsCache;

  const minBoxes = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]];
  const imageSize = [320, 240];
  const featureMapWHList = [
    [40, 20, 10, 5], // width feature map sizes
    [30, 15, 8, 4]   // height feature map sizes
  ];

  const priors = [];
  const levels = featureMapWHList[0].length; // 4 levels

  for (let index = 0; index < levels; index++) {
    const w = featureMapWHList[0][index];
    const h = featureMapWHList[1][index];

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const xCenter = (i + 0.5) / w;
        const yCenter = (j + 0.5) / h;

        for (const minBox of minBoxes[index]) {
          const boxW = minBox / imageSize[0];
          const boxH = minBox / imageSize[1];

          // Clamp prios to [0, 1] range matching clamp=True in Python
          const px = Math.min(Math.max(xCenter, 0.0), 1.0);
          const py = Math.min(Math.max(yCenter, 0.0), 1.0);
          const pw = Math.min(Math.max(boxW, 0.0), 1.0);
          const ph = Math.min(Math.max(boxH, 0.0), 1.0);

          priors.push([px, py, pw, ph]);
        }
      }
    }
  }

  priorsCache = priors;
  return priors;
}

/**
 * Computes Intersection over Union (IoU) of two boxes in corner-form [x1, y1, x2, y2].
 */
function boxIoU(boxA, boxB) {
  const xA = Math.max(boxA[0], boxB[0]);
  const yA = Math.max(boxA[1], boxB[1]);
  const xB = Math.min(boxA[2], boxB[2]);
  const yB = Math.min(boxA[3], boxB[3]);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  if (interArea === 0) return 0;

  const boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
  const boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);

  return interArea / (boxAArea + boxBArea - interArea);
}

/**
 * Standard Non-Maximum Suppression (NMS) to eliminate overlapping boxes.
 */
function runNMS(candidates, iouThreshold) {
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  const suppressed = new Set();

  for (let i = 0; i < candidates.length; i++) {
    if (suppressed.has(i)) continue;
    const current = candidates[i];
    picked.push(current);

    for (let j = i + 1; j < candidates.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = boxIoU(current.box, candidates[j].box);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return picked;
}

/**
 * Local face detection.
 * Reads the screenshot image data URL, resizes to 320x240, normalizes it,
 * performs model inference, and decodes face region boxes.
 *
 * @param {string} imageDataUrl
 * @returns {Promise<Array<{x:number, y:number, w:number, h:number, type:string, confidence:number}>>}
 */
export async function detectSensitiveRegions(imageDataUrl) {
  try {
    const session = await getSession();
    const img = await loadImage(imageDataUrl);

    // 1. Resize screenshot to 320x240 target resolution
    const canvas = new OffscreenCanvas(320, 240);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 320, 240);
    const imgData = ctx.getImageData(0, 0, 320, 240);

    // 2. Preprocess: plan RGB (CHW format) & normalization (val - 127) / 128
    const floatData = new Float32Array(1 * 3 * 240 * 320);
    const rOffset = 0;
    const gOffset = 320 * 240;
    const bOffset = 2 * 320 * 240;
    const size = 320 * 240;

    for (let i = 0; i < size; i++) {
      const r = imgData.data[i * 4];
      const g = imgData.data[i * 4 + 1];
      const b = imgData.data[i * 4 + 2];

      floatData[rOffset + i] = (r - 127) / 128;
      floatData[gOffset + i] = (g - 127) / 128;
      floatData[bOffset + i] = (b - 127) / 128;
    }

    // 3. Create input tensor
    const inputTensor = new ort.Tensor("float32", floatData, [1, 3, 240, 320]);
    const feeds = {};
    feeds[session.inputNames[0]] = inputTensor;

    // 4. Run inference
    const outputMap = await session.run(feeds);
    
    // Find scores and boxes tensors dynamically by checking shapes
    let scoresTensor, boxesTensor;
    for (const name of session.outputNames) {
      const tensor = outputMap[name];
      if (tensor.dims[2] === 2) {
        scoresTensor = tensor;
      } else if (tensor.dims[2] === 4) {
        boxesTensor = tensor;
      }
    }

    if (!scoresTensor || !boxesTensor) {
      console.warn("ORT outputs missing dimension expectations (scores/boxes shapes mismatch)");
      return [];
    }

    // 5. Decode outputs using SSD anchors
    const priors = generatePriors();
    const candidates = [];
    // Lower = more recall. For a privacy tool a missed face is a real leak;
    // an occasional unnecessary black box over a non-face is a non-issue —
    // so bias toward catching it, not toward precision.
    const scoreThreshold = 0.5;
    
    const centerVariance = 0.1;
    const sizeVariance = 0.2;

    for (let idx = 0; idx < 4420; idx++) {
      const scoreBg = scoresTensor.data[idx * 2];
      const scoreFace = scoresTensor.data[idx * 2 + 1];

      // Softmax confidence score
      const expBg = Math.exp(scoreBg);
      const expFace = Math.exp(scoreFace);
      const probFace = expFace / (expBg + expFace);

      if (probFace < scoreThreshold) continue;

      const locX = boxesTensor.data[idx * 4];
      const locY = boxesTensor.data[idx * 4 + 1];
      const locW = boxesTensor.data[idx * 4 + 2];
      const locH = boxesTensor.data[idx * 4 + 3];

      const priorCx = priors[idx][0];
      const priorCy = priors[idx][1];
      const priorW = priors[idx][2];
      const priorH = priors[idx][3];

      // Anchor decoding formulas matching model's original python codebase
      const boxCx = locX * centerVariance * priorW + priorCx;
      const boxCy = locY * centerVariance * priorH + priorCy;
      const boxW = Math.exp(locW * sizeVariance) * priorW;
      const boxH = Math.exp(locH * sizeVariance) * priorH;

      const xMin = boxCx - boxW / 2;
      const yMin = boxCy - boxH / 2;
      const xMax = boxCx + boxW / 2;
      const yMax = boxCy + boxH / 2;

      candidates.push({
        box: [
          Math.max(0.0, Math.min(1.0, xMin)),
          Math.max(0.0, Math.min(1.0, yMin)),
          Math.max(0.0, Math.min(1.0, xMax)),
          Math.max(0.0, Math.min(1.0, yMax))
        ],
        score: probFace
      });
    }

    // 6. Run Non-Maximum Suppression (NMS)
    const picked = runNMS(candidates, 0.3);

    // 7. Map relative coordinates back to CSS viewport pixels
    return picked.map((c) => {
      const [x1, y1, x2, y2] = c.box;
      return {
        x: x1 * window.innerWidth,
        y: y1 * window.innerHeight,
        w: (x2 - x1) * window.innerWidth,
        h: (y2 - y1) * window.innerHeight,
        type: "face",
        confidence: c.score
      };
    });
  } catch (err) {
    console.error("Local face detector failed during run:", err);
    return [];
  }
}
