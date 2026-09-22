from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOPICS = ROOT / "production" / "topics.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    args = parser.parse_args()

    package = json.loads(args.package.read_text(encoding="utf-8"))
    checkpoint = json.loads(args.checkpoint.read_text(encoding="utf-8"))
    topic_id = str(package["topic_id"])
    video_id = str(checkpoint.get("youtube_video_id") or "")
    if not video_id:
        raise RuntimeError("YouTube checkpoint has no video id")
    if checkpoint.get("scheduled") is not True:
        raise RuntimeError("Topic will not be consumed because YouTube checkpoint is not scheduled")

    data = json.loads(TOPICS.read_text(encoding="utf-8"))
    found = False
    for topic in data.get("topics") or []:
        if str(topic.get("id")) == topic_id:
            topic["status"] = "used"
            topic["used_at"] = datetime.now(timezone.utc).isoformat()
            topic["youtube_video_id"] = video_id
            topic["publish_at"] = checkpoint.get("publish_at")
            found = True
            break
    if not found:
        raise RuntimeError(f"Topic not found: {topic_id}")

    TOPICS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"topic_id": topic_id, "youtube_video_id": video_id, "status": "used"}, indent=2))


if __name__ == "__main__":
    main()
