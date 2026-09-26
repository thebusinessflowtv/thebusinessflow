from __future__ import annotations

from pathlib import Path

import render_episode_hq as hq


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
    hq.render_image_segment = render_image_segment_smooth
    hq.main()


if __name__ == "__main__":
    main()
