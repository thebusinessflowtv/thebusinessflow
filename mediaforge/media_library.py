from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class MediaAsset:
    asset_id: str
    filename: str
    asset_type: str
    category: str
    tags: tuple[str, ...]
    company: str | None
    storage_uri: str | None
    commercial_use_status: str
    duplicate: bool

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "MediaAsset":
        return cls(
            asset_id=str(row.get("asset_id") or ""),
            filename=str(row.get("filename") or ""),
            asset_type=str(row.get("type") or ""),
            category=str(row.get("category") or "generic"),
            tags=tuple(str(v).lower() for v in (row.get("tags") or []) if str(v).strip()),
            company=(str(row.get("company")).strip() if row.get("company") else None),
            storage_uri=(str(row.get("storage_uri")).strip() if row.get("storage_uri") else None),
            commercial_use_status=str(row.get("commercial_use_status") or "review_required"),
            duplicate=bool(row.get("duplicate")),
        )


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def load_catalog(path: str | Path) -> list[MediaAsset]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [MediaAsset.from_row(row) for row in data.get("assets") or []]


def _score(asset: MediaAsset, query_tokens: set[str], company: str | None, preferred_categories: set[str]) -> float:
    haystack = tokenize(" ".join([asset.filename, asset.category, asset.company or "", *asset.tags]))
    overlap = len(query_tokens & haystack)
    score = float(overlap * 10)
    if company and asset.company and company.lower() == asset.company.lower():
        score += 35
    if asset.category in preferred_categories:
        score += 12
    if asset.asset_type == "video":
        score += 3
    if asset.duplicate:
        score -= 30
    return score


def select_assets(
    assets: Iterable[MediaAsset],
    *,
    query: str,
    limit: int = 20,
    company: str | None = None,
    preferred_categories: Iterable[str] = (),
    require_approved_license: bool = True,
    asset_type: str | None = None,
    exclude_ids: Iterable[str] = (),
    seed: int = 0,
) -> list[MediaAsset]:
    """Rank reusable B-roll without reusing blocked/unapproved assets.

    Production should call this per documentary segment and pass already-used IDs in
    ``exclude_ids``. That makes unique-per-video selection explicit instead of relying
    on a soft reuse penalty.
    """
    query_tokens = tokenize(query)
    preferred = {str(value).strip().lower() for value in preferred_categories if str(value).strip()}
    excluded = set(exclude_ids)
    candidates: list[tuple[float, float, MediaAsset]] = []
    rng = random.Random(seed)

    for asset in assets:
        if not asset.asset_id or asset.asset_id in excluded:
            continue
        if asset_type and asset.asset_type != asset_type:
            continue
        if require_approved_license and asset.commercial_use_status != "approved":
            continue
        score = _score(asset, query_tokens, company, preferred)
        if score <= 0:
            continue
        # deterministic jitter breaks ties without making selection unstable.
        candidates.append((score, rng.random(), asset))

    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [asset for _, _, asset in candidates[: max(0, int(limit))]]
