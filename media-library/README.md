# The Business Flow Media Library

This folder contains the **catalog and rules**, not the heavy binary media itself.

The reusable photos and B-roll videos live in object storage. GitHub stores only metadata, schemas, selection logic and generated catalog snapshots.

## Structure

```text
media-library/
  README.md
  catalog.schema.json
  generated/
    catalog.json
    summary.json
```

The binary storage layout is namespaced for this channel:

```text
thebusinessflow/
  media-library/
    companies/
    corporate/
    finance/
    retail/
    technology/
    manufacturing/
    automotive/
    real-estate/
    luxury/
    american-life/
    historical/
    generic/
```

## Catalog rules

Every asset receives a stable `asset_id`, SHA-256 checksum, type, category, dimensions and (for videos) duration. Exact duplicate hashes are marked so MediaForge can avoid unnecessary reuse.

Licensing fields are deliberately conservative. Assets remain `review_required` until their reuse rights are confirmed. The production resolver must not assume that a file is safe for commercial YouTube use merely because it exists in the library.

## Build locally

```bash
python tools/build_media_catalog.py "/path/to/Company Vault.zip" --output-dir media-library/generated
```

Requirements for full metadata extraction:

- Python 3.11+
- FFmpeg/ffprobe
- Pillow (`pip install pillow`)

The generated `catalog.json` is the source MediaForge will use for semantic asset selection after topic tags and company metadata are enriched.
