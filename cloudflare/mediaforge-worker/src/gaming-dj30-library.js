// Called only after the control API has verified the administrator session.
export async function appendGamingDj30Assets(env, request, tracks, assetPublicUrl) {
  if (String(env.LOCAL_RUNTIME || '') !== '1') throw new Error('local_runtime_required');
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 30) throw new Error('tracks_required');
  const approved = [];
  const seen = new Set();
  for (const track of tracks) {
    if (!/^gaming-twitch-dj-20261004-(0[1-9]|[12][0-9]|30)$/.test(String(track.id || '')) || Number(track.duration_seconds) !== 300) throw new Error('invalid_gaming_track');
    if (seen.has(track.id)) throw new Error('duplicate_track_id');
    seen.add(track.id);
    const asset = await env.DB.prepare('SELECT * FROM assets WHERE id=?').bind(String(track.asset_id || '')).first();
    if (!asset || asset.status !== 'ready' || asset.asset_type !== 'audio' || Number(asset.size_bytes) < 3000000) throw new Error('approved_audio_asset_required');
    approved.push({id:track.id, title:String(track.title || asset.title).slice(0,160), url:assetPublicUrl(request,asset,env), asset_id:asset.id, duration_seconds:300, source:'gaming-twitch-dj-30', quality_gate:'technical_checks_passed'});
  }
  const path = 'control/music-library.json';
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare('SELECT payload_json FROM local_config WHERE path=?').bind(path).first();
    if (!row) throw new Error('local_music_library_missing');
    const library = JSON.parse(row.payload_json);
    const playlist = (library.playlists || []).find(p => p.key === 'gaming-radio');
    if (!playlist || !Array.isArray(playlist.tracks)) throw new Error('gaming_playlist_missing');
    let added = 0;
    for (const track of approved) {
      if (playlist.tracks.some(t => t.id === track.id)) continue;
      playlist.tracks.push({...track, position:playlist.tracks.length+1});
      added++;
    }
    const generated = playlist.tracks.filter(t => t.source === 'gaming-twitch-dj-30').length;
    if (!added) return {ok:true, added:0, generated, playlist_key:playlist.key};
    playlist.track_count = playlist.tracks.length;
    playlist.total_duration_seconds = playlist.tracks.reduce((n,t) => n+Number(t.duration_seconds || 0),0);
    library.updated_at = new Date().toISOString();
    // A concurrent library update must be merged again, never overwritten.
    const result = await env.DB.prepare('UPDATE local_config SET payload_json=?,updated_at=? WHERE path=? AND payload_json=?').bind(JSON.stringify(library),library.updated_at,path,row.payload_json).run();
    if (result.meta?.changes === 1) return {ok:true, added, generated, playlist_key:playlist.key};
  }
  throw new Error('music_library_update_conflict');
}
