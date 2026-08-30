"""
Wraps the call to whatever VLM backs the reasoning step.

Three providers, same output shape (a dict matching AgentAction):



Swap PROVIDER below; main.py never changes.
"""

import json
import os
import re

from groq import Groq
from schemas import AgentAction, AgentStepRequest

PROVIDER = "groq"  # "groq" | "local" | "cloud"

GROQ_MODEL = "qwen/qwen3.6-27b"  # open-weights, vision-capable, Groq free tier

_groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


async def get_next_action(req: AgentStepRequest) -> AgentAction:
    if PROVIDER == "groq":
        raw = await _call_groq(req)
    elif PROVIDER == "local":
        raw = await _call_local(req)
    else:
        raw = await _call_cloud(req)

    return AgentAction(**raw)


async def _call_groq(req: AgentStepRequest) -> dict:
    """
    Sends the sanitized screenshot + DOM summary to Qwen3.6-27B via Groq and
    asks for exactly one JSON action back. JSON mode is enabled, but the
    prompt still spells out the exact shape since JSON mode only guarantees
    valid JSON syntax, not the fields we actually need.
    """
    prompt = _build_prompt(req)

    completion = _groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": req.image}},
                ],
            }
        ],
        temperature=0.2,  # low temp — we want consistent, parseable actions, not creativity
        max_completion_tokens=500,
        response_format={"type": "json_object"},
    )

    text = completion.choices[0].message.content
    return _extract_json(text)


async def _call_local(req: AgentStepRequest) -> dict:
    # TODO (teammate's MacBook): run Qwen3.6-27B (or a smaller local-friendly
    # vision model) on-device — e.g. via Ollama, llama.cpp, or MLX — and
    # return the same dict shape as _call_groq(). Once this works, PROVIDER
    # can be flipped to "local" for the actual demo without touching main.py.
    raise NotImplementedError("Wire up true on-device inference here.")


async def _call_cloud(req: AgentStepRequest) -> dict:
    """Anthropic Claude fallback — requires a paid API key, not used by default."""
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    media_type, image_b64 = _decode_data_url(req.image)

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                    {"type": "text", "text": _build_prompt(req)},
                ],
            }
        ],
    )
    text = "".join(block.text for block in message.content if block.type == "text")
    return _extract_json(text)


def _build_prompt(req: AgentStepRequest) -> str:
    dom_summary = "\n".join(
        f"- {n.selector} ({n.tag}{', ' + n.role if n.role else ''}): "
        f"\"{n.text}\"" + (" [SENSITIVE]" if n.sensitive else "")
        for n in req.dom
    )
    history_summary = "\n".join(f"- {a.action}: {a.reasoning}" for a in req.history)

    return f"""You control a browser to complete this task: {req.task}

You are looking at a screenshot with sensitive regions already blacked out —
do not try to read or guess redacted content, work around it.

Visible interactive elements (from the DOM, already sanitized):
{dom_summary}

Actions taken so far:
{history_summary or '(none yet)'}

Decide the single next action. Respond with ONLY a JSON object, no prose,
matching this shape:
{{
  "action": "click" | "type" | "scroll" | "wait" | "done" | "ask_user",
  "selector": "<css selector from the DOM list above, if click/type>",
  "text": "<text to type, if action is type>",
  "scroll_direction": "up" | "down",
  "scroll_amount_px": <integer>,
  "reasoning": "<one short sentence explaining this action>",
  "task_complete": <true if this action finishes the task, else false>
}}
Only include the fields relevant to the chosen action."""


def _decode_data_url(data_url: str) -> tuple[str, str]:
    """'data:image/png;base64,AAAA...' -> ('image/png', 'AAAA...')"""
    match = re.match(r"^data:(image/\w+);base64,(.+)$", data_url)
    if not match:
        raise ValueError("Expected a base64 data URL for req.image")
    return match.group(1), match.group(2)


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"VLM did not return valid JSON: {text[:300]!r}") from e