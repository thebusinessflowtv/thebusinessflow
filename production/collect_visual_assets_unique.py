from __future__ import annotations

"""Active visual collector for The Business Flow.

Visual Intelligence V2 is installed before the proven zero-reuse collector is
loaded. This preserves the existing download/dedup/render contract while
upgrading discovery, query specificity and image ranking.
"""

import json

import collect_visual_assets as profiles
import visual_intelligence_v2

visual_intelligence_v2.install(profiles.core)

import collect_visual_assets_unique_legacy as legacy

# The legacy collector resolves all candidate/search functions through ``core``.
# Point it at the now-patched core explicitly so every production run uses V2.
legacy.core = profiles.core

_original_write_manifest = legacy.write_manifest


def _write_manifest_v2(*args, **kwargs):
    manifest = _original_write_manifest(*args, **kwargs)
    manifest.update(
        {
            "profile_version": "hq-v4-visual-intelligence",
            "visual_intelligence": "v2",
            "exact_topic_queries": True,
            "official_source_priority": True,
            "high_resolution_priority": True,
            "freshness_ranking": True,
            "generic_visual_penalty": True,
        }
    )
    path = args[0] if args else kwargs.get("path")
    if path is not None:
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


legacy.write_manifest = _write_manifest_v2

# Re-export the stable public surface used by workflows/tests.
canonical_url = legacy.canonical_url
dhash = legacy.dhash
phash_distance = legacy.phash_distance
load_registry = legacy.load_registry
registry_index = legacy.registry_index
previously_used = legacy.previously_used
write_manifest = _write_manifest_v2
collect = legacy.collect
main = legacy.main


if __name__ == "__main__":
    main()
