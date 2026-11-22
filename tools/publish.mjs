#!/usr/bin/env node
// Publishes an APPROVED draft to Instagram / TikTok / YouTube through Buffer's API.
// Video and image files are first uploaded to the public Supabase "clips" bucket,
// because Buffer only accepts media by public URL. X is not in Buffer (free plan = 3 channels),
// so X captions are printed for posting in Chrome / X's scheduler.
//
//   node tools/publish.mjs setup                     create the public "clips" bucket (once)
//   node tools/publish.mjs <id> --now                publish now
//   node tools/publish.mjs <id> --at 2026-11-19T11:00:00+01:00   schedule
//   node tools/publish.mjs <id> --draft              save to Buffer drafts only (test; no approval needed)
//
// .env: BUFFER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { env } from './lib/env.mjs';
import { youtubeReady, uploadShort } from './youtube.mjs';
const BUCKET = 'gta6-clips';
const CHANNELS = {
  tiktok: '6afdb4c2ece6dfde5f0bc0a2',
  youtube: '6afdb4a4ece6dfde5f0bbf51',
  instagram: '6afdb443ece6dfde5f0bba50',
};

function need(...keys) {
  for (const k of keys) if (!env[k]) throw new Error(`Missing ${k} in .env`);
}

async function supabase(path, init = {}) {
  need('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
  // retry network blips (flaky DNS) up to 4 times
  let res;
  for (let i = 1; ; i++) { try { res = await fetchOnce(); break; } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 10_000 * i)); } }
  async function fetchOnce() { return fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/${path}`, {
    ...init,
    // New-style secret keys (sb_secret_…) go in `apikey` only; legacy service_role JWTs also go in Authorization.
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      ...(env.SUPABASE_SERVICE_KEY.startsWith('sb_') ? {} : { authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(300_000),
  }); }
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

export async function upload(relPath) {
  const file = join(ROOT, relPath);
  const name = `${new Date().toISOString().slice(0, 10)}/${basename(file)}`;
  const type = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[extname(file).toLowerCase()];
  if (!type) throw new Error(`Unsupported media type: ${relPath}`);
  console.log(`uploading ${relPath} (${(statSync(file).size / 1e6).toFixed(1)} MB)…`);
  await supabase(`object/${BUCKET}/${name}`, { method: 'POST', headers: { 'content-type': type, 'x-upsert': 'true', 'cache-control': '31536000' }, body: readFileSync(file) });
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${name}`;
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok || !(head.headers.get('content-type') ?? '').startsWith(type.split('/')[0])) throw new Error(`Public URL check failed (${head.status}): ${url}`);
  return { url, kind: type.startsWith('video') ? 'video' : 'image' };
}

async function buffer(query, variables) {
  need('BUFFER_API_KEY');
  const res = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.BUFFER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Buffer: ${JSON.stringify(data.errors).slice(0, 400)}`);
  return data.data;
}

const CREATE = `mutation($input: CreatePostInput!) { createPost(input: $input) {
  __typename
  ... on PostActionSuccess { post { id status dueAt channelService } }
  ... on InvalidInputError { message } ... on LimitReachedError { message } ... on UnexpectedError { message }
  ... on RestProxyError { message } ... on NotFoundError { message } ... on UnauthorizedError { message } } }`;

function metadataFor(service, d, kind) {
  const firstLine = (d.captions[service] ?? d.captions.x ?? '').split('\n')[0].replace(/#\S+/g, '').trim();
  if (service === 'youtube')
    return { youtube: { title: (d.youtube_title ?? `${firstLine} #Shorts`).slice(0, 100), categoryId: '20', privacy: 'public', madeForKids: false, license: 'youtube', notifySubscribers: true, embeddable: true, isAiGenerated: false } };
  if (service === 'tiktok') return { tiktok: { isAiGenerated: false } };
  if (service === 'instagram') return { instagram: { type: kind === 'video' ? 'reel' : 'post', shouldShareToFeed: true, isAiGenerated: false } };
  return undefined;
}

async function publish(id, mode, at) {
  const p = join(ROOT, 'drafts', `${id}.json`);
  if (!existsSync(p)) throw new Error(`No draft ${id}`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  if (mode !== 'draft' && d.status !== 'approved') throw new Error(`${id} is "${d.status ?? 'draft'}", not approved. Nothing posted.`);
  // The Mac clipper uploads media and stores media_url; GitHub Actions reuses that link.
  const isVid = (x) => /\.(mp4|mov)$/i.test(x ?? '');
  const media = d.media_url ? { url: d.media_url, kind: isVid(d.media_url) ? 'video' : 'image' } : d.media ? await upload(d.media) : null;
  d.media_url = media?.url;
  d.buffer = d.buffer ?? {};
  for (const service of (d.publish_platforms ?? d.platforms).filter((s) => CHANNELS[s])) {
    if (service === 'youtube' && youtubeReady() && mode !== 'draft') {   // direct YouTube API: ~6/day instead of Buffer's 1-2
      try {
        const r = await uploadShort(d, mode === 'at' ? at : null);
        d.buffer.youtube = { direct: true, videoId: r.id, url: r.url, dueAt: mode === 'at' ? new Date(at).toISOString() : new Date().toISOString() };
        console.log(`✓ youtube (direct): ${r.url}`);
      } catch (e) { d.buffer.youtube = { error: `YouTube API: ${e.message.slice(0, 200)}` }; console.log(`✗ youtube (direct): ${e.message.slice(0, 200)}`); }
      continue;
    }
    if (!media && service !== 'instagram') { console.log(`skip ${service}: needs media`); continue; }
    const input = {
      channelId: CHANNELS[service],
      text: d.captions[service] ?? d.captions.x,
      assets: media ? [{ [media.kind]: { url: media.url } }] : [],
      metadata: metadataFor(service, d, media?.kind),
      schedulingType: 'automatic',
      needsApproval: false,
      mode: mode === 'now' ? 'shareNow' : mode === 'at' ? 'customScheduled' : 'addToQueue',
      ...(mode === 'at' ? { dueAt: new Date(at).toISOString() } : {}),
      ...(mode === 'draft' ? { saveToDraft: true } : {}),
      source: 'gta6archiveshq-tools',
    };
    const r = (await buffer(CREATE, { input })).createPost;
    if (r.__typename === 'PostActionSuccess') {
      d.buffer[service] = { id: r.post.id, status: r.post.status, dueAt: r.post.dueAt, mode };
      console.log(`✓ ${service}: ${r.post.status} ${r.post.dueAt ?? ''} (post ${r.post.id})`);
    } else if (r.__typename === 'LimitReachedError' && service === 'youtube') {
      // YouTube allows Buffer only 2 Shorts a day: the first two clips of the day get YouTube, the rest skip it.
      d.buffer[service] = { skipped: 'YouTube daily limit (2/day)' };
      console.log(`– youtube: skipped, daily limit reached`);
    } else {
      d.buffer[service] = { error: `${r.__typename}: ${r.message}` };
      console.log(`✗ ${service}: ${r.__typename}: ${r.message}`);
    }
  }
  if (d.platforms.includes('x') && !d.x_status) { d.x_status = 'pending'; console.log(`X queued for Claude + owner: ${d.id}`); }
  writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const [cmd, ...rest] = isMain ? process.argv.slice(2) : [];
if (cmd === 'setup') {
  try {
    await supabase('bucket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 50 * 1024 * 1024, allowed_mime_types: ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png'] }) });
    console.log(`bucket "${BUCKET}" created (public)`);
  } catch (e) {
    if (/already exists|Duplicate/i.test(e.message)) console.log(`bucket "${BUCKET}" already exists`);
    else throw e;
  }
} else if (cmd && rest.includes('--now')) await publish(cmd, 'now');
else if (cmd && rest.includes('--at')) await publish(cmd, 'at', rest[rest.indexOf('--at') + 1]);
else if (cmd && rest.includes('--draft')) await publish(cmd, 'draft');
else if (isMain) console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n'));
