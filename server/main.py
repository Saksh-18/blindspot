import os
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(dotenv_path=env_path)  # reads server/.env for API keys — must run before vlm_client is imported

import traceback
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import AgentAction, AgentStepRequest
from vlm_client import get_next_action

app = FastAPI(title="Vision Agent Server")

# The extension talks to localhost during dev; tighten this before any real deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/agent/step", response_model=AgentAction)
async def agent_step(req: AgentStepRequest) -> AgentAction:
    """
    Single step of the agent loop. Receives an already-sanitized screenshot
    + DOM snapshot (redaction happened client-side, before this request was
    ever made) and returns exactly one action for the client to execute.
    """
    try:
        return await get_next_action(req)
    except Exception as e:
        print("=== EXCEPTION IN AGENT_STEP ===")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    return {"status": "ok"}


telemetry_runs = []

@app.post("/eval/telemetry")
async def log_telemetry(run: dict):
    telemetry_runs.append(run)
    return {"status": "logged"}


@app.get("/eval/report")
async def get_report():
    return telemetry_runs


@app.post("/eval/clear")
async def clear_report():
    telemetry_runs.clear()
    return {"status": "cleared"}