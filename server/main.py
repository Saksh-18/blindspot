from fastapi import FastAPI
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
    return await get_next_action(req)


@app.get("/health")
async def health():
    return {"status": "ok"}
