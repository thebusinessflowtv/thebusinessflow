#!/usr/bin/env python3
"""Copy approved DJ30 files into OVH and append them to Gaming as they finish."""
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

BASE = os.environ.get('BASE', 'https://peterlofi.odsgn.com.br').rstrip('/')
SOURCE = 'https://api.github.com/repos/thebusinessflowtv/theofficemusic/contents/control/gaming-twitch-dj-30'


def request(url, data=None, token='', method=None, mime='application/json'):
    headers = {'user-agent': 'PeterLofi-GamingDJ30-Sync'}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if data is not None:
        headers['content-type'] = mime
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
    with urlopen(Request(url, data=data, headers=headers, method=method), timeout=150) as response:
        return response.read()


def api(path, token, data=None, method=None, mime='application/json'):
    return json.loads(request(BASE + path, data, token, method, mime))


def main():
    files = json.loads(request(SOURCE))
    manifests = sorted((f for f in files if re.fullmatch(r'\d{2}\.json', f['name'])), key=lambda f: f['name'])
    login = api('/api/auth/login', '', {'email': os.environ['ADMIN_EMAIL'], 'password': os.environ['ADMIN_PASSWORD']})
    token = login['token']
    print('::add-mask::' + token)
    library = api('/api/music-library', token)
    gaming = next(p for p in library['playlists'] if p['key'] == 'gaming-radio')
    existing = {t['id'] for t in gaming['tracks']}
    added = 0
    for file in manifests:
        item = json.loads(request(file['download_url']))
        track = item['track']
        if track['id'] in existing:
            continue
        if item.get('status') != 'generated' or item.get('quality_gate', {}).get('approved') is not True:
            raise RuntimeError('Production manifest has no approved audio')
        if not re.fullmatch(r'gaming-twitch-dj-20261004-(0[1-9]|[12][0-9]|30)', track['id']):
            raise RuntimeError('Unexpected track ID')
        if not track['url'].startswith('https://github.com/thebusinessflowtv/theofficemusic/releases/download/peter-lofi-gaming-dj30-'):
            raise RuntimeError('Unexpected generated audio source')
        audio = request(track['url'])
        if not 3000000 <= len(audio) <= 20000000:
            raise RuntimeError('Generated MP3 size is invalid')
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'track.mp3'
            p.write_bytes(audio)
            duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(p)], text=True))
            if not 298 <= duration <= 302:
                raise RuntimeError('Generated MP3 is not five minutes')
        upload = api('/api/uploads/init', token, {'name': track['id'] + '.mp3', 'title': track['title'], 'asset_type': 'audio', 'mime_type': 'audio/mpeg', 'size_bytes': len(audio)})
        part = api('/api/uploads/part?asset_id=' + upload['asset_id'] + '&upload_id=' + upload['upload_id'] + '&part_number=1', token, audio, 'PUT', 'audio/mpeg')
        complete = api('/api/uploads/complete', token, {'asset_id': upload['asset_id'], 'upload_id': upload['upload_id'], 'parts': [part]})
        if not complete.get('ok'):
            raise RuntimeError('OVH did not confirm audio upload')
        result = api('/api/music-library/gaming-dj30', token, {'tracks': [{**track, 'asset_id': upload['asset_id']}]})
        if not result.get('ok'):
            raise RuntimeError('OVH did not confirm Gaming append')
        existing.add(track['id'])
        added += int(result['added'])
        print('ADDED_TO_OVH_GAMING:', track['id'], track['title'], flush=True)
    library = api('/api/music-library', token)
    gaming = next(p for p in library['playlists'] if p['key'] == 'gaming-radio')
    local = [t for t in gaming['tracks'] if t.get('source') == 'gaming-twitch-dj-30' and t.get('asset_id')]
    print(json.dumps({'approved_files': len(manifests), 'added_this_run': added, 'local_gaming_tracks': len(local), 'target': 30}))
    if len(local) == 30:
        # The batch is finite. Stop scheduled checks once every track is local.
        repo = os.environ['GITHUB_REPOSITORY']
        request('https://api.github.com/repos/' + repo + '/actions/workflows/sync-gaming-dj30-to-ovh.yml/disable', b'', os.environ['GH_TOKEN'], 'PUT')
        print('DJ30_COMPLETE: scheduled publication checks disabled')


if __name__ == '__main__':
    main()
