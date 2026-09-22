from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import edge_tts
from PIL import Image, ImageDraw, ImageFont

from mediaforge.media_library import MediaAsset, load_catalog, select_assets

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "media-library" / "catalog.json"
VISUAL_CACHE_ROOT = ROOT / "production" / "visual-cache"
TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class RenderAsset:
    asset_id: str
    path: Path
    asset_type: str
    title: str
    query: str
    source: str


def run(cmd: list[str], cwd: Path | None = None) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def capture(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def duration(path: Path) -> float:
    value = capture(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(value)


def tokenize(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def approved_assets() -> list[MediaAsset]:
    assets = load_catalog(CATALOG)
    approved = [a for a in assets if a.commercial_use_status == "approved" and a.repo_path and not a.duplicate]
    if len(approved) < 40:
        raise RuntimeError(f"Production requires at least 40 approved reusable media assets; found {len(approved)}")
    return approved


def load_topic_images(topic_id: str) -> list[RenderAsset]:
    manifest_path = VISUAL_CACHE_ROOT / topic_id / "visual-assets.json"
    if not manifest_path.exists():
        raise RuntimeError(f"Missing topic visual manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    images: list[RenderAsset] = []
    for row in manifest.get("assets") or []:
        local = ROOT / str(row.get("local_path") or "")
        if row.get("type") != "image" or not local.is_file() or local.stat().st_size < 10_000:
            continue
        images.append(RenderAsset(
            asset_id=str(row.get("asset_id") or local.name),
            path=local,
            asset_type="image",
            title=str(row.get("title") or ""),
            query=str(row.get("query") or ""),
            source=str(row.get("source") or "visual_research"),
        ))
    if len(images) < 40:
        raise RuntimeError(f"Need at least 40 cached topic images; found {len(images)}")
    return images[:50]


def sampled_scenes(package: dict, count: int) -> list[dict]:
    storyboard = package.get("storyboard") or []
    if not storyboard:
        return [{} for _ in range(count)]
    if count <= 1:
        return [storyboard[0]]
    return [storyboard[round(i * (len(storyboard) - 1) / (count - 1))] for i in range(count)]


def order_images_for_story(package: dict, images: list[RenderAsset]) -> list[RenderAsset]:
    """Match each unique image to a distributed storyboard point using local token overlap."""
    scenes = sampled_scenes(package, len(images))
    remaining = list(images)
    ordered: list[RenderAsset] = []
    for scene in scenes:
        query = " ".join([
            str(scene.get("visual_query") or ""),
            str(scene.get("narration_excerpt") or ""),
            str(package.get("topic") or ""),
        ])
        qtokens = tokenize(query)
        best_index = 0
        best_score = -1
        for index, asset in enumerate(remaining):
            atokens = tokenize(f"{asset.title} {asset.query}")
            score = len(qtokens & atokens)
            if score > best_score:
                best_score = score
                best_index = index
        ordered.append(remaining.pop(best_index))
    return ordered


def select_supporting_videos(package: dict, assets: list[MediaAsset], count: int = 6) -> list[RenderAsset]:
    videos = [a for a in assets if a.asset_type == "video" and a.repo_path]
    used: set[str] = set()
    selected: list[RenderAsset] = []
    scenes = sampled_scenes(package, count)
    for index, scene in enumerate(scenes):
        query = str(scene.get("visual_query") or scene.get("narration_excerpt") or package.get("topic") or "business")
        ranked = select_assets(
            videos,
            query=query,
            limit=12,
            company=(str(scene.get("company")) if scene.get("company") else None),
            preferred_categories=scene.get("preferred_categories") or [],
            require_approved_license=True,
            asset_type="video",
            exclude_ids=used,
            seed=index,
        )
        # Fall back to any unused video; it will only be a brief supporting cutaway.
        candidates = ranked + [a for a in videos if a.asset_id not in used and a not in ranked]
        chosen: MediaAsset | None = None
        for candidate in candidates:
            local = ROOT / str(candidate.repo_path)
            if not local.is_file() or local.stat().st_size <= 1000:
                continue
            try:
                if duration(local) < 2.0:
                    continue
            except Exception:
                continue
            chosen = candidate
            break
        if not chosen:
            continue
        used.add(chosen.asset_id)
        selected.append(RenderAsset(
            asset_id=chosen.asset_id,
            path=ROOT / str(chosen.repo_path),
            asset_type="video",
            title=chosen.filename,
            query=query,
            source="media_library",
        ))
    return selected[:8]


async def make_tts(script: str, out: Path) -> None:
    communicate = edge_tts.Communicate(
        script,
        voice=os.getenv("TTS_VOICE", "en-US-AndrewNeural"),
        rate=os.getenv("TTS_RATE", "-4%"),
    )
    await communicate.save(str(out))


def render_image_segment(asset: RenderAsset, seconds: float, out: Path, motion_index: int) -> None:
    # Slow Ken Burns movement. Each image is already normalized to 16:9 by the collector.
    if motion_index % 2 == 0:
        zoom = "min(1.0+on*0.00012,1.08)"
        motion = "zoom_in"
    else:
        zoom = "max(1.08-on*0.00012,1.0)"
        motion = "zoom_out"
    vf = (
        f"zoompan=z='{zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        ":d=1:s=1280x720:fps=30,format=yuv420p"
    )
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-framerate", "30", "-i", str(asset.path),
        "-t", f"{seconds:.3f}", "-vf", vf, "-an", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "23", "-r", "30", "-pix_fmt", "yuv420p", str(out),
    ])
    out.with_suffix(".motion").write_text(motion, encoding="utf-8")


def safe_video_seconds(asset: RenderAsset) -> float:
    source_duration = duration(asset.path)
    # Never loop. A video is a short 2-5 second cutaway and is used once per episode.
    return max(2.0, min(4.5, source_duration - 0.08))


def render_video_segment(asset: RenderAsset, seconds: float, out: Path) -> None:
    vf = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(asset.path), "-t", f"{seconds:.3f}", "-vf", vf, "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-r", "30",
        "-pix_fmt", "yuv420p", str(out),
    ])


def interleave_assets(images: list[RenderAsset], videos: list[RenderAsset]) -> list[RenderAsset]:
    if not videos:
        return images
    positions = {max(1, round((i + 1) * len(images) / (len(videos) + 1))): video for i, video in enumerate(videos)}
    timeline: list[RenderAsset] = []
    video_iter = iter(videos)
    pending = list(videos)
    inserted: set[str] = set()
    for index, image in enumerate(images, 1):
        timeline.append(image)
        if index in positions:
            video = positions[index]
            if video.asset_id not in inserted:
                timeline.append(video)
                inserted.add(video.asset_id)
    for video in pending:
        if video.asset_id not in inserted:
            timeline.append(video)
            inserted.add(video.asset_id)
    ids = [asset.asset_id for asset in timeline]
    if len(ids) != len(set(ids)):
        raise RuntimeError("Visual timeline contains a repeated asset; refusing to render loops/reuse")
    return timeline


def build_video(timeline: list[RenderAsset], narration: Path, out_dir: Path) -> Path:
    audio_duration = duration(narration)
    image_count = sum(a.asset_type == "image" for a in timeline)
    if image_count < 40:
        raise RuntimeError(f"Visual timeline requires at least 40 unique images; got {image_count}")

    video_seconds: dict[str, float] = {}
    for asset in timeline:
        if asset.asset_type == "video":
            video_seconds[asset.asset_id] = safe_video_seconds(asset)
    remaining = audio_duration - sum(video_seconds.values())
    if remaining <= 0:
        raise RuntimeError("Supporting video duration unexpectedly exceeds narration")
    image_seconds = remaining / image_count

    durations: list[float] = [video_seconds[a.asset_id] if a.asset_type == "video" else image_seconds for a in timeline]
    # Correct floating point drift on the final image so the picture track matches narration.
    drift = audio_duration - sum(durations)
    if abs(drift) > 0.001:
        for index in range(len(timeline) - 1, -1, -1):
            if timeline[index].asset_type == "image":
                durations[index] += drift
                break

    segments = out_dir / "segments"
    segments.mkdir(parents=True, exist_ok=True)
    concat_lines: list[str] = []
    selection_log: list[dict] = []
    image_motion_index = 0

    for index, (asset, seconds) in enumerate(zip(timeline, durations), 1):
        segment = segments / f"scene_{index:03d}.mp4"
        motion = "none"
        if asset.asset_type == "image":
            render_image_segment(asset, seconds, segment, image_motion_index)
            motion = "zoom_in" if image_motion_index % 2 == 0 else "zoom_out"
            image_motion_index += 1
        else:
            render_video_segment(asset, seconds, segment)
        concat_lines.append(f"file '{segment.name}'")
        selection_log.append({
            "scene": index,
            "duration_sec": round(seconds, 3),
            "asset_id": asset.asset_id,
            "asset_type": asset.asset_type,
            "path": asset.path.relative_to(ROOT).as_posix(),
            "title": asset.title,
            "query": asset.query,
            "source": asset.source,
            "motion": motion,
            "reused": False,
            "looped": False,
        })

    concat_file = segments / "concat.txt"
    concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    picture = out_dir / "picture-track.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_file), "-c", "copy", str(picture),
    ], cwd=segments)

    final = out_dir / "final.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(picture), "-i", str(narration),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", str(final),
    ])
    run(["ffmpeg", "-v", "error", "-i", str(final), "-f", "null", "-"])
    run(["ffmpeg", "-v", "error", "-i", str(final), "-map", "0:a:0", "-f", "null", "-"])
    (out_dir / "selected-assets.json").write_text(json.dumps(selection_log, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "scene-plan.json").write_text(json.dumps(selection_log, ensure_ascii=False, indent=2), encoding="utf-8")
    return final


def cover(img: Image.Image, size=(1280, 720)) -> Image.Image:
    ratio = max(size[0] / img.width, size[1] / img.height)
    resized = img.resize((math.ceil(img.width * ratio), math.ceil(img.height * ratio)), Image.Resampling.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def make_thumbnail(package: dict, images: list[RenderAsset], out_dir: Path) -> Path:
    variant = (package.get("thumbnail_variants") or [{}])[0]
    text = str(variant.get("text") or package.get("topic") or "BUSINESS").upper().strip()
    with Image.open(images[0].path) as raw:
        img = cover(raw.convert("RGB"))
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rectangle((0, 0, 1280, 720), fill=(0, 0, 0, 65))
    draw.rectangle((0, 0, 700, 720), fill=(0, 0, 0, 120))
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 92)
    small = ImageFont.truetype(font_path, 28)
    words = text.split()
    lines: list[str] = []
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
    if not 600 <= audio_duration <= 1800:
        raise RuntimeError(f"Narration duration outside 10-30 minute safety range: {audio_duration:.1f}s")

    topic_id = str(package["topic_id"])
    topic_images = order_images_for_story(package, load_topic_images(topic_id))
    supporting_videos = select_supporting_videos(package, approved_assets(), count=6)
    timeline = interleave_assets(topic_images, supporting_videos)
    final = build_video(timeline, narration, out_dir)
    thumb = make_thumbnail(package, topic_images, out_dir)

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
        "topic_id": topic_id,
        "video": str(final),
        "thumbnail": str(thumb),
        "duration_sec": round(duration(final), 2),
        "unique_topic_images": len(topic_images),
        "unique_supporting_videos": len(supporting_videos),
        "assets_used": len(timeline),
        "video_loops": 0,
        "asset_reuse": 0,
        "publish_at": metadata["publish_at"],
    }, indent=2))


if __name__ == "__main__":
    main()
