#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
from pathlib import Path

import requests
from supabase import create_client

DEFAULT_BUCKET = os.getenv('THEBUSINESSFLOW_MEDIA_BUCKET', 'mediaforge-assets')
DEFAULT_PREFIX = os.getenv('THEBUSINESSFLOW_MEDIA_PREFIX', 'thebusinessflow/media-library').strip('/')
EXPECTED_PROJECT_REF = 'rhddgfvtrkmusbvphnlg'


def require_env() -> tuple[str, str]:
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    key = (os.getenv('SUPABASE_SECRET_KEY', '') or os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')).strip()
    if not url or not key:
        raise SystemExit('SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required')
    return url, key


def validate_key(base_url: str, key: str) -> None:
    """Fail before any upload when the pasted key is invalid or belongs to another project."""
    response = requests.get(
        f'{base_url}/rest/v1/',
        headers={'apikey': key},
        timeout=(20, 30),
    )
    if response.status_code >= 400:
        raise RuntimeError(
            'Supabase key validation failed before upload. '
            f'HTTP {response.status_code}: {response.text[:500]}\n'
            f'Use a Secret key (sb_secret_...) from project {EXPECTED_PROJECT_REF} (Portal Leonidanos).'
        )


def mime_for(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    ext = path.suffix.lower()
    overrides = {
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.m4v': 'video/x-m4v',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.json': 'application/json',
    }
    return overrides.get(ext, 'application/octet-stream')


def upload_with_retry(bucket_client, object_path: str, local_path: Path, attempts: int = 4) -> None:
    mime = mime_for(local_path)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with local_path.open('rb') as handle:
                bucket_client.upload(
                    path=object_path,
                    file=handle,
                    file_options={
                        'content-type': mime,
                        'upsert': 'true',
                        'cache-control': '3600',
                    },
                )
            return
        except Exception as exc:
            last_error = exc
            if attempt >= attempts:
                break
            delay = min(2 ** attempt, 10)
            print(f'  retrying in {delay}s after upload error: {exc}', file=sys.stderr)
            time.sleep(delay)
    raise RuntimeError(f'Upload failed for {object_path}: {last_error}')


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
    print(f'Validating Supabase key against project {EXPECTED_PROJECT_REF}...')
    validate_key(base_url, key)
    print('Supabase key validated.')

    client = create_client(base_url, key)
    bucket_client = client.storage.from_(args.bucket)

    files = sorted(p for p in organized.rglob('*') if p.is_file())
    total = len(files)
    for index, path in enumerate(files, start=1):
        rel = path.relative_to(organized).as_posix()
        object_path = f'{args.prefix}/{rel}'
        upload_with_retry(bucket_client, object_path, path)
        print(f'[{index}/{total}] uploaded {object_path}')

    catalog_object = f'{args.prefix}/catalog.json'
    upload_with_retry(bucket_client, catalog_object, catalog)

    print(json.dumps({
        'uploaded_files': total,
        'bucket': args.bucket,
        'prefix': args.prefix,
        'catalog_uri': f'supabase://{args.bucket}/{catalog_object}'
    }, indent=2))


if __name__ == '__main__':
    main()
