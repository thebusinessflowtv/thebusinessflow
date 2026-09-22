from __future__ import annotations

import json
import os

import topic_reservoir_v3 as core
from anthropic import Anthropic

PRIORITY_BRANDS = [
    "Amazon", "Coca-Cola", "Meta", "Facebook", "Instagram", "Tesla", "SpaceX", "X", "xAI",
    "Apple", "Google", "YouTube", "Microsoft", "Nvidia", "OpenAI", "Walmart", "Costco",
    "McDonald's", "Starbucks", "Nike", "Disney", "Netflix", "PepsiCo", "Uber", "Airbnb",
    "Boeing", "Ford", "General Motors", "Visa", "Mastercard", "JPMorgan Chase", "Goldman Sachs",
    "Bank of America", "PayPal", "eBay", "Intel", "AMD", "Samsung", "Sony", "Toyota", "Ferrari",
    "Adidas", "Target", "Home Depot", "IKEA", "LVMH", "Rolex", "Red Bull", "Budweiser",
    "Domino's", "KFC", "Burger King", "Chipotle", "Uber Eats", "DoorDash", "Spotify", "TikTok",
]


def ask_famous_anthropic(youtube_sample, data):
    topics = data.get("topics") or []
    ready = [t for t in topics if t.get("status") == "ready"]
    all_names = [str(t.get("topic") or "") for t in topics]
    client = Anthropic(api_key=core.need("ANTHROPIC_API_KEY"), max_retries=0)
    model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001").strip() or "claude-haiku-4-5-20251001"

    # Send only compact fields to keep weekly input/output spend low.
    compact_ready = [
        {
            "id": t.get("id"),
            "topic": t.get("topic"),
            "title_seed": t.get("title_seed"),
            "click_score": t.get("click_score"),
        }
        for t in ready
    ]
    compact_sample = (youtube_sample or [])[:30] if isinstance(youtube_sample, list) else youtube_sample

    prompt = f"""
You are the audience-development editor for The Business Flow, a US business-documentary YouTube channel.
FAMOUS COMPANIES FIRST. Keep every explanation extremely concise.

PRIORITY BRANDS
{json.dumps(PRIORITY_BRANDS, ensure_ascii=False)}

RECENT YOUTUBE SAMPLE
{json.dumps(compact_sample, ensure_ascii=False)}

CURRENT READY QUEUE
{json.dumps(compact_ready, ensure_ascii=False)}

ALL STORED COMPANY NAMES — DO NOT DUPLICATE
{json.dumps(all_names, ensure_ascii=False)}

Score every ready topic 0-100 using: 50% US brand recognition, 20% curiosity/tension, 15% demand signal, 10% thumbnail potential, 5% evergreen longevity.
Household brands should normally outrank obscure companies.
Propose at least 20 unused household-name company topics.
Every title_seed must contain the company/brand name. Factual clickbait only; no invented crimes, numbers, motives or outcomes.
Thumbnail text: maximum 4 words.

Call submit_topic_reservoir exactly once. Output only what the tool requires; no extra prose.
""".strip()

    response = client.messages.create(
        model=model,
        max_tokens=4500,
        tools=[core.TOOL],
        tool_choice={"type": "tool", "name": "submit_topic_reservoir"},
        messages=[{"role": "user", "content": prompt}],
    )
    calls = [
        block for block in response.content
        if getattr(block, "type", None) == "tool_use"
        and getattr(block, "name", None) == "submit_topic_reservoir"
    ]
    if not calls:
        raise RuntimeError("Anthropic did not return structured topic reservoir output")
    result = calls[0].input
    if len(result.get("scores") or []) != len(ready):
        raise RuntimeError(f"Expected {len(ready)} scored topics, got {len(result.get('scores') or [])}")
    candidates = result.get("candidates") or []
    if len(candidates) < 20:
        raise RuntimeError(f"Expected at least 20 candidates, got {len(candidates)}")
    result["candidates"] = sorted(candidates, key=lambda c: int(c.get("click_score") or 0), reverse=True)[:20]
    return result


if __name__ == "__main__":
    core.ask_anthropic = ask_famous_anthropic
    core.main()
