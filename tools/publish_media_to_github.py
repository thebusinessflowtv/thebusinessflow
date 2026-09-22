#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

REPOSITORY = "thebusinessflowtv/thebusinessflow"
ASSETS_ROOT = Path("media-library/assets")
CATALOG_DEST = Path("media-library/catalog.json")
SUMMARY_DEST = Path("media-library/summary.json")


def copy_tree(source: Path, destination: Path) -> int:
    copied = 0
    for path in sorted(p for p in source.rglob("*") if p.is_file()):
        rel = path.relative_to(source)
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied += 1
    return copied


def rewrite_catalog(staging_dir: Path, repo_root: Path) -> tuple[Path, Path, int]:
    source_catalog = staging_dir / "catalog.json"
    source_summary = staging_dir / "summary.json"
    organized = staging_dir / "organized"

    if not source_catalog.is_file():
        raise SystemExit(f"Missing staging catalog: {source_catalog}")
    if not source_summary.is_file():
        raise SystemExit(f"Missing staging summary: {source_summary}")
    if not organized.is_dir():
        raise SystemExit(f"Missing organized media directory: {organized}")

    catalog = json.loads(source_catalog.read_text(encoding="utf-8"))
    summary = json.loads(source_summary.read_text(encoding="utf-8"))

    assets_root_abs = repo_root / ASSETS_ROOT
    assets_root_abs.mkdir(parents=True, exist_ok=True)
    copied = copy_tree(organized, assets_root_abs)

    for asset in catalog.get("assets") or []:
        organized_path = str(asset.get("organized_path") or "")
        marker = "organized/"
        normalized = organized_path.replace("\\", "/")
        if marker in normalized:
            rel = normalized.split(marker, 1)[1]
        else:
            filename = str(asset.get("filename") or "")
            category = str(asset.get("category") or "generic")
            asset_type = str(asset.get("type") or "image")
            rel = f"{category}/{asset_type}/{filename}"

        repo_path = (ASSETS_ROOT / Path(rel)).as_posix()
        asset["repo_path"] = repo_path
        asset["storage_uri"] = f"github-lfs://{REPOSITORY}/{repo_path}"

    catalog.pop("storage_bucket", None)
    catalog.pop("storage_prefix", None)
    catalog["media_provider"] = "github_lfs"
    catalog["repository"] = REPOSITORY
    catalog["assets_root"] = ASSETS_ROOT.as_posix()

    summary.pop("storage_bucket", None)
    summary.pop("storage_prefix", None)
    summary["media_provider"] = "github_lfs"
    summary["repository"] = REPOSITORY
    summary["assets_root"] = ASSETS_ROOT.as_posix()
    summary["published_asset_files"] = copied

    catalog_dest = repo_root / CATALOG_DEST
    summary_dest = repo_root / SUMMARY_DEST
    catalog_dest.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_dest.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return catalog_dest, summary_dest, copied


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare The Business Flow media library for GitHub LFS publication.")
    parser.add_argument("staging_dir", type=Path, help="Directory containing organized/, catalog.json and summary.json")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    staging_dir = args.staging_dir.resolve()
    catalog, summary, copied = rewrite_catalog(staging_dir, repo_root)

    print(json.dumps({
        "repository": REPOSITORY,
        "media_provider": "github_lfs",
        "assets_root": str(repo_root / ASSETS_ROOT),
        "copied_assets": copied,
        "catalog": str(catalog),
        "summary": str(summary),
    }, indent=2))


if __name__ == "__main__":
    main()
