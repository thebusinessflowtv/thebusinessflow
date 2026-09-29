from __future__ import annotations

import asyncio
import os
from pathlib import Path

import render_episode_hq as hq


async def make_tts_resilient(script: str, out: Path) -> None:
    """Generate narration with retries and a voice fallback for transient Edge TTS failures."""
    primary = os.getenv("TTS_VOICE", "en-US-AndrewNeural")
    voices = []
    for voice in (primary, os.getenv("TTS_FALLBACK_VOICE", "en-US-GuyNeural"), "en-US-ChristopherNeural"):
        if voice and voice not in voices:
            voices.append(voice)

    errors: list[str] = []
    for voice_index, voice in enumerate(voices):
        attempts = 4 if voice_index == 0 else 2
        for attempt in range(1, attempts + 1):
            try:
                if out.exists():
                    out.unlink()
                communicate = hq.edge_tts.Communicate(
                    script,
                    voice=voice,
                    rate=os.getenv("TTS_RATE", "-4%"),
                )
                await communicate.save(str(out))
                if not out.exists() or out.stat().st_size < 10_000:
                    raise RuntimeError("TTS returned an empty or incomplete audio file")
                if voice != primary:
                    print(f"TTS recovered with fallback voice: {voice}")
                elif attempt > 1:
                    print(f"TTS recovered on retry {attempt}/{attempts} with primary voice: {voice}")
                return
            except Exception as exc:
                errors.append(f"{voice} attempt {attempt}/{attempts}: {type(exc).__name__}: {exc}")
                print(f"TTS attempt failed: {errors[-1]}")
                if out.exists():
                    out.unlink()
                if attempt < attempts:
                    await asyncio.sleep(min(12, 2 * attempt))

    raise RuntimeError("Edge TTS failed after resilient retries. " + " | ".join(errors[-6:]))


def render_image_segment_smooth(asset: hq.RenderAsset, seconds: float, out: Path, motion_index: int) -> None:
    """Jitter-free 4K Ken Burns motion for still images."""
    frames = max(2, int(round(seconds * hq.FPS)))
    denom = max(1, frames - 1)
    t = f"(on/{denom})"
    smooth = f"(3*{t}*{t}-2*{t}*{t}*{t})"

    if motion_index % 2 == 0:
        zoom = f"1.0+0.04*{smooth}"
        motion = "zoom_in_smooth"
    else:
        zoom = f"1.04-0.04*{smooth}"
        motion = "zoom_out_smooth"

    super_w = hq.OUTPUT_W * 4
    super_h = hq.OUTPUT_H * 4
    vf = (
        f"scale={super_w}:{super_h}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={super_w}:{super_h},"
        f"zoompan=z='{zoom}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':"
        f"d={frames}:s={hq.OUTPUT_W}x{hq.OUTPUT_H}:fps={hq.FPS},"
        "format=yuv420p"
    )

    hq.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-i", str(asset.path),
        "-vf", vf, "-frames:v", str(frames),
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-r", str(hq.FPS), "-pix_fmt", "yuv420p", str(out),
    ])
    out.with_suffix(".motion").write_text(motion, encoding="utf-8")


def main() -> None:
    hq.make_tts = make_tts_resilient
    hq.render_image_segment = render_image_segment_smooth
    hq.main()


if __name__ == "__main__":
    main()
