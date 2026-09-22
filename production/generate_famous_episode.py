from __future__ import annotations

import generate_episode as core

_original_build_prompt = core.build_prompt


def famous_build_prompt(topic, editorial):
    base = _original_build_prompt(topic, editorial)
    brand = str(topic.get("topic") or "").strip()
    return base + f"""

FAMOUS-COMPANY PACKAGING OVERRIDE
- This episode is about a highly recognizable company/brand: {brand}.
- selected_title MUST explicitly contain the company/brand name '{brand}'.
- At least 8 of the 10 title_candidates MUST explicitly contain '{brand}'.
- Do not select a generic title such as 'The Lie', 'The Collapse', 'They Fooled Everyone', or 'The Secret Empire' unless the company name is also in that same title.
- Every thumbnail concept MUST specify an instantly recognizable brand cue: logo, flagship product, storefront, app icon, vehicle, packaging, founder/CEO, headquarters, or another unmistakable visual identifier.
- Thumbnail text should complement the brand visual, not replace it. Generic text is acceptable only when the image itself makes the company obvious.
- The opening 30 seconds must name the company immediately and establish the business mystery or contradiction.
- Prefer a business/economics angle over biography or scandal unless the factual research makes the scandal essential.
"""


core.build_prompt = famous_build_prompt

if __name__ == "__main__":
    core.main()
