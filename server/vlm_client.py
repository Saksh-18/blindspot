"""
Wraps the call to whatever VLM backs the reasoning step.

For the SIH prototype: swap PROVIDER between "local" (self-hosted open-weights
model, e.g. Qwen2-VL via vLLM/transformers) and "cloud" (hosted API) without
touching main.py — get_next_action() is the only entry point the rest of the
server depends on.

TODO(next): implement _call_local() or _call_cloud() and build the prompt
that includes: the task, the redacted screenshot, the sanitized DOM list,
and the action history, then parse the model's JSON reply into AgentAction.
"""

import json

from schemas import ActionType, AgentAction, AgentStepRequest

PROVIDER = "local"  # "local" | "cloud"


async def get_next_action(req: AgentStepRequest) -> AgentAction:
    if PROVIDER == "local":
        raw = await _call_local(req)
    else:
        raw = await _call_cloud(req)

    return AgentAction(**raw)


async def _call_local(req: AgentStepRequest) -> dict:
    # TODO: load Qwen2-VL / Florence-2 / etc. and run inference with the
    # prompt built from req.task, req.image, req.dom, req.history.
    raise NotImplementedError("Wire up the local VLM here.")


async def _call_cloud(req: AgentStepRequest) -> dict:
    # TODO: call a hosted VLM API. Keep the same return shape as _call_local.
    raise NotImplementedError("Wire up the cloud VLM fallback here.")


def _build_prompt(req: AgentStepRequest) -> str:
    dom_summary = "\n".join(
        f"- {n.selector} ({n.tag}{', ' + n.role if n.role else ''}): "
        f"\"{n.text}\"" + (" [SENSITIVE]" if n.sensitive else "")
        for n in req.dom
    )
    history_summary = "\n".join(
        f"- {a.action}: {a.reasoning}" for a in req.history
    )
    return f"""You control a browser to complete this task: {req.task}

Visible interactive elements:
{dom_summary}

Actions taken so far:
{history_summary or '(none yet)'}

Respond with exactly one JSON action matching the AgentAction schema."""
