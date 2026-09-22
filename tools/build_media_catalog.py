#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any

VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'}
MEDIA_EXTS = VIDEO_EXTS | IMAGE_EXTS
DEFAULT_BUCKET = os.getenv('THEBUSINESSFLOW_MEDIA_BUCKET', 'mediaforge-assets')
DEFAULT_PREFIX = os.getenv('THEBUSINESSFLOW_MEDIA_PREFIX', 'thebusinessflow/media-library').strip('/')

CATEGORY_KEYWORDS: dict[str, list[str]] = {
    'companies': [
        'amazon', 'apple', 'google', 'meta', 'facebook', 'tesla', 'microsoft',
        'walmart', 'costco', 'mcdonald', 'starbucks', 'nike', 'adidas',
        'netflix', 'disney', 'boeing', 'nvidia', 'intel', 'ibm', 'uber',
        'airbnb', 'wework', 'blackberry', 'kodak', 'blockbuster', 'sears',
        'enron', 'coca', 'pepsi', 'ford', 'general motors'
    ],
    'finance': ['wall street', 'stock', 'market', 'trading', 'bank', 'money', 'dollar', 'finance', 'credit', 'cash', 'investment'],
    'corporate': ['office', 'boardroom', 'meeting', 'executive', 'ceo', 'employee', 'presentation', 'headquarters', 'corporate', 'skyscraper'],
    'retail': ['store', 'retail', 'supermarket', 'mall', 'shopping', 'warehouse', 'checkout', 'consumer'],
    'technology': ['server', 'data center', 'computer', 'software', 'semiconductor', 'chip', 'robot', 'ai', 'technology', 'tech'],
    'manufacturing': ['factory', 'assembly', 'industrial', 'manufacturing', 'port', 'cargo', 'logistics', 'truck', 'shipping'],
    'automotive': ['car', 'vehicle', 'dealership', 'highway', 'automotive', 'electric vehicle', ' ev '],
    'real-estate': ['house', 'home', 'apartment', 'real estate', 'construction', 'building', 'office tower'],
    'luxury': ['private jet', 'yacht', 'mansion', 'luxury', 'watch', 'hotel'],
    'american-life': ['new york', 'los angeles', 'chicago', 'texas', 'suburb', 'airport', 'gas station', 'restaurant', 'city'],
    'historical': ['1950', '1960', '1970', '1980', '1990', '2000', 'historic', 'vintage', 'archive', 'old'],
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def ffprobe(path: Path) -> tuple[float | None, int | None, int | None]:
    try:
        raw = subprocess.check_output([
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration:stream=codec_type,width,height',
            '-of', 'json', str(path)
        ], stderr=subprocess.STDOUT, timeout=45)
        data = json.loads(raw)
        duration = float((data.get('format') or {}).get('duration') or 0) or None
        width = height = None
        for stream in data.get('streams') or []:
            if stream.get('codec_type') == 'video':
                width = int(stream.get('width') or 0) or None
                height = int(stream.get('height') or 0) or None
                break
        return duration, width, height
    except Exception:
        return None, None, None


def image_dimensions(path: Path) -> tuple[int | None, int | None]:
    try:
        from PIL import Image
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return None, None


def normalize_name(path: Path) -> str:
    return path.stem.lower().replace('_', ' ').replace('-', ' ')


def categorize(path: Path) -> str:
    name = f' {normalize_name(path)} '
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(keyword in name for keyword in keywords):
            return category
    return 'generic'


def safe_copy(source: Path, destination_dir: Path) -> Path:
    destination_dir.mkdir(parents=True, exist_ok=True)
    target = destination_dir / source.name
    if not target.exists():
        shutil.copy2(source, target)
        return target
    if sha256_file(source) == sha256_file(target):
        return target
    index = 2
    while True:
        candidate = destination_dir / f'{source.stem}-{index}{source.suffix.lower()}'
        if not candidate.exists():
            shutil.copy2(source, candidate)
            return candidate
        index += 1


def extract_if_zip(source: Path, temp_dir: Path) -> Path:
    if source.is_dir():
        return source
    if source.suffix.lower() != '.zip':
        raise SystemExit('Source must be a directory or .zip file')
    extracted = temp_dir / 'extracted'
    extracted.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        archive.extractall(extracted)
    return extracted


def build_catalog(source: Path, output_dir: Path, organize: bool) -> dict[str, Any]:
    temp_dir = output_dir / '.work'
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)
    root = extract_if_zip(source, temp_dir)

    media_files = sorted(
        [p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in MEDIA_EXTS],
        key=lambda p: str(p).lower(),
    )

    assets: list[dict[str, Any]] = []
    by_hash: dict[str, list[str]] = defaultdict(list)
    organized_root = output_dir / 'organized'

    for index, path in enumerate(media_files, start=1):
        rel = path.relative_to(root)
        kind = 'video' if path.suffix.lower() in VIDEO_EXTS else 'image'
        category = categorize(path)
        digest = sha256_file(path)
        by_hash[digest].append(str(rel))

        duration = None
        width = height = None
        if kind == 'video':
            duration, width, height = ffprobe(path)
        else:
            width, height = image_dimensions(path)

        organized_path = None
        storage_uri = None
        if organize:
            copied = safe_copy(path, organized_root / category / kind)
            relative_organized = copied.relative_to(organized_root).as_posix()
            organized_path = str(copied.relative_to(output_dir))
            storage_uri = f'supabase://{DEFAULT_BUCKET}/{DEFAULT_PREFIX}/{relative_organized}'

        assets.append({
            'asset_id': f'tbf-{index:04d}',
            'filename': path.name,
            'original_path': str(rel),
            'organized_path': organized_path,
            'storage_uri': storage_uri,
            'type': kind,
            'category': category,
            'mime_type': mimetypes.guess_type(path.name)[0],
            'size_bytes': path.stat().st_size,
            'width': width,
            'height': height,
            'duration_seconds': round(duration, 3) if duration is not None else None,
            'sha256': digest,
            'duplicate': False,
            'tags': [],
            'company': None,
            'source_url': None,
            'license': None,
            'attribution_required': None,
            'commercial_use_status': 'review_required',
        })

    duplicate_hashes = {digest: paths for digest, paths in by_hash.items() if len(paths) > 1}
    for asset in assets:
        asset['duplicate'] = asset['sha256'] in duplicate_hashes

    catalog = {
        'version': 1,
        'library': 'The Business Flow Media Library',
        'channel_key': 'the_business_flow_en',
        'storage_bucket': DEFAULT_BUCKET,
        'storage_prefix': DEFAULT_PREFIX,
        'asset_count': len(assets),
        'total_bytes': sum(int(item['size_bytes']) for item in assets),
        'duplicate_groups': duplicate_hashes,
        'assets': assets,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    (output_dir / 'summary.json').write_text(json.dumps({
        'asset_count': len(assets),
        'images': sum(1 for a in assets if a['type'] == 'image'),
        'videos': sum(1 for a in assets if a['type'] == 'video'),
        'total_bytes': catalog['total_bytes'],
        'duplicate_groups': len(duplicate_hashes),
        'needs_license_review': sum(1 for a in assets if a['commercial_use_status'] == 'review_required'),
        'storage_bucket': DEFAULT_BUCKET,
        'storage_prefix': DEFAULT_PREFIX,
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    shutil.rmtree(temp_dir, ignore_errors=True)
    return catalog


def main() -> None:
    parser = argparse.ArgumentParser(description='Build The Business Flow reusable media catalog from a directory or ZIP.')
    parser.add_argument('source', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path('media-library/generated'))
    parser.add_argument('--no-organize', action='store_true')
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f'Source not found: {args.source}')

    catalog = build_catalog(args.source.resolve(), args.output_dir.resolve(), organize=not args.no_organize)
    print(json.dumps({
        'asset_count': catalog['asset_count'],
        'total_mb': round(catalog['total_bytes'] / 1024 / 1024, 2),
        'duplicate_groups': len(catalog['duplicate_groups']),
        'catalog': str((args.output_dir / 'catalog.json').resolve()),
        'storage_bucket': catalog['storage_bucket'],
        'storage_prefix': catalog['storage_prefix'],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
