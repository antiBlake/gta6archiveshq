#!/usr/bin/env node
// Direct YouTube Shorts uploads (YouTube Data API v3), instead of Buffer's ~1-2/day.
// Quota: 10,000 units/day, an upload costs ~1,600 → about 6 Shorts a day.
//
//   node tools/youtube.mjs auth            one-time: opens Google sign-in, stores YT_REFRESH_TOKEN in .env
//   node tools/youtube.mjs upload <draft>  upload one draft's video as a public Short (used by the publisher)
//
// Needs youtube_client.json (OAuth "Desktop app" client from the same Google Cloud project as the Gemini key)
// or YT_CLIENT_ID / YT_CLIENT_SECRET, plus YT_REFRESH_TOKEN.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, env } from './lib/env.mjs';

function client() {
  const f = join(ROOT, 'youtube_client.json');
  if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); const c = j.installed ?? j.web; return { id: c.client_id, secret: c.client_secret }; }
  if (env.YT_CLIENT_ID && env.YT_CLIENT_SECRET) return { id: env.YT_CLIENT_ID, secret: env.YT_CLIENT_SECRET };
  throw new Error('Missing youtube_client.json (or YT_CLIENT_ID/YT_CLIENT_SECRET)');
}

export async function accessToken() {
  const c = client();
  if (!env.YT_REFRESH_TOKEN) throw new Error('YT_REFRESH_TOKEN missing: run node tools/youtube.mjs auth');
  const r = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: env.YT_REFRESH_TOKEN, grant_type: 'refresh_token' }) })).json();
  if (!r.access_token) throw new Error(`YouTube token refresh failed: ${JSON.stringify(r).slice(0, 200)}`);
  return r.access_token;
}

export const youtubeReady = () => !!(env.YT_REFRESH_TOKEN && (env.YT_CLIENT_ID || existsSync(join(ROOT, 'youtube_client.json'))));

/** Uploads a draft's main video as a public Short. Returns { id, url }. */
export async function uploadShort(d, publishAt) {
  const token = await accessToken();
  let bytes;
  const local = d.media && join(ROOT, d.media);
  if (local && existsSync(local)) bytes = readFileSync(local);
  else bytes = Buffer.from(await (await fetch(d.media_url)).arrayBuffer());
  const caption = (d.captions.youtube ?? d.captions.tiktok ?? '').replace(/#\S+/g, '').trim();
  const title = `${(d.youtube_title ?? d.hook ?? caption.split(/[.!?\n]/)[0]).replace(/[<>]/g, '').slice(0, 88)} #Shorts`;
  const meta = {
    snippet: { title, description: `${caption}\n\n#GTA6 #GTAVI #Shorts`, tags: ['GTA 6', 'GTA VI', 'Grand Theft Auto VI', 'GTA 6 gameplay', d.credit].filter(Boolean), categoryId: '20' },
    status: publishAt && new Date(publishAt) > new Date(Date.now() + 10 * 60_000)
      ? { privacyStatus: 'private', publishAt: new Date(publishAt).toISOString(), selfDeclaredMadeForKids: false, embeddable: true }   // YouTube publishes it at the slot
      : { privacyStatus: 'public', selfDeclaredMadeForKids: false, embeddable: true },
  };
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify(meta),
  });
  const loc = start.headers.get('location');
  if (!loc) throw new Error(`YouTube upload start failed: ${start.status} ${(await start.text()).slice(0, 300)}`);
  const up = await fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(600_000) });
  const v = await up.json();
  if (!v.id) throw new Error(`YouTube upload failed: ${up.status} ${JSON.stringify(v).slice(0, 300)}`);
  return { id: v.id, url: `https://www.youtube.com/shorts/${v.id}` };
}

// ---------- one-time sign-in ----------
async function auth() {
  const c = client();
  const port = 8765, redirect = `http://127.0.0.1:${port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' })}`;
  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.end(q.get('code') ? 'YouTube connected. You can close this tab.' : `Sign-in failed: ${q.get('error')}`);
      srv.close(); q.get('code') ? resolve(q.get('code')) : reject(new Error(q.get('error')));
    }).listen(port, '127.0.0.1', () => { console.log(`Opening Google sign-in… pick the account that owns the YouTube channel.\n${url}`); try { execFileSync('open', [url]); } catch {} });
  });
  const r = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirect, grant_type: 'authorization_code' }) })).json();
  if (!r.refresh_token) throw new Error(`No refresh token: ${JSON.stringify(r).slice(0, 200)}`);
  const envFile = join(ROOT, '.env');
  const lines = readFileSync(envFile, 'utf8').split('\n').filter((l) => !/^(YT_REFRESH_TOKEN|YT_CLIENT_ID|YT_CLIENT_SECRET)=/.test(l) && l !== '');
  lines.push(`YT_CLIENT_ID=${c.id}`, `YT_CLIENT_SECRET=${c.secret}`, `YT_REFRESH_TOKEN=${r.refresh_token}`);
  writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  // which channel did we connect?
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${r.access_token}` } })).json();
  console.log(`✓ Connected YouTube channel: ${ch.items?.[0]?.snippet?.title ?? 'unknown'} — token saved to .env`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === 'auth') await auth();
  else if (cmd === 'upload' && id) {
    const p = join(ROOT, 'drafts', `${id}.json`); const d = JSON.parse(readFileSync(p, 'utf8'));
    const r = await uploadShort(d); console.log(`✓ ${id} uploaded: ${r.url}`);
  } else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
}
