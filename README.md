# The Business Flow — Automated YouTube Factory

English-first documentary production system for **The Business Flow**.

This repository is the channel-specific migration of the production architecture used by Leonidanos, adapted for US-focused **Business / Corporate Documentaries**.

## Target pipeline

```text
Topic / editorial queue
  -> research + fact checking
  -> English (US) documentary script
  -> narration
  -> media selection
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

## Safety rules

- Never commit YouTube OAuth credentials, API keys, Supabase keys or voice-reference audio.
- YouTube uploads remain PRIVATE until the publication gate explicitly approves them.
- Reuse only licensed/approved media in the production library.
- The Leonidanos channel and its GTA-specific data are not modified by this migration.

## Migration status

The channel repository is being migrated from the working Leonidanos/MediaForge architecture. GTA-specific PT-BR logic, Leonidanos branding and Dell production dependencies are intentionally excluded or replaced for this channel.
