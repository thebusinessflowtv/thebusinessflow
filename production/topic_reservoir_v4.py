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
    client = Anthropic(api_key=core.need("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5"

    prompt = f"""
You are the audience-development editor for The Business Flow, a US-focused faceless business documentary YouTube channel.
The channel strategy is now FAMOUS COMPANIES FIRST.

NON-NEGOTIABLE AUDIENCE RULE
A viewer in the United States should usually recognize the company/brand before clicking. Household-name brand recognition is the single biggest ranking factor.

PRIORITY BRAND UNIVERSE
{json.dumps(PRIORITY_BRANDS, ensure_ascii=False)}

RECENT BUSINESS-DOCUMENTARY YOUTUBE SAMPLE
{json.dumps(youtube_sample, ensure_ascii=False)}

CURRENT READY QUEUE
{json.dumps(ready, ensure_ascii=False)}

ALL STORED TOPICS - DO NOT CREATE EXACT DUPLICATES
{json.dumps(all_names, ensure_ascii=False)}

Score EVERY current ready topic from 0-100 using these weights:
- 50% immediate US brand/company recognition;
- 20% curiosity/tension/reversal/hidden economics;
- 15% proven demand from the supplied YouTube outliers;
- 10% simple visual thumbnail potential;
- 5% evergreen longevity.

A lesser-known company or generic industry should NOT outrank Amazon, Coca-Cola, Meta, Tesla, SpaceX, Apple, Google, Microsoft, McDonald's, Walmart, Disney, Nike, Netflix, Costco, Nvidia, etc. merely because its story is dramatic.

Propose at least 20 new candidates. At least 16 must be about household-name companies or brands from the PRIORITY BRAND UNIVERSE that are not already stored. Elon Musk companies are explicitly encouraged: Tesla, SpaceX, X and xAI can each have their own documentary angles.

PACKAGING RULES
- Every title_seed MUST explicitly contain the company or brand name.
- Avoid generic title seeds like 'The Lie', 'The Collapse', 'They Fooled Everyone' without the brand name.
- thumbnail_text_seed can be 0-4 words, but the visual concept implied by the topic must use a recognizable brand element: logo, flagship product, founder/CEO, storefront, packaging, vehicle, app icon or other instantly recognizable asset.
- Prefer angles like hidden economics, strange profit engines, impossible scale, business-model contradictions, expensive mistakes, strategic reversals, monopoly-like moats, distribution machines and founder bets.
- Aggressive factual clickbait is good. Do not invent crimes, numbers, motives, accusations or outcomes.

Call submit_topic_reservoir exactly once with all {len(ready)} scores and at least 20 candidates. Keep explanations concise.
""".strip()

    response = client.messages.create(
        model=model,
        max_tokens=16000,
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
