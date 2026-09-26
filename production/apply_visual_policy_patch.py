from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "daily-production.yml"
TOPICS = ROOT / "production" / "topics.json"
STATE = ROOT / "production" / "queue-state.json"
HISTORICAL_COMMIT = "7124b6d787ee89a143f44d4a821ace18bdab2932"

CUSTOM_BATCH = [
    "custom-10-american-billion-dollar-companies-2026-09",
    "custom-15-us-industries-billions-2026-09",
    "custom-top-5-most-valuable-us-companies-2026-09",
    "custom-5-us-market-shaping-companies-2026-09",
    "custom-3-american-global-giants-2026-09",
    "custom-americas-richest-companies-metrics-2026-09",
    "custom-5-companies-behind-global-infrastructure-2026-09",
    "custom-richest-american-family-2026-09",
    "custom-nvidia-real-money-engine-2026-09",
    "custom-google-real-money-machine-2026-09",
    "custom-broadcom-hidden-giant-2026-09",
]


def patch_daily_workflow() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    # Kill the two Actions-cache paths that made visual packages reusable across runs.
    text, restore_count = re.subn(
        r"\n      - name: Restore visual asset cache\n.*?(?=\n      - name: Hydrate durable research checkpoint)",
        "",
        text,
        flags=re.S,
    )
    text, save_count = re.subn(
        r"\n      - name: Save visual work immediately\n.*?(?=\n      - name: Verify topic visual package before any Sonnet/render work)",
        "",
        text,
        flags=re.S,
    )

    text = text.replace(
        "      - name: Collect up to 50 topic-specific 16:9 images — free web sources, cache first\n",
        "      - name: Collect up to 50 topic-specific 16:9 images — fresh only, zero cross-video reuse\n",
    )
    text = text.replace(
        "          python production/collect_visual_assets.py \\\n            --topic-id",
        "          python production/collect_visual_assets_unique.py \\\n            --topic-id",
    )

    compile_old = (
        "          python -m py_compile production/anthropic_budget.py production/research_episode.py "
        "production/generate_episode.py production/generate_episode_v3.py production/recover_paid_episode.py "
        "production/recover_paid_episode_v3.py production/collect_visual_assets.py production/render_episode.py\n"
    )
    compile_new = (
        "          python -m py_compile production/anthropic_budget.py production/research_episode.py "
        "production/generate_episode.py production/generate_episode_v3.py production/recover_paid_episode.py "
        "production/recover_paid_episode_v3.py production/collect_visual_assets.py "
        "production/collect_visual_assets_unique.py production/register_used_visual_assets.py production/render_episode.py\n"
    )
    if compile_old in text:
        text = text.replace(compile_old, compile_new, 1)

    verifier_old = "          assert d.get('logos_excluded') is True\n"
    verifier_new = (
        "          assert d.get('logos_excluded') is True\n"
        "          assert d.get('fresh_only') is True, 'Visual package was not collected fresh'\n"
        "          assert d.get('cross_video_reuse_allowed') is False, 'Cross-video visual reuse must be disabled'\n"
        "          assert all(a.get('sha256') and a.get('perceptual_hash') for a in assets), 'Missing image fingerprints'\n"
    )
    if "assert d.get('fresh_only') is True" not in text:
        if verifier_old not in text:
            raise RuntimeError("Visual verifier anchor not found")
        text = text.replace(verifier_old, verifier_new, 1)

    register_step = '''      - name: Permanently reserve images used by this video
        shell: bash
        run: |
          set -euo pipefail
          python production/register_used_visual_assets.py \\
            --manifest "production/visual-cache/${{ steps.setup.outputs.topic_id }}/visual-assets.json" \\
            --registry production/used-visual-assets.json \\
            --topic-id "${{ steps.setup.outputs.topic_id }}" \\
            --run-id "${{ github.run_id }}"

'''
    preserve_anchor = "      - name: Preserve completed production artifact\n"
    if "Permanently reserve images used by this video" not in text:
        if preserve_anchor not in text:
            raise RuntimeError("Artifact-preservation anchor not found")
        text = text.replace(preserve_anchor, register_step + preserve_anchor, 1)

    git_add_old = '          git add production/topics.json "production/research-library/${{ steps.setup.outputs.topic_id }}.json"\n'
    git_add_new = '          git add production/topics.json production/used-visual-assets.json "production/research-library/${{ steps.setup.outputs.topic_id }}.json"\n'
    if git_add_old in text:
        text = text.replace(git_add_old, git_add_new, 1)

    text = text.replace(
        "          print('- Paid Haiku/Sonnet outputs are cached before rendering; visual downloads are cached independently.')\n",
        "          print('- Paid Haiku/Sonnet outputs are cached before rendering; visual images are always collected fresh and permanently fingerprinted.')\n",
    )

    # Hard validations: patch must be complete, not partial.
    forbidden = [
        "- name: Restore visual asset cache",
        "- name: Save visual work immediately",
        "free web sources, cache first",
    ]
    for marker in forbidden:
        if marker in text:
            raise RuntimeError(f"Forbidden visual-cache marker still present: {marker}")
    required = [
        "collect_visual_assets_unique.py",
        "register_used_visual_assets.py",
        "fresh only, zero cross-video reuse",
        "cross_video_reuse_allowed",
        "production/used-visual-assets.json",
    ]
    for marker in required:
        if marker not in text:
            raise RuntimeError(f"Required zero-reuse marker missing: {marker}")

    WORKFLOW.write_text(text, encoding="utf-8")
    print(f"daily-production patched; removed restore={restore_count}, save={save_count}")


def restore_custom_topics_and_queue() -> None:
    historical_raw = subprocess.check_output(
        ["git", "show", f"{HISTORICAL_COMMIT}:production/topics.json"],
        cwd=ROOT,
        text=True,
    )
    historical = json.loads(historical_raw)
    current = json.loads(TOPICS.read_text(encoding="utf-8"))
    hist_by_id = {str(t.get("id")): t for t in historical.get("topics", [])}
    cur_topics = current.setdefault("topics", [])
    cur_by_id = {str(t.get("id")): t for t in cur_topics}

    for topic_id in CUSTOM_BATCH:
        if topic_id not in cur_by_id:
            source = hist_by_id.get(topic_id)
            if not source:
                raise RuntimeError(f"Historical custom topic missing: {topic_id}")
            clone = json.loads(json.dumps(source))
            cur_topics.append(clone)
            cur_by_id[topic_id] = clone

    now = datetime.now(timezone.utc).isoformat()
    infra = cur_by_id["custom-5-companies-behind-global-infrastructure-2026-09"]
    infra["status"] = "ready"
    infra.pop("queue_block_reason", None)
    infra.pop("queue_blocked_at", None)
    infra["requeued_at"] = now
    infra["requeue_reason"] = "Requeued after strict zero-cross-video-image-reuse policy"

    # Run #58 failed. Return this topic to the queue rather than leaving the orchestrator on an unknown state.
    family = cur_by_id["custom-richest-american-family-2026-09"]
    family["status"] = "ready"
    family.pop("queue_block_reason", None)
    family.pop("queue_blocked_at", None)

    for topic_id in [
        "custom-nvidia-real-money-engine-2026-09",
        "custom-google-real-money-machine-2026-09",
        "custom-broadcom-hidden-giant-2026-09",
    ]:
        item = cur_by_id[topic_id]
        item["status"] = "ready"
        item.pop("queue_block_reason", None)
        item.pop("queue_blocked_at", None)

    TOPICS.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    state = json.loads(STATE.read_text(encoding="utf-8"))
    state["batch_ids"] = CUSTOM_BATCH
    state["current_topic"] = "custom-5-companies-behind-global-infrastructure-2026-09"
    state["source_run_id"] = None
    attempts = state.setdefault("production_attempts", {})
    attempts["custom-5-companies-behind-global-infrastructure-2026-09"] = 0
    attempts["custom-richest-american-family-2026-09"] = 0
    for topic_id in [
        "custom-nvidia-real-money-engine-2026-09",
        "custom-google-real-money-machine-2026-09",
        "custom-broadcom-hidden-giant-2026-09",
    ]:
        attempts.pop(topic_id, None)
    state["last_action"] = "visual_policy_hotfix_requeued"
    state["last_reason"] = "Global Infrastructure is first under strict zero-reuse visual policy"
    state["updated_at"] = now
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("custom batch restored; Global Infrastructure requeued first")


def main() -> None:
    patch_daily_workflow()
    restore_custom_topics_and_queue()


if __name__ == "__main__":
    main()
