from __future__ import annotations

from typing import Any

WEB_SEARCH_USD_PER_REQUEST = 0.01

MODEL_PRICING_PER_MILLION = {
    "haiku": {"input": 1.0, "output": 5.0},
    "sonnet": {"input": 2.0, "output": 10.0},
}


def model_family(model: str) -> str:
    low = (model or "").lower()
    if "haiku" in low:
        return "haiku"
    if "sonnet" in low:
        return "sonnet"
    raise ValueError(f"Unsupported model for local cost guard: {model}")


def usage_dict(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage", None)
    server_tool_use = getattr(usage, "server_tool_use", None)
    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        "cache_creation_input_tokens": int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
        "cache_read_input_tokens": int(getattr(usage, "cache_read_input_tokens", 0) or 0),
        "web_search_requests": int(getattr(server_tool_use, "web_search_requests", 0) or 0),
    }


def estimate_cost_usd(model: str, usage: dict[str, int]) -> float:
    pricing = MODEL_PRICING_PER_MILLION[model_family(model)]
    # Conservative: if cache fields ever appear, count them at full input price.
    input_like = (
        int(usage.get("input_tokens", 0))
        + int(usage.get("cache_creation_input_tokens", 0))
        + int(usage.get("cache_read_input_tokens", 0))
    )
    output = int(usage.get("output_tokens", 0))
    searches = int(usage.get("web_search_requests", 0))
    cost = (
        input_like / 1_000_000 * pricing["input"]
        + output / 1_000_000 * pricing["output"]
        + searches * WEB_SEARCH_USD_PER_REQUEST
    )
    return round(cost, 6)


def safe_response_snapshot(response: Any, allowed_tool_names: set[str] | None = None) -> dict[str, Any]:
    """Persist model-produced text/client tool calls, never raw web-search result bodies."""
    allowed_tool_names = allowed_tool_names or set()
    content: list[dict[str, Any]] = []
    for block in getattr(response, "content", []) or []:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            content.append({"type": "text", "text": str(getattr(block, "text", ""))})
        elif block_type == "tool_use":
            name = str(getattr(block, "name", ""))
            if name in allowed_tool_names:
                content.append(
                    {
                        "type": "tool_use",
                        "name": name,
                        "input": getattr(block, "input", {}),
                    }
                )
    return {
        "id": str(getattr(response, "id", "")),
        "model": str(getattr(response, "model", "")),
        "stop_reason": str(getattr(response, "stop_reason", "")),
        "usage": usage_dict(response),
        "content": content,
    }
