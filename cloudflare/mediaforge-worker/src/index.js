const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64json(value) {
  return b64url(enc.encode(JSON.stringify(value)));
}

function base64Utf8(text) {
  const bytes = enc.encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))));
}

async function signSession(email, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64json({ alg: 'HS256', typ: 'MFG' });
  const payload = b64json({ sub: email, iat: now, exp: now + 60 * 60 * 24 * 7 });
  const sig = await hmac(secret, `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

function decodeB64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0))));
}

async function verifySession(token, secret) {
  try {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return null;
    const expected = await hmac(secret, `${h}.${p}`);
    if (sig !== expected) return null;
    const payload = decodeB64url(p);
    if (!payload?.sub || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = env.FRONTEND_ORIGIN || 'https://thebusinessflowtv.github.io';
  const allowOrigin = origin && (origin === allowed || origin.startsWith(allowed + ':')) ? origin : allowed;
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-upload-name,x-upload-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

async function bodyJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

async function requireAuth(request, env) {
  const token = bearer(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET || '') : null;
  return session;
}

async function githubDispatch(env, workflow, inputs) {
  if (!env.GITHUB_WORKFLOW_TOKEN) throw new Error('GITHUB_WORKFLOW_TOKEN não configurado no Worker.');
  const repo = env.GITHUB_REPO || 'thebusinessflowtv/theofficemusic';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'MediaForge-Cloudflare-Worker',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`GitHub dispatch falhou (${res.status}): ${text.slice(0, 500)}`);
  }
}

async function getCatalog(env) {
  const repo = env.GITHUB_REPO || 'thebusinessflowtv/theofficemusic';
  const url = `https://raw.githubusercontent.com/${repo}/main/control/mediaforge-catalog.json?ts=${Date.now()}`;
  const res = await fetch(url, { headers: { 'user-agent': 'MediaForge-Cloudflare-Worker' } });
  if (!res.ok) throw new Error(`Catálogo GitHub indisponível (${res.status}).`);
  return res.json();
}

async function syncSessionFromGitHub(env, row) {
  if (!['queued', 'starting', 'live', 'reconnecting'].includes(String(row.status))) return row;
  const repo = env.GITHUB_REPO || 'thebusinessflowtv/theofficemusic';
  const url = `https://raw.githubusercontent.com/${repo}/main/control/kick-live-results/${row.id}.json?ts=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'MediaForge-Cloudflare-Worker' } });
    if (!res.ok) return row;
    const remote = await res.json();
    const status = String(remote.status || row.status);
    await env.DB.prepare(`UPDATE live_sessions SET status=?, github_run_id=?, github_run_url=?, error_message=?, live_at=?, completed_at=? WHERE id=?`)
      .bind(status, remote.github_run_id || null, remote.github_run_url || null, remote.error_message || null, remote.live_at || null, remote.completed_at || null, row.id).run();
    return { ...row, ...remote, status };
  } catch (_) {
    return row;
  }
}

function safeName(name) {
  return String(name || 'visual').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-140) || 'visual';
}

function assetPublicUrl(request, asset) {
  const u = new URL(request.url);
  return `${u.origin}/media/${asset.id}/${asset.download_token}`;
}

async function readAsset(env, id) {
  return env.DB.prepare(`SELECT * FROM assets WHERE id=?`).bind(id).first();
}

async function handleMedia(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[1] || '';
  const token = parts[2] || '';
  const asset = await env.DB.prepare(`SELECT * FROM assets WHERE id=? AND download_token=? AND status='ready'`).bind(id, token).first();
  if (!asset) return new Response('Not found', { status: 404 });
  const object = await env.MEDIA.get(asset.r2_key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  if (object.writeHttpMetadata) object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag || object.etag || '');
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('accept-ranges', 'bytes');
  return new Response(object.body, { headers });
}

async function handleApi(request, env, url) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/api/health') {
    return json({ ok: true, service: 'mediaforge-api', storage: 'r2', database: 'd1', supabase: false }, 200, cors);
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const b = await bodyJson(request);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: 'auth_not_configured' }, 503, cors);
    if (email !== String(env.ADMIN_EMAIL).trim().toLowerCase() || password !== String(env.ADMIN_PASSWORD)) {
      return json({ error: 'invalid_credentials', message: 'E-mail ou senha inválidos.' }, 401, cors);
    }
    const token = await signSession(email, env.SESSION_SECRET);
    return json({ ok: true, token, user: { email, role: 'admin' } }, 200, cors);
  }

  const session = await requireAuth(request, env);
  if (!session) return json({ error: 'unauthorized', message: 'Sessão inválida ou expirada.' }, 401, cors);

  if (url.pathname === '/api/me' && request.method === 'GET') {
    return json({ user: { email: session.sub, role: 'admin' } }, 200, cors);
  }

  if (url.pathname === '/api/catalog' && request.method === 'GET') {
    try {
      const catalog = await getCatalog(env);
      const assets = await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();
      return json({ ...catalog, assets: (assets.results || []).map(a => ({
        id: a.id, title: a.title, asset_type: a.asset_type, mime_type: a.mime_type,
        size_bytes: a.size_bytes, created_at: a.created_at, metadata: JSON.parse(a.metadata_json || '{}'),
        public_url: assetPublicUrl(request, a),
      })) }, 200, cors);
    } catch (e) {
      return json({ error: 'catalog_error', message: e.message }, 502, cors);
    }
  }

  if (url.pathname === '/api/assets' && request.method === 'GET') {
    const q = await env.DB.prepare(`SELECT * FROM assets WHERE status='ready' ORDER BY created_at DESC`).all();
    return json({ assets: (q.results || []).map(a => ({
      id: a.id, title: a.title, asset_type: a.asset_type, mime_type: a.mime_type,
      size_bytes: a.size_bytes, created_at: a.created_at, metadata: JSON.parse(a.metadata_json || '{}'),
      public_url: assetPublicUrl(request, a),
    })) }, 200, cors);
  }

  if (url.pathname === '/api/uploads/init' && request.method === 'POST') {
    const b = await bodyJson(request);
    const name = safeName(b.name);
    const mime = String(b.mime_type || 'application/octet-stream');
    const size = Math.max(0, Number(b.size_bytes || 0));
    const assetId = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const day = new Date().toISOString().slice(0, 10);
    const key = `live/${day}/${assetId}-${name}`;
    const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO assets(id,title,asset_type,r2_key,mime_type,size_bytes,status,download_token,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(assetId, b.title || b.name || name, 'loop', key, mime, size, 'uploading', token, JSON.stringify({ live_visual: true, loop_forever: true, source: 'r2_upload' }), now).run();
    return json({ ok: true, asset_id: assetId, upload_id: upload.uploadId, chunk_size: 50 * 1024 * 1024 }, 200, cors);
  }

  if (url.pathname === '/api/uploads/part' && request.method === 'PUT') {
    const assetId = url.searchParams.get('asset_id') || '';
    const uploadId = url.searchParams.get('upload_id') || '';
    const partNumber = Number(url.searchParams.get('part_number') || 0);
    if (!assetId || !uploadId || partNumber < 1) return json({ error: 'bad_upload_part' }, 400, cors);
    const asset = await readAsset(env, assetId);
    if (!asset || asset.status !== 'uploading') return json({ error: 'asset_not_uploading' }, 404, cors);
    const multipart = env.MEDIA.resumeMultipartUpload(asset.r2_key, uploadId);
    const part = await multipart.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag }, 200, cors);
  }

  if (url.pathname === '/api/uploads/complete' && request.method === 'POST') {
    const b = await bodyJson(request);
    const asset = await readAsset(env, String(b.asset_id || ''));
    if (!asset) return json({ error: 'asset_not_found' }, 404, cors);
    const multipart = env.MEDIA.resumeMultipartUpload(asset.r2_key, String(b.upload_id || ''));
    const parts = (b.parts || []).map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })).sort((a,b) => a.partNumber - b.partNumber);
    if (!parts.length) return json({ error: 'parts_required' }, 400, cors);
    await multipart.complete(parts);
    await env.DB.prepare(`UPDATE assets SET status='ready' WHERE id=?`).bind(asset.id).run();
    const ready = await readAsset(env, asset.id);
    return json({ ok: true, asset: {
      id: ready.id, title: ready.title, asset_type: ready.asset_type, mime_type: ready.mime_type,
      size_bytes: ready.size_bytes, created_at: ready.created_at, metadata: JSON.parse(ready.metadata_json || '{}'),
      public_url: assetPublicUrl(request, ready),
    } }, 200, cors);
  }

  if (url.pathname === '/api/uploads/abort' && request.method === 'POST') {
    const b = await bodyJson(request);
    const asset = await readAsset(env, String(b.asset_id || ''));
    if (!asset) return json({ error: 'asset_not_found' }, 404, cors);
    try {
      const multipart = env.MEDIA.resumeMultipartUpload(asset.r2_key, String(b.upload_id || ''));
      await multipart.abort();
    } catch (_) {}
    await env.DB.prepare(`UPDATE assets SET status='aborted' WHERE id=?`).bind(asset.id).run();
    return json({ ok: true }, 200, cors);
  }

  if (url.pathname === '/api/live/start' && request.method === 'POST') {
    try {
      const b = await bodyJson(request);
      const platform = String(b.platform || 'kick').toLowerCase();
      if (platform !== 'kick') return json({ error: 'platform_not_ready', message: 'Esta migração libera primeiro a Kick.' }, 400, cors);
      const catalog = await getCatalog(env);
      const trackIds = Array.isArray(b.track_ids) ? b.track_ids.map(String) : [];
      if (!trackIds.length) return json({ error: 'select_at_least_one_track' }, 400, cors);
      const trackMap = new Map((catalog.tracks || []).map(t => [String(t.id), t]));
      const selected = trackIds.map(id => trackMap.get(id)).filter(Boolean);
      if (selected.length !== trackIds.length) return json({ error: 'invalid_track_selection', message: 'Uma ou mais músicas não existem no catálogo GitHub.' }, 400, cors);
      const urls = selected.map(t => t.url).filter(Boolean);
      if (!urls.length) return json({ error: 'no_playable_tracks' }, 400, cors);

      let visualUrl = '';
      let visualId = b.visual_asset_id ? String(b.visual_asset_id) : '';
      if (visualId) {
        const asset = await readAsset(env, visualId);
        if (!asset || asset.status !== 'ready') return json({ error: 'visual_not_ready' }, 400, cors);
        visualUrl = assetPublicUrl(request, asset);
      }

      const id = crypto.randomUUID();
      const title = String(b.title || 'Peter Lofi — Live').trim() || 'Peter Lofi — Live';
      const description = String(b.description || '');
      const duration = Math.max(0, Math.min(10080, Number(b.duration_minutes ?? 0) || 0));
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO live_sessions(id,platform,status,title,description,duration_minutes,track_ids_json,visual_asset_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(id, 'kick', 'queued', title, description, duration, JSON.stringify(trackIds), visualId || null, now).run();

      await githubDispatch(env, 'peter-lofi-kick-live.yml', {
        session_id: id,
        track_urls_b64: base64Utf8(JSON.stringify(urls)),
        duration_minutes: String(duration),
        title,
        description,
        thumbnail_url: '',
        loop_url: visualUrl,
        segment_index: '1',
      });
      return json({ ok: true, session: { id, platform: 'kick', status: 'queued', title, description, duration_minutes: duration, visual_asset_id: visualId || null, created_at: now } }, 200, cors);
    } catch (e) {
      return json({ error: 'start_live_failed', message: e.message }, 502, cors);
    }
  }

  if (url.pathname.match(/^\/api\/live\/[^/]+\/stop$/) && request.method === 'POST') {
    const id = url.pathname.split('/')[3];
    const row = await env.DB.prepare(`SELECT * FROM live_sessions WHERE id=?`).bind(id).first();
    if (!row) return json({ error: 'session_not_found' }, 404, cors);
    try {
      await githubDispatch(env, 'peter-lofi-kick-stop.yml', { session_id: id });
      await env.DB.prepare(`UPDATE live_sessions SET status='stopping' WHERE id=?`).bind(id).run();
      return json({ ok: true, session_id: id, status: 'stopping' }, 200, cors);
    } catch (e) {
      return json({ error: 'stop_live_failed', message: e.message }, 502, cors);
    }
  }

  if (url.pathname === '/api/live-sessions' && request.method === 'GET') {
    const q = await env.DB.prepare(`SELECT * FROM live_sessions ORDER BY created_at DESC LIMIT 50`).all();
    const rows = [];
    for (const r of (q.results || [])) rows.push(await syncSessionFromGitHub(env, r));
    return json({ sessions: rows.map(r => ({ ...r, track_ids: JSON.parse(r.track_ids_json || '[]') })) }, 200, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/media/')) return handleMedia(request, env, url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
      return json({ service: 'MediaForge API', backend: 'Cloudflare Worker + D1 + R2', supabase: false });
    } catch (e) {
      return json({ error: 'internal_error', message: e?.message || String(e) }, 500, corsHeaders(request, env));
    }
  },
};
