#!/usr/bin/env node
// Cloud streamer clipper (GitHub Actions, no AI, Mac not needed).
// Takes the most-viewed Twitch clips of the last 24 h from the streamers in channels.json ("twitch": login),
// keeps only clips Twitch marks as "Grand Theft Auto VI", edits them full screen with the streamer's name,
// uploads to Supabase and sends them to Telegram for ✅. The publisher then posts approved ones at their slot.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';
import { upload } from './publish.mjs';
import { riskReasons } from './lib/risk.mjs';
import { STATE, log, sh, readJSON, drafts, saveDraft, tool, render, nextSlot, captionsFor } from './lib/clips.mjs';

const MAX_NEW = Number(process.env.MAX_NEW ?? 4);   // clips per run
const PER_STREAMER = 2;
const MIN_VIEWS = 300;
const GAME = /Grand Theft Auto VI/i;
const YT = (args) => sh(tool('yt-dlp'), ['--no-warnings', '--socket-timeout', '20', '--retries', '5', ...args]);

const streamers = readJSON(join(ROOT, 'channels.json'), []).filter((c) => c.twitch);
const seenFile = join(STATE, 'tw_seen.json');
const seen = new Set(readJSON(seenFile, []));

// 1. Collect candidate clips from every streamer
const candidates = [];
for (const st of streamers) {
  let urls = [];
  try {
    urls = YT(['--flat-playlist', '--playlist-end', '6', '--print', '%(url)s', `https://www.twitch.tv/${st.twitch}/clips?filter=clips&range=24hr`]).split('\n').filter(Boolean);
  } catch (e) { log(`${st.name}: clip list failed: ${e.message.split('\n')[0]}`); continue; }
  let n = 0;
  for (const url of urls) {
    if (seen.has(url) || n >= PER_STREAMER) continue;
    let info;
    try { info = JSON.parse(YT(['-j', url])); } catch { continue; }
    seen.add(url);
    if (!(info.categories ?? []).some((c) => GAME.test(c))) continue;        // not GTA 6
    if ((info.view_count ?? 0) < MIN_VIEWS || info.duration < 6 || info.duration > 60) continue;
    candidates.push({ st, url, info }); n++;
  }
}
candidates.sort((a, b) => (b.info.view_count ?? 0) - (a.info.view_count ?? 0));
log(`${candidates.length} GTA 6 clip(s) found; making up to ${MAX_NEW}`);

// 2. Edit, upload and send the best ones
const all = drafts();
const taken = new Set(all.map((d) => d.slot).filter(Boolean));
let made = 0;
for (const { st, url, info } of candidates.slice(0, MAX_NEW)) {
  const id = `S${Math.max(0, ...all.filter((d) => /^S\d+$/.test(d.id)).map((d) => parseInt(d.id.slice(1)))) + 1}`;
  const src = `media/raw/${id}_twitch.mp4`;
  try { YT(['-q', '-f', 'best[height<=1080]/best', '-o', src, url]); } catch (e) { log(`${id}: download failed`); continue; }
  const clipTitle = (info.title ?? '').replace(/[\u{1F000}-\u{1FFFF}]/gu, '').trim().slice(0, 40);
  const hook = `${st.name} in GTA 6`.toUpperCase();
  const credit = st.handles?.tiktok ? `@${st.handles.tiktok.replace(/^@/, '')}` : `twitch.tv/${st.twitch}`;
  const out = `media/edits/${id}.mp4`;
  const end = Math.min(info.duration, 60);
  let xOut;
  try { xOut = render(src, 0, end, hook, credit, out, clipTitle); } catch (e) { log(`${id}: render failed: ${e.message.split('\n')[0]}`); continue; }
  const slot = nextSlot(taken); taken.add(slot);
  const ch = { ...st, handles: { ...st.handles } };
  const line = `${st.name} playing GTA 6 👀${clipTitle ? ` "${clipTitle}"` : ''}`;
  const d = {
    id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'draft', slot, credit: st.name, category: 'streamer',
    media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
    hook, captions: captionsFor({ ...ch, name: `${st.name} (twitch.tv/${st.twitch})` }, line),
    source: { file: src, start: 0, end, credit, caption: clipTitle, url, twitch: st.twitch, views: info.view_count },
    notes: `Twitch clip of ${st.name} (${info.view_count} views, ${info.duration}s): ${url} — check for story spoilers. Change the on-screen text with: hook ${id}: NEW TEXT (re-rendered by the Mac).`,
  };
  const reasons = riskReasons({ title: info.title, hook, caption: clipTitle, category: 'streamer' });
  if (reasons.length) { d.flags = reasons; d.notes = `⚠️ Flagged: ${reasons.join('; ')}.\n${d.notes}`; }
  else Object.assign(d, { status: 'approved', auto_approved: true });
  saveDraft(d); all.push(d);
  if (reasons.length) sh(process.execPath, ['tools/approve.mjs', 'send', id]);
  log(`${id}: ${st.name} "${clipTitle}" (${info.view_count} views) → slot ${slot}, ${reasons.length ? `flagged: ${reasons.join('; ')}` : 'auto-approved'}`);
  made++;
}
writeFileSync(seenFile, JSON.stringify([...seen].slice(-3000)));
log(`done: ${made} streamer clip(s) sent to Telegram`);
