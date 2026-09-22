# The Business Flow Media Library

The reusable photos and B-roll videos for **The Business Flow** live in this same GitHub repository.

Heavy binary files are stored with **Git LFS** under:

```text
media-library/assets/
```

Git stores the catalog, schemas, selection logic and the LFS pointers; Git LFS stores the actual media objects.

## Structure

```text
media-library/
  README.md
  catalog.schema.json
  catalog.json
  summary.json
  assets/
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

Each published asset contains a repository path and a `github-lfs://thebusinessflowtv/thebusinessflow/...` media URI.

Licensing fields are deliberately conservative. Assets remain `review_required` until their reuse rights are confirmed. The production resolver must not assume that a file is safe for commercial YouTube use merely because it exists in the library.

## Local import

The Dell/Windows importer can build the catalog and publish the assets directly to this repository with Git LFS:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\windows_import_media.ps1
```

If the ZIP has already been analyzed and organized, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\windows_import_media.ps1 -PublishOnly
```

No external object storage is used by this project.
