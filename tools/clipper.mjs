#!/usr/bin/env node
// YouTube clipper: runs on the Mac (launchd, every 15 min). No AI.
//  - Every 2 h (or right after /clip in Telegram): checks channels.json for new GTA 6 uploads,
//    cuts each video's YouTube "Most replayed" peak (~20 s) full-screen with a template hook,
//    uploads it to Supabase and sends it to Telegram for ✅.
//  - Any time: re-renders clips whose hook you changed with "hook <id>: NEW TEXT".
// State is shared with GitHub Actions through the git repo (pull before, push after).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/env.mjs';
import { upload } from './publish.mjs';

const BIN = join(ROOT, 'tools', 'bin');
const STATE = join(ROOT, 'state');
const DRAFTS = join(ROOT, 'drafts');
const SCAN_EVERY_MS = 2 * 60 * 60 * 1000;
const MAX_NEW = 3;
const SLOTS = ['11:00', '13:00', '16:00', '18:30', '21:00']; // WAT (UTC+1)
mkdirSync(STATE, { recursive: true });
const log = (m) => console.log(`[${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}] ${m}`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000, ...opts });
const git = (...a) => sh('git', a);
const readJSON = (f, dflt) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt);
const drafts = () => readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DRAFTS, f), 'utf8')));
const saveDraft = (d) => writeFileSync(join(DRAFTS, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n');

function sync(msg) {
  try {
    git('add', '-A', 'drafts', 'state', 'log.md', 'scoreboard.csv', 'channels.json');
    if (git('status', '--porcelain', 'drafts', 'state', 'log.md', 'scoreboard.csv', 'channels.json').trim()) git('commit', '-m', msg);
    git('pull', '--rebase', '--autostash', '-q');
    git('push', '-q');
  } catch (e) { log(`git sync failed: ${e.message.split('\n')[0]}`); }
}

function cleanTitle(t) {
  return t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, '').replace(/\[[^\]]*\]|\([^)]*\)|#\S+/g, '')
    .split(/\s[|–-]\s/)[0].replace(/\b(GTA ?(6|VI)|Grand Theft Auto ?(6|VI)?|PS5( Pro)?|4K|60 ?FPS|Gameplay|Walkthrough|Part \d+)\b/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/^[\s:!,.-]+|[\s:,.-]+$/g, '').trim();
}

function render(src, start, end, hook, credit, out, caption) {
  sh(join(ROOT, 'tools', 'clip.sh'), [src, String(start), String(end), hook, credit, out, caption]);
  const xOut = out.replace(/\.mp4$/, '_x.mp4');
  sh(join(BIN, 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c:v', 'libx264', '-b:v', '3200k', '-maxrate', '3600k', '-bufsize', '7200k', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', xOut]);
  return xOut;
}

function nextSlot(taken) {
  for (let day = 0; day < 4; day++) {
    for (const s of SLOTS) {
      const d = new Date(Date.now() + day * 86400000);
      const iso = `${d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })}T${s}:00+01:00`;
      if (new Date(iso) > new Date(Date.now() + 60 * 60_000) && !taken.has(iso)) return iso;
    }
  }
  return null;
}

function captionsFor(ch, line) {
  const tag = (p) => (ch.handles?.[p] ? `@${ch.handles[p].replace(/^@/, '')}` : `${ch.name} on YouTube`);
  return {
    x: `${line}\n\n🎥 ${tag('x')}`,
    tiktok: `${line} 🎥 ${tag('tiktok')} #GTA6 #GTAVI #ViceCity`,
    youtube: `${line} 🎥 ${tag('youtube')} #GTA6 #GTAVI #ViceCity`,
    instagram: `${line}\n\n🎥 ${tag('instagram')}\n\n#GTA6 #GTAVI #ViceCity #Leonida #GrandTheftAuto`,
  };
}

// ---------- re-render clips with a new hook ----------
async function rehooks() {
  for (const d of drafts().filter((x) => x.status === 'rehook' && x.source)) {
    const s = d.source;
    if (!existsSync(join(ROOT, s.file))) { log(`${d.id}: source ${s.file} missing, cannot re-render`); continue; }
    const v = (d.version ?? 1) + 1;
    const out = `media/edits/${d.id}_v${v}.mp4`;
    log(`${d.id}: re-rendering with hook "${d.hook_request}"`);
    const xOut = render(s.file, s.start, s.end, d.hook_request, s.credit, out, s.caption ?? '');
    Object.assign(d, { media: out, media_x: xOut, version: v, hook: d.hook_request, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url });
    delete d.hook_request;
    saveDraft(d);
    sh(process.execPath, ['tools/approve.mjs', 'send', d.id]);
  }
}

// ---------- scan channels for new uploads ----------
async function scan() {
  const channels = readJSON(join(ROOT, 'channels.json'), []);
  const seenFile = join(STATE, 'yt_seen.json');
  const seen = new Set(readJSON(seenFile, []));
  const pendingFile = join(STATE, 'yt_pending.json');
  const pending = readJSON(pendingFile, {}); // video id -> last time we checked it for "Most replayed" data
  const all = drafts();
  const taken = new Set(all.map((d) => d.slot).filter(Boolean));
  let made = 0;
  for (const ch of channels) {
    if (made >= MAX_NEW) break;
    let entries = [];
    try { entries = JSON.parse(sh(join(BIN, 'yt-dlp'), ['--flat-playlist', '-J', '--playlist-end', '8', '--no-warnings', ch.youtube])).entries ?? []; }
    catch (e) { log(`${ch.name}: list failed: ${e.message.split('\n')[0]}`); continue; }
    for (const e of entries) {
      if (made >= MAX_NEW) break;
      if (seen.has(e.id) || !/GTA ?(6|VI)|Grand Theft Auto VI/i.test(e.title ?? '')) continue;
      if (pending[e.id] && Date.now() - new Date(pending[e.id]) < 6 * 3600_000) continue; // rechecked at most every 6 h
      let info;
      try { info = JSON.parse(sh(join(BIN, 'yt-dlp'), ['-j', '--no-warnings', `https://www.youtube.com/watch?v=${e.id}`])); }
      catch (err) { log(`${e.id}: info failed (live or private?)`); continue; }
      const ageH = (Date.now() / 1000 - (info.timestamp ?? info.release_timestamp ?? 0)) / 3600;
      const hm = (info.heatmap ?? []).filter((h) => h.start_time > 30 && h.end_time < info.duration - 30);
      if (!hm.length) { if (ageH > 72) seen.add(e.id); else pending[e.id] = new Date().toISOString(); log(`${e.id}: no "Most replayed" data yet (${Math.round(ageH)} h old)`); continue; }
      seen.add(e.id); delete pending[e.id];
      const peak = hm.reduce((a, b) => (b.value > a.value ? b : a));
      const mid = (peak.start_time + peak.end_time) / 2;
      const start = Math.max(0, Math.round(mid - 12)), end = Math.min(info.duration, Math.round(mid + 10));
      const prefix = ch.type === 'streamer' ? 'S' : 'C';
      const id = `${prefix}${Math.max(0, ...all.filter((d) => d.id.startsWith(prefix)).map((d) => parseInt(d.id.slice(1)) || 0)) + 1 + made}`;
      const src = `media/raw/${id}_${e.id}.mp4`;
      log(`${id}: ${ch.name} "${info.title}" peak ${start}-${end}s`);
      try {
        sh(join(BIN, 'yt-dlp'), ['-q', '--no-warnings', '--ffmpeg-location', BIN, '--download-sections', `*${start}-${end}`, '--force-keyframes-at-cuts',
          '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]', '--merge-output-format', 'mp4', '-o', src, `https://www.youtube.com/watch?v=${e.id}`]);
      } catch (err) { log(`${id}: download failed: ${err.message.split('\n')[0]}`); continue; }
      const title = cleanTitle(info.title);
      const hook = (ch.type === 'streamer' ? `${ch.name} in GTA 6` : (title || 'This moment in GTA 6')).toUpperCase().slice(0, 48);
      const caption = ch.type === 'streamer' ? title.slice(0, 40) : '';
      const credit = ch.handles?.tiktok ? `@${ch.handles.tiktok.replace(/^@/, '')}` : ch.name;
      const out = `media/edits/${id}.mp4`;
      const xOut = render(src, 0, end - start, hook, credit, out, caption);
      const slot = nextSlot(taken); taken.add(slot);
      const line = ch.type === 'streamer' ? `${ch.name} playing GTA 6 👀${title ? ` ${title}` : ''}` : `${title || 'This moment'} in GTA 6 🎮`;
      const d = {
        id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'draft', slot, credit: ch.name,
        media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
        hook, captions: captionsFor(ch, line),
        source: { file: src, start: 0, end: end - start, credit, caption, url: `https://www.youtube.com/watch?v=${e.id}&t=${start}s` },
        notes: `Auto-picked from YouTube "Most replayed" (${start}-${end}s) of ${ch.name}: https://youtu.be/${e.id}?t=${start} — check for story spoilers. Change the on-screen text with: hook ${id}: NEW TEXT`,
      };
      saveDraft(d);
      all.push(d);
      sh(process.execPath, ['tools/approve.mjs', 'send', id]);
      made++;
    }
  }
  writeFileSync(seenFile, JSON.stringify([...seen].slice(-2000)));
  writeFileSync(pendingFile, JSON.stringify(pending));
  writeFileSync(join(STATE, 'last_scan'), new Date().toISOString());
  return made;
}

try { git('pull', '--rebase', '--autostash', '-q'); } catch (e) { log(`git pull failed: ${e.message.split('\n')[0]}`); }
await rehooks();
const last = existsSync(join(STATE, 'last_scan')) ? new Date(readFileSync(join(STATE, 'last_scan'), 'utf8')) : new Date(0);
const requested = existsSync(join(STATE, 'clip_request'));
if (requested || Date.now() - last > SCAN_EVERY_MS) {
  const n = await scan();
  rmSync(join(STATE, 'clip_request'), { force: true });
  log(`scan done: ${n} new clip(s)`);
}
sync('clipper: drafts and state');
