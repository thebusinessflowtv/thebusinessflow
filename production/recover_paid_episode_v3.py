from __future__ import annotations

try:
    from production import generate_episode_v3 as v3
    from production import recover_paid_episode as recovery
except ModuleNotFoundError:
    import generate_episode_v3 as v3
    import recover_paid_episode as recovery

# Importing generate_episode_v3 installs the resilient brand-aware validator on
# the shared generate_episode module. Point recovery at the same finalized logic
# so a valid title like "Meta's ..." is not rejected merely because it does not
# repeat the entire editorial label "Meta VR Glasses".
recovery.finalize_package = v3.core.finalize_package


if __name__ == "__main__":
    recovery.main()
