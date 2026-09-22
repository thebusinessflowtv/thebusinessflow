#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import quote

import requests

DEFAULT_BUCKET = os.getenv('THEBUSINESSFLOW_MEDIA_BUCKET', 'mediaforge-assets')
DEFAULT_PREFIX = os.getenv('THEBUSINESSFLOW_MEDIA_PREFIX', 'thebusinessflow/media-library').strip('/')


def require_env() -> tuple[str, str]:
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    service_role = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    secret_key = os.getenv('SUPABASE_SECRET_KEY', '').strip()

    if not url:
        raise SystemExit('SUPABASE_URL is required')

    # This uploader calls the raw Storage REST endpoint directly. In this flow the
    # Storage service requires a Bearer JWT in Authorization. Use the legacy
    # service_role JWT for that header. Modern sb_secret_* keys are opaque API keys,
    # not JWTs, and cannot be used as Bearer tokens here.
    if service_role:
        return url, service_role

    if secret_key.startswith('sb_secret_'):
        raise SystemExit(
            'This raw Storage uploader requires the Legacy service_role JWT, not an sb_secret_* key. '
            'Set SUPABASE_SERVICE_ROLE_KEY from Supabase Settings > API Keys > Legacy API Keys > service_role.'
        )

    # Backward compatibility: an older JWT may have been stored under the secret env var.
    if secret_key:
        return url, secret_key

    raise SystemExit('SUPABASE_SERVICE_ROLE_KEY is required for direct Storage upload')


def headers(key: str, content_type: str | None = None, upsert: bool = True) -> dict[str, str]:
    out = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
    }
    if content_type:
        out['Content-Type'] = content_type
    if upsert:
        out['x-upsert'] = 'true'
    return out


def upload_file(base_url: str, key: str, bucket: str, object_path: str, local_path: Path) -> None:
    mime = 'application/octet-stream'
    ext = local_path.suffix.lower()
    if ext in {'.jpg', '.jpeg'}:
        mime = 'image/jpeg'
    elif ext == '.png':
        mime = 'image/png'
    elif ext == '.webp':
        mime = 'image/webp'
    elif ext == '.mp4':
        mime = 'video/mp4'
    elif ext == '.mov':
        mime = 'video/quicktime'
    elif ext == '.json':
        mime = 'application/json'

    url = f"{base_url}/storage/v1/object/{bucket}/{quote(object_path, safe='/')}"
    with local_path.open('rb') as handle:
        response = requests.post(url, headers=headers(key, mime), data=handle, timeout=(30, 900))
    if response.status_code >= 400:
        raise RuntimeError(f'Upload failed for {object_path}: HTTP {response.status_code} {response.text[:500]}')


def main() -> None:
    parser = argparse.ArgumentParser(description='Upload The Business Flow organized media library to Supabase Storage.')
    parser.add_argument('library_dir', type=Path, help='Directory produced by build_media_catalog.py')
    parser.add_argument('--bucket', default=DEFAULT_BUCKET)
    parser.add_argument('--prefix', default=DEFAULT_PREFIX)
    args = parser.parse_args()

    root = args.library_dir.resolve()
    organized = root / 'organized'
    catalog = root / 'catalog.json'
    if not organized.is_dir() or not catalog.is_file():
        raise SystemExit('Expected organized/ and catalog.json inside library_dir')

    base_url, key = require_env()
    files = sorted(p for p in organized.rglob('*') if p.is_file())
    total = len(files)
    for index, path in enumerate(files, start=1):
        rel = path.relative_to(organized).as_posix()
        object_path = f"{args.prefix}/{rel}"
        upload_file(base_url, key, args.bucket, object_path, path)
        print(f'[{index}/{total}] uploaded {object_path}')

    catalog_object = f"{args.prefix}/catalog.json"
    upload_file(base_url, key, args.bucket, catalog_object, catalog)

    print(json.dumps({
        'uploaded_files': total,
        'bucket': args.bucket,
        'prefix': args.prefix,
        'catalog_uri': f'supabase://{args.bucket}/{catalog_object}'
    }, indent=2))


if __name__ == '__main__':
    main()
