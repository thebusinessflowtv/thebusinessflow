# The Business Flow — Automated YouTube Factory

English-first documentary production system for **The Business Flow**.

This repository is the channel-specific migration of the production architecture used previously elsewhere, adapted for US-focused **Business / Corporate Documentaries** and kept isolated under the `thebusinessflowtv` GitHub account.

## Target pipeline

```text
Topic / editorial queue
  -> research + fact checking
  -> English (US) documentary script
  -> narration
  -> GitHub LFS media selection
  -> MediaForge render
  -> render validation
  -> thumbnail
  -> upload_ready
  -> YouTube PRIVATE upload
  -> youtube_video_id checkpoint
  -> manual/publication gate
```

## Channel profile

- Channel: The Business Flow
- Locale: en-US
- Primary market: United States
- Niche: Business / Corporate Documentaries
- Default YouTube privacy: private
- Editorial style: evergreen documentary storytelling

## Media architecture

The project uses **GitHub only** for its reusable media library. Photos and B-roll videos are stored with Git LFS inside this repository under `media-library/assets/`, while `media-library/catalog.json` is used by the MediaForge resolver to select relevant assets.

No external object-storage dependency is required for the media library.

## Safety rules

- Never commit YouTube OAuth credentials, API keys or voice-reference audio.
- YouTube uploads remain PRIVATE until the publication gate explicitly approves them.
- Reuse only licensed/approved media in the production library.
- Channel-specific code, media and credentials remain isolated in this repository.
