// vision/detector.js
// Local, in-browser detection of sensitive visual regions (faces, on-screen
// PII text, etc). Runs via ONNX Runtime Web / Transformers.js with WebGPU
// where available, falling back to WASM.
//
// TODO(next): load a face-detection ONNX model (e.g. BlazeFace) here.
// TODO(next): optionally add an OCR pass (Tesseract.js) + regex/NER over
//             detected text to catch PII rendered as pixels (e.g. a screen-
//             shared ID card) rather than DOM elements.

/**
 * @param {string} imageDataUrl
 * @returns {Promise<Array<{x:number, y:number, w:number, h:number, type:string, confidence:number}>>}
 */
export async function detectSensitiveRegions(imageDataUrl) {
  // Placeholder: returns no regions until a model is wired in.
  // Keeping this async + same-shaped return so redact.js and content.js
  // don't need to change once real detection lands.
  return [];
}
