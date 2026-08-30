"""
Pydantic models mirroring shared/action_schema.json.
Keep these two in sync manually for now — if this drifts, add a test in
server/tests that loads the JSON schema and validates AgentAction against it.
"""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class ActionType(str, Enum):
    click = "click"
    type = "type"
    scroll = "scroll"
    wait = "wait"
    done = "done"
    ask_user = "ask_user"


class ScrollDirection(str, Enum):
    up = "up"
    down = "down"


class DomNode(BaseModel):
    selector: str
    tag: str
    role: Optional[str] = None
    text: str
    box: dict  # {x, y, w, h}
    sensitive: bool = False


class AgentStepRequest(BaseModel):
    task: str
    image: str = Field(..., description="Redacted screenshot as a data URL")
    dom: list[DomNode]
    history: list["AgentAction"] = Field(default_factory=list)


class AgentAction(BaseModel):
    action: ActionType
    selector: Optional[str] = None
    text: Optional[str] = None
    scroll_direction: Optional[ScrollDirection] = None
    scroll_amount_px: Optional[int] = None
    reasoning: str
    task_complete: bool = False
    executionResult: Optional[dict] = Field(
        default=None,
        description="Set client-side after execution: {'matched': bool}. "
        "Not set by the model — sent back in history so the model can see "
        "whether its own past actions actually worked.",
    )


AgentStepRequest.model_rebuild()