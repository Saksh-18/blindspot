# Privacy-Preserving Vision Agent (SIH — ISRO)

On-device visual perception for a lightweight browser agent. Local vision
model detects and redacts sensitive screen content (faces, passwords, PII)
*before* anything leaves the browser; only sanitized context goes to the
server, which runs the VLM reasoning and returns the next action.

## Repo layout

```
extension/          Manifest V3 browser extension (client)
  manifest.json
  background.js      orchestrates the capture -> redact -> send -> execute loop
  content.js          DOM-level PII heuristics + action execution (runs in-page)
  vision/
    detector.js        local ONNX/Transformers.js model — finds sensitive regions
    redact.js           canvas-based blackout/blur, applied before send
  popup/
     popup.html
     popup.js               extension UI (task input, status)
  models/              ONNX model weights (gitignored — fetched via a setup script)

server/              FastAPI backend
  main.py              /agent/step endpoint
  schemas.py           Pydantic models mirroring shared/action_schema.json
  vlm_client.py        wraps local or cloud VLM call
  tests/

shared/
  action_schema.json  single source of truth for the client<->server action format

eval/                scripts mapped directly to the judging criteria:
  latency_bench.py         end-to-end latency (15%)
  pii_precision_recall.py  detection + redaction precision (20% + 20%)
  sample_screens/          labeled test images

docs/
  architecture.md
```

## The loop

1. **Capture** — extension screenshots the tab + snapshots the DOM.
2. **Local detect** — `vision/detector.js` finds sensitive regions on-device (WebGPU/WASM).
3. **Redact** — `vision/redact.js` blacks out/blurs those regions; `content.js` strips sensitive DOM text.
4. **Send** — only the sanitized image + DOM go to `/agent/step`.
5. **Reason** — server VLM (`vlm_client.py`) returns one `AgentAction`.
6. **Execute** — `content.js` performs it (click/type/scroll).
7. Repeat until `done`.

## Setup (once you start filling in stages)

**Server**
```powershell
cd server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

**Extension**
- `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
- Model weights go in `extension/models/` (add a fetch script once you've picked models)

## Status

Scaffolded, not yet functional — every file with a `TODO` is the next real
piece of work. Current build order: extension capture/DOM →  DOM PII
heuristics (already stubbed in) → local vision model → redaction render →
server + VLM loop → wire end-to-end → eval scripts.
