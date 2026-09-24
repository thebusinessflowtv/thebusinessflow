import collect_visual_assets_hq as core


# Timely product episodes can need a wider historical visual pool than the exact
# newly-announced product name can provide on reusable-license sources. Keep the
# subject tightly scoped to Meta's VR/XR ecosystem while allowing the factory to
# reach its 40-image minimum without falling back to unrelated imagery.
core.SUBJECT_PROFILES.setdefault(
    "meta vr glasses",
    {
        "queries": [
            "Meta Quest 3 virtual reality headset",
            "Meta Quest 2 virtual reality headset",
            "Meta Quest Pro virtual reality headset",
            "Oculus Quest virtual reality headset",
            "Oculus Rift virtual reality headset",
            "Meta Reality Labs virtual reality",
            "Mark Zuckerberg Meta Quest",
            "Mark Zuckerberg virtual reality",
            "Meta headquarters Menlo Park",
            "Meta Connect virtual reality",
            "Ray-Ban Meta smart glasses",
            "Meta VR headset",
            "Facebook Oculus virtual reality",
            "Meta Quest gaming",
            "Meta Quest mixed reality passthrough",
        ],
        "allow_terms": {
            "meta", "quest", "oculus", "zuckerberg", "virtual reality", "vr",
            "mixed reality", "reality labs", "ray-ban meta", "meta connect",
        },
        "block_terms": {
            "metaverse stock image", "ai generated", "concept render",
        },
    },
)


if __name__ == "__main__":
    core.main()
