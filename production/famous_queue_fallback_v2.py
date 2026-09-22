from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from famous_queue_fallback import SEEDS

ROOT = Path(__file__).resolve().parents[1]
TOPICS = ROOT / "production" / "topics.json"
TARGET_READY = 50

EXTRA_SEEDS = [
    ("Oracle", "How Oracle Built a Software Empire That Companies Can't Easily Leave", "HARD TO LEAVE", 50, "software/cloud"),
    ("Salesforce", "How Salesforce Turned Subscriptions Into a Software Empire", "SUBSCRIPTION EMPIRE", 49, "software/cloud"),
    ("Adobe", "How Adobe Turned Creative Software Into a Subscription Machine", "ADOBE MACHINE", 48, "software/subscriptions"),
    ("FedEx", "How FedEx Engineered Overnight Delivery at Massive Scale", "OVERNIGHT MACHINE", 47, "logistics"),
    ("UPS", "How UPS Built One of America's Most Efficient Delivery Networks", "DELIVERY MACHINE", 46, "logistics"),
    ("Home Depot", "How Home Depot Built a Retail Fortress", "RETAIL FORTRESS", 45, "retail/home improvement"),
    ("Procter & Gamble", "How P&G Built a Portfolio of Brands You Use Every Day", "BRANDS EVERYWHERE", 44, "consumer goods"),
    ("Johnson & Johnson", "How Johnson & Johnson Built a Healthcare Giant", "HEALTHCARE GIANT", 43, "healthcare/consumer"),
    ("Pfizer", "How Pfizer Built a Global Drug Business", "PHARMA SCALE", 42, "pharma"),
    ("ExxonMobil", "How ExxonMobil Built an Energy Giant", "ENERGY GIANT", 41, "energy"),
    ("Chevron", "How Chevron Makes Money Across the Oil Supply Chain", "OIL MACHINE", 40, "energy"),
    ("Shell", "How Shell Built a Global Energy Machine", "GLOBAL ENERGY", 39, "energy"),
    ("Lowe's", "How Lowe's Competes With Home Depot", "HOME IMPROVEMENT WAR", 38, "retail/home improvement"),
    ("Kroger", "How Kroger Built a Grocery Empire on Thin Margins", "THIN MARGINS", 37, "retail/grocery"),
    ("CVS Health", "How CVS Became Much More Than a Pharmacy", "MORE THAN PHARMACY", 36, "healthcare/retail"),
    ("Warner Bros. Discovery", "How Warner Bros. Discovery Is Trying to Make Streaming Economics Work", "STREAMING MATH", 35, "media/streaming"),
    ("Paramount", "How Paramount Is Fighting for Relevance in Streaming", "STREAMING FIGHT", 34, "media/streaming"),
    ("American Express", "How American Express Makes Premium Customers More Valuable", "PREMIUM MONEY", 33, "payments/finance"),
    ("Morgan Stanley", "How Morgan Stanley Makes Money From Wealth", "WEALTH MACHINE", 32, "finance"),
    ("BlackRock", "How BlackRock Became an Investing Giant", "ASSET GIANT", 31, "finance/investing"),
]


def norm(value: str) -> str:
    return value.lower().replace("’", "'").strip()


def seed_to_topic(seed, index: int, status: str, now: str) -> dict:
    company, title, thumb, score, category = seed
    return {
        "id": f"famous-{index:03d}",
        "topic": company,
        "category": category,
        "working_angle": title,
        "title_seed": title,
        "thumbnail_text_seed": thumb,
        "status": status,
        "click_score": score,
        "click_reason": "Deterministic famous-company reserve; brand recognition prioritized.",
        "scored_at": now,
    }


def main() -> None:
    data = json.loads(TOPICS.read_text(encoding="utf-8")) if TOPICS.exists() else {"topics": []}
    now = datetime.now(timezone.utc).isoformat()
    old_topics = data.get("topics") or []

    used = [t for t in old_topics if t.get("status") in {"used", "rendered_pending_manual_upload"}]
    used_names = {norm(str(t.get("topic") or "")) for t in used}

    combined = SEEDS + EXTRA_SEEDS
    available = [seed for seed in combined if norm(seed[0]) not in used_names]
    ready_seeds = available[:TARGET_READY]
    backlog_seeds = available[TARGET_READY:]

    if len(ready_seeds) != TARGET_READY:
        raise RuntimeError(f"Famous-company pool cannot maintain {TARGET_READY} unused ready topics; found {len(ready_seeds)}")

    ready = [seed_to_topic(seed, i + 1, "ready", now) for i, seed in enumerate(ready_seeds)]
    backlog = [
        seed_to_topic(seed, TARGET_READY + i + 1, "backlog", now)
        for i, seed in enumerate(backlog_seeds)
    ]

    canonical_names = {norm(seed[0]) for seed in combined}
    preserved_extra = [
        t for t in old_topics
        if t.get("status") == "backlog" and norm(str(t.get("topic") or "")) not in canonical_names
    ]

    data["topics"] = ready + backlog + preserved_extra + used
    data["reservoir"] = {
        "target_ready": TARGET_READY,
        "ready_count": len(ready),
        "backlog_count": len(backlog) + len(preserved_extra),
        "last_refreshed_at": now,
        "ranking": "famous_company_reserve",
        "anthropic_optional_optimizer": True,
        "used_topics_preserved": len(used),
    }
    TOPICS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ready_topics": len(ready),
        "backlog_topics": len(backlog) + len(preserved_extra),
        "used_topics": len(used),
        "top_topic": ready[0]["topic"],
    }, indent=2))


if __name__ == "__main__":
    main()
