"""
Wraps the call to whatever VLM backs the reasoning step.

Three providers, same output shape (a dict matching AgentAction):

  - "groq"  : Qwen3.6-27B hosted on Groq. Open-weights model, free tier, no
             payment method required. This is what you develop against on
             this laptop. Satisfies the SIH rule ("open-weights model,
             cloud-hosted during SIH is fine") without needing local GPU.
  - "local" : true on-device inference (e.g. via llama.cpp / MLX / Ollama).
             TODO — this is what your teammate can wire up on her MacBook.
             Same Qwen weights, run locally instead of via Groq's API.
  - "cloud" : Anthropic Claude, implemented earlier as a fallback/comparison
             option. Requires a paid API key.

Swap PROVIDER below; main.py never changes.
"""

import json
import os
import re

import traceback
from groq import Groq
from schemas import AgentAction, AgentStepRequest, ActionType, ScrollDirection

PROVIDER = "groq"  # "groq" | "local" | "cloud"

GROQ_MODEL = "qwen/qwen3.6-27b"  # open-weights, vision-capable, Groq free tier

_groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


async def get_next_action(req: AgentStepRequest) -> AgentAction:
    try:
        if PROVIDER == "groq":
            raw = await _call_groq(req)
        elif PROVIDER == "local":
            raw = await _call_local(req)
        else:
            raw = await _call_cloud(req)

        # Normalize VLM JSON response to prevent Pydantic validation errors
        if not isinstance(raw, dict):
            raw = {"action": "wait", "reasoning": f"Expected JSON dict, got: {type(raw)}"}
        
        # Normalize action field
        action_val = str(raw.get("action", "")).strip().lower()
        # Handle common model naming variations
        if action_val in ["click_element", "click_btn", "click_button", "press"]:
            action_val = "click"
        elif action_val in ["type_text", "input", "write", "fill"]:
            action_val = "type"
        elif action_val in ["scroll_page", "swipe"]:
            action_val = "scroll"
        elif action_val in ["completed", "finish", "task_complete"]:
            action_val = "done"
        
        # Ensure it falls back to a valid enum option
        valid_actions = {a.value for a in ActionType}
        if action_val not in valid_actions:
            action_val = "wait"
        
        raw["action"] = action_val

        # Ensure reasoning is present
        if "reasoning" not in raw or not raw["reasoning"]:
            raw["reasoning"] = f"Decided to {action_val} based on page state."

        # Ensure task_complete matches action
        raw["task_complete"] = (action_val == "done")

        # Scroll direction validation
        if action_val == "scroll":
            sd = str(raw.get("scroll_direction", "")).strip().lower()
            if sd not in ["up", "down"]:
                raw["scroll_direction"] = "down"
            if not isinstance(raw.get("scroll_amount_px"), int):
                raw["scroll_amount_px"] = 400

        return AgentAction(**raw)

    except Exception as e:
        print("=== EXCEPTION CAUGHT IN GET_NEXT_ACTION ===")
        traceback.print_exc()
        return AgentAction(
            action=ActionType.ask_user,
            reasoning=f"System Error: {str(e)}. Please check backend logs or rate limits and try again."
        )


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
        # Qwen3.6 is a reasoning model — without this it spends an unbounded
        # chunk of max_completion_tokens on hidden chain-of-thought before
        # ever emitting the JSON answer. On the real (long) prompt this
        # regularly ate the whole budget and left nothing for the actual
        # response, which Groq then rejects as invalid JSON (400
        # json_validate_failed, empty failed_generation). Disabling it also
        # roughly quarters completion tokens per step, which matters a lot
        # given this key's 8000 TPM cap.
        reasoning_effort="none",
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

    def _format_history_entry(a):
        line = f"- {a.action}"
        if a.selector:
            line += f" on {a.selector}"
        if a.text:
            line += f' = "{a.text}"'
        line += f": {a.reasoning}"
        exec_result = getattr(a, "executionResult", None)
        if exec_result is not None:
            matched = exec_result.get("matched") if isinstance(exec_result, dict) else None
            reason = exec_result.get("reason") if isinstance(exec_result, dict) else None
            if matched is False:
                line += f"  [FAILED ({reason or 'unknown'}) — pick a different element or approach]"
            elif matched is True:
                line += "  [executed successfully]"
        elif a.action == "ask_user":
            line += "  [ALREADY FLAGGED for the user to fill in themselves — do not ask about this field again; move on to a different field, or say \"done\" if nothing else is left]"
        return line

    history_summary = "\n".join(_format_history_entry(a) for a in req.history)

    return f"""You control a browser to complete this task: {req.task}

You are looking at the CURRENT screenshot, taken after any actions listed
below already happened. Sensitive regions are already blacked out — do not
try to read or guess redacted content, work around it.

Visible interactive elements right now (from the DOM, already sanitized):
{dom_summary}

Actions taken so far, and whether they actually worked:
{history_summary or '(none yet)'}

Look at the CURRENT screenshot carefully before deciding. Only choose
"done" if the screenshot clearly shows the task is now complete — do not
mark a click or type action as done in the same turn you perform it; you
have not seen its effect yet. If a previous action failed, check why (shown
in brackets above) and try a different element or approach — do not repeat
the exact same failed action.

Fields marked [SENSITIVE] in the DOM list have had their real content
redacted before it ever reached you — you cannot see what's actually in
them, and typing a guessed value into one will be blocked. If the task
genuinely requires filling a sensitive field (e.g. a password), respond
with "ask_user" ONCE to flag it, then treat it as skipped — move on and
keep filling any other, non-sensitive fields the task still needs. Never
ask about the same field twice; the history below tells you which fields
are already flagged.

Some fields instead show a token like "{{profile.email}}" or
"{{profile.first_name}}" as their text — this means the user has that value
stored locally (name/email/phone/address/etc.) and it can be filled in
automatically. If the task calls for that kind of info in that field, use
action "type" with "text" set to EXACTLY that token, copied verbatim
(e.g. "{{profile.email}}") — never substitute what you think the real value
might be. The real value is resolved locally in the browser; you are only
ever choosing which token goes in which field.

Decide the single next action. Respond with ONLY a JSON object, no prose,
matching this shape:
{{
  "action": "click" | "type" | "scroll" | "wait" | "done" | "ask_user",
  "selector": "<css selector from the DOM list above, if click/type>",
  "text": "<text to type, if action is type>",
  "scroll_direction": "up" | "down",
  "scroll_amount_px": <integer>,
  "reasoning": "<one short sentence explaining this action>",
  "task_complete": <true only if action is \"done\", else false>
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