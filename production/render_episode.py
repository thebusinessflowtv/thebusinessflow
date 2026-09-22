from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import edge_tts
from PIL import Image, ImageDraw, ImageFont

from mediaforge.media_library import MediaAsset, load_catalog, select_assets

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "media-library" / "catalog.json"


def run(cmd: list[str], cwd: Path | None = None) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def capture(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def duration(path: Path) -> float:
    value = capture([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)
    ])
    return float(value)


def approved_assets() -> list[MediaAsset]:
    assets = load_catalog(CATALOG)
    approved = [a for a in assets if a.commercial_use_status == "approved" and a.repo_path and not a.duplicate]
    if len(approved) < 40:
        raise RuntimeError(
            f"Production requires at least 40 approved reusable media assets; found {len(approved)}. "
            "Do not bypass this gate until media rights are confirmed."
        )
    return approved


def choose_assets(package: dict, assets: list[MediaAsset], desired_count: int) -> list[tuple[dict, MediaAsset]]:
    storyboard = package.get("storyboard") or []
    if not storyboard:
        raise RuntimeError("Episode package has no storyboard")

    used: set[str] = set()
    assignments: list[tuple[dict, MediaAsset]] = []
    fallback = sorted(assets, key=lambda a: (a.asset_type != "video", a.category, a.filename))

    for idx, scene in enumerate(storyboard):
        if len(assignments) >= desired_count:
            break
        query = str(scene.get("visual_query") or scene.get("narration_excerpt") or package.get("topic") or "business")
        company = scene.get("company")
        preferred = scene.get("preferred_categories") or []
        ranked = select_assets(
            assets,
            query=query,
            limit=5,
            company=(str(company) if company else None),
            preferred_categories=preferred,
            require_approved_license=True,
            exclude_ids=used,
            seed=idx,
        )
        asset = ranked[0] if ranked else next((a for a in fallback if a.asset_id not in used), None)
        if not asset:
            break
        local = ROOT / str(asset.repo_path)
        if not local.is_file() or local.stat().st_size <= 1000:
            continue
        used.add(asset.asset_id)
        assignments.append((scene, asset))

    if len(assignments) < min(30, desired_count):
        raise RuntimeError(f"Not enough usable unique assets for episode: {len(assignments)}")
    return assignments


async def make_tts(script: str, out: Path) -> None:
    voice = os.getenv("TTS_VOICE", "en-US-AndrewNeural")
    rate = os.getenv("TTS_RATE", "-4%")
    communicate = edge_tts.Communicate(script, voice=voice, rate=rate)
    await communicate.save(str(out))


def render_segment(asset: MediaAsset, seconds: float, out: Path) -> None:
    src = ROOT / str(asset.repo_path)
    vf = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p"
    common = [
        "-t", f"{seconds:.3f}", "-vf", vf, "-an", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "23", "-r", "30", "-pix_fmt", "yuv420p", str(out)
    ]
    if asset.asset_type == "image":
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-i", str(src), *common]
    else:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", str(src), *common]
    run(cmd)


def build_video(assignments: list[tuple[dict, MediaAsset]], narration: Path, out_dir: Path) -> Path:
    audio_duration = duration(narration)
    weights = [max(float(scene.get("duration_sec") or 8), 3.0) for scene, _ in assignments]
    scale = audio_duration / sum(weights)
    scene_durations = [max(3.0, w * scale) for w in weights]
    correction = audio_duration / sum(scene_durations)
    scene_durations = [d * correction for d in scene_durations]

    segments = out_dir / "segments"
    segments.mkdir(parents=True, exist_ok=True)
    concat_lines: list[str] = []
    selection_log = []

    for i, ((scene, asset), sec) in enumerate(zip(assignments, scene_durations), 1):
        segment = segments / f"scene_{i:03d}.mp4"
        render_segment(asset, sec, segment)
        concat_lines.append(f"file '{segment.name}'")
        selection_log.append({
            "scene": i,
            "duration_sec": round(sec, 3),
            "asset_id": asset.asset_id,
            "repo_path": asset.repo_path,
            "asset_type": asset.asset_type,
            "query": scene.get("visual_query"),
        })

    concat_file = segments / "concat.txt"
    concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    picture = out_dir / "picture-track.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_file), "-c", "copy", str(picture)
    ], cwd=segments)

    final = out_dir / "final.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(picture), "-i", str(narration),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
        "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", str(final)
    ])
    run(["ffmpeg", "-v", "error", "-i", str(final), "-f", "null", "-"])
    run(["ffmpeg", "-v", "error", "-i", str(final), "-map", "0:a:0", "-f", "null", "-"])

    (out_dir / "selected-assets.json").write_text(json.dumps(selection_log, indent=2), encoding="utf-8")
    return final


def cover(img: Image.Image, size=(1280, 720)) -> Image.Image:
    ratio = max(size[0] / img.width, size[1] / img.height)
    resized = img.resize((math.ceil(img.width * ratio), math.ceil(img.height * ratio)), Image.Resampling.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def thumbnail_source(asset: MediaAsset, out_dir: Path, attempt: int) -> Path:
    src = ROOT / str(asset.repo_path)
    if not src.is_file() or src.stat().st_size <= 1000:
        raise RuntimeError(f"Thumbnail source missing/empty: {src}")
    if asset.asset_type == "image":
        return src

    frame = out_dir / f"thumbnail-source-{attempt:02d}.jpg"
    frame.unlink(missing_ok=True)
    # Some short clips have no frame at 1s. Try near the start first, then frame zero.
    for seek in ("0.25", "0"):
        try:
            run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", seek, "-i", str(src), "-frames:v", "1", "-q:v", "2", str(frame)
            ])
        except subprocess.CalledProcessError:
            pass
        if frame.is_file() and frame.stat().st_size > 1000:
            return frame
        frame.unlink(missing_ok=True)
    raise RuntimeError(f"Could not extract thumbnail frame from {src}")


def load_thumbnail_base(assets: list[MediaAsset], out_dir: Path) -> Image.Image:
    errors: list[str] = []
    for idx, asset in enumerate(assets[:20], 1):
        try:
            src = thumbnail_source(asset, out_dir, idx)
            with Image.open(src) as raw:
                raw.load()
                return cover(raw.convert("RGB"))
        except Exception as exc:
            errors.append(f"{asset.asset_id}: {type(exc).__name__}: {exc}")
            continue

    # Thumbnail failure must never destroy an otherwise valid documentary.
    # Fall back to a deterministic local canvas; packaging text is still applied below.
    print("Thumbnail media fallback used after asset failures:")
    for error in errors[-5:]:
        print(" -", error)
    return Image.new("RGB", (1280, 720), (18, 18, 18))


def make_thumbnail(package: dict, assets: list[MediaAsset], out_dir: Path) -> Path:
    variant = (package.get("thumbnail_variants") or [{}])[0]
    text = str(variant.get("text") or package.get("topic") or "BUSINESS").upper().strip()
    img = load_thumbnail_base(assets, out_dir)
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rectangle((0, 0, 1280, 720), fill=(0, 0, 0, 85))
    draw.rectangle((0, 0, 1280, 720), fill=(0, 0, 0, 30))
    draw.rectangle((0, 0, 700, 720), fill=(0, 0, 0, 110))
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 92)
    small = ImageFont.truetype(font_path, 28)

    words = text.split()
    lines = []
    current = ""
    for word in words:
        trial = (current + " " + word).strip()
        if draw.textbbox((0, 0), trial, font=font)[2] <= 600:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    lines = lines[:3]

    y = 220 - max(0, len(lines) - 1) * 45
    for line in lines:
        draw.text((65, y), line, font=font, fill=(255, 255, 255, 255), stroke_width=5, stroke_fill=(0, 0, 0, 230))
        y += 110
    draw.text((67, 630), "THE BUSINESS FLOW", font=small, fill=(225, 190, 90, 255))

    out = out_dir / "thumbnail.png"
    img.save(out, "PNG", optimize=True)
    return out


def next_publish_at() -> str:
    tz = ZoneInfo("America/New_York")
    now = datetime.now(tz)
    hour = int(os.getenv("PUBLISH_HOUR_ET", "18"))
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now + timedelta(hours=2):
        target += timedelta(days=1)
    return target.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    package = json.loads(args.package.read_text(encoding="utf-8"))
    out_dir = args.output_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    script = str(package["script"]).strip()
    narration = out_dir / "narration.mp3"
    asyncio.run(make_tts(script, narration))
    audio_duration = duration(narration)
    if audio_duration < 600 or audio_duration > 1800:
        raise RuntimeError(f"Narration duration outside 10-30 minute safety range: {audio_duration:.1f}s")

    assets = approved_assets()
    desired = min(len(package.get("storyboard") or []), len(assets), max(40, min(120, round(audio_duration / 8))))
    assignments = choose_assets(package, assets, desired)
    final = build_video(assignments, narration, out_dir)
    thumb = make_thumbnail(package, [asset for _, asset in assignments], out_dir)

    metadata = {
        "title": package["selected_title"],
        "description": package["description"],
        "tags": package["tags"],
        "category_id": "27",
        "publish_at": next_publish_at(),
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "topic_id": package["topic_id"],
        "video": str(final),
        "thumbnail": str(thumb),
        "duration_sec": round(duration(final), 2),
        "assets_used": len(assignments),
        "publish_at": metadata["publish_at"],
    }, indent=2))


if __name__ == "__main__":
    main()
