"""
prompt_shield.py — On-Device & Backend Prompt Injection Shield

Provides detection, sanitization, and output verification to defend the VLM-based
Browser Vision Agent against direct and indirect prompt injection attacks (e.g.
malicious web page DOM injection, system override directives, tag escape attacks).
"""

import re
from typing import Tuple, Dict, Any, List, Optional

# Patterns targeting common prompt injection / jailbreak / system instruction override tactics
PROMPT_INJECTION_PATTERNS = [
    # Direct system instruction overrides
    r"\b(?:ignore|disregard|forget|override|cancel|bypass)\s+(?:all\s+)?(?:previous|prior|above|former|system)?\s+(?:instructions|prompts|directives|rules|constraints|context)\b",
    r"\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions|directives|task|role|prompt)\s*:\b",
    r"\byou\s+are\s+now\s+(?:a|an|in)?\s*(?:developer\s+mode|dan|jailbreak|unrestricted|god\s+mode)\b",
    r"\bact\s+as\s+(?:a|an)?\s*(?:unrestricted|unfiltered|jailbroken|evil)\s+assistant\b",
    r"\bdo\s+anything\s+now\b",
    
    # Prompt delimiter / boundary hijacking
    r"<\|im_start\|>",
    r"<\|im_end\|>",
    r"\[\s*SYSTEM\s*INSTRUCTION\s*\]",
    r"\[\s*DEVELOPER\s*MODE\s*\]",
    r"<\s*/?\s*system\s*>",
    r"<\s*/?\s*user_task\s*>",
    r"<\s*/?\s*untrusted_web_page_dom\s*>",
    r"```\s*(?:system|prompt|instruction)",

    # Data exfiltration & malicious action triggers via web page DOM
    r"\b(?:send|exfiltrate|transmit|post|upload)\s+(?:all\s+)?(?:tokens|passwords|credentials|cookies|keys|pii|data)\s+to\b",
    r"\bcurl\s+-[Xd]\b",
    r"\bfetch\s*\(\s*['\"]https?://",
    r"\bwindow\.location\s*=",
]

_COMPILED_INJECTION_REGEX = re.compile("|".join(PROMPT_INJECTION_PATTERNS), flags=re.IGNORECASE)


def detect_prompt_injection(text: str) -> Dict[str, Any]:
    """
    Scans input text (user task or DOM element text) for prompt injection patterns.
    Returns details on whether an injection attempt was detected.
    """
    if not text:
        return {"is_injection": False, "matches": [], "confidence": 0.0}

    matches = _COMPILED_INJECTION_REGEX.findall(text)
    is_injection = len(matches) > 0
    confidence = 1.0 if is_injection else 0.0

    return {
        "is_injection": is_injection,
        "matches": matches,
        "confidence": confidence,
    }


def sanitize_dom_text(text: str) -> Tuple[str, bool]:
    """
    Sanitizes untrusted DOM text to prevent prompt injection and tag breaking.
    - Neutralizes prompt tags / boundary delimiters.
    - Replaces explicit injection overrides with a safe placeholder.
    Returns (sanitized_text, is_sanitized_flag).
    """
    if not text:
        return text, False

    original = text
    sanitized = text

    # 1. Check for malicious instruction override keywords first and replace/flag them
    if _COMPILED_INJECTION_REGEX.search(sanitized):
        def _replace_match(match):
            return f"[PROMPT INJECTION NEUTRALIZED: '{match.group(0)}']"
        sanitized = _COMPILED_INJECTION_REGEX.sub(_replace_match, sanitized)

    # 2. Escape potential prompt delimiters to prevent breaking prompt XML tags
    sanitized = re.sub(r"<\|", "&lt;|", sanitized)
    sanitized = re.sub(r"\|>", "|&gt;", sanitized)
    sanitized = re.sub(r"<\s*(/?)\s*(system|user_task|untrusted_web_page_dom|execution_history)\s*>", r"&lt;\1\2&gt;", sanitized, flags=re.IGNORECASE)

    was_modified = (sanitized != original)
    return sanitized, was_modified


def verify_action_safety(action: Any, task: str) -> Tuple[bool, Optional[str]]:
    """
    Verifies that the generated VLM action is safe and has not been hijacked
    by an indirect prompt injection attack.
    Returns (is_safe, refusal_reason).
    """
    action_type = getattr(action, "action", "")
    text = getattr(action, "text", "") or ""
    selector = getattr(action, "selector", "") or ""

    # Check if the text to type contains a prompt injection attack payload
    injection_res = detect_prompt_injection(text)
    if injection_res["is_injection"]:
        return False, f"Blocked: Action text contains prompt injection payload ({injection_res['matches'][0]})"

    # Check if selector looks like a suspicious injection vector
    selector_res = detect_prompt_injection(selector)
    if selector_res["is_injection"]:
        return False, f"Blocked: Action selector contains prompt injection payload ({selector_res['matches'][0]})"

    return True, None
