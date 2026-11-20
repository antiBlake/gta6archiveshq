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
const MAX_NEW = 6;
const SLOTS = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00']; // WAT (UTC+1): up to 8 clips a day
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
  const mission = t.match(/Mission\s*#?\s*\d+\s*[-–—:]\s*([^|\[(]+)/i);         // "Mission #3 - Gear Up (…)" -> "Mission: Gear Up"
  if (mission) return `Mission: ${mission[1].replace(/\s{2,}/g, ' ').trim()}`;
  let x = t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\uFE0F]/gu, '').replace(/\[[^\]]*\]|\([^)]*\)|#\S+/g, '');
  x = x.replace(/\b(Grand Theft Auto ?(VI|6)|GTA ?VI|GTA6)\b/gi, 'GTA 6')
       .replace(/\b(PS5( Pro)?|Xbox Series [XS|]+|4K|8K|60 ?FPS|HDR|Ultra|Max Settings|Gameplay Walkthrough|Walkthrough|Part \d+|Full Game|No Commentary)\b/gi, '');
  // keep the most meaningful part of "A - B | C" titles (not a bare "GTA 6")
  const parts = x.split(/\s[|–—]\s|\s-\s/).map((p) => p.replace(/\s{2,}/g, ' ').replace(/^[\s:!,.-]+|[\s:,.-]+$/g, '').trim()).filter((p) => p && !/^GTA 6$/i.test(p));
  return parts[0] ?? '';
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

// ---------- finding moments without AI ----------
function YT(args, tries = 3) {
  for (let i = 1; ; i++) {
    try { return sh(join(BIN, 'yt-dlp'), ['--no-warnings', '--socket-timeout', '20', '--retries', '5', ...args]); }
    catch (e) {
      if (i >= tries || !/resolve|timed out|Temporary failure|Connection reset/i.test(e.message)) throw e;
      execFileSync('sleep', [String(15 * i)]); // network blip: wait and retry
    }
  }
}

// Loudest 20-second windows of the audio (a streamer's biggest reaction, or the action peak in gameplay).
function loudestWindows(videoId, duration, count = 2) {
  const audio = join(ROOT, 'media', 'work', `${videoId}.m4a`);
  mkdirSync(join(ROOT, 'media', 'work'), { recursive: true });
  try {
    YT(['-q', '-f', 'ba[abr<=80]/ba', '-o', audio, `https://www.youtube.com/watch?v=${videoId}`]);
    const out = sh(join(BIN, 'ffmpeg'), ['-hide_banner', '-nostats', '-i', audio, '-af', 'asetnsamples=n=44100,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const rms = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -90 : parseFloat(m[1])));
    const W = 20, lo = Math.min(90, Math.floor(duration * 0.1)), hi = Math.max(lo + W, rms.length - 60);
    const windows = [];
    for (let t = lo; t + W <= hi; t += 2) windows.push({ t, v: rms.slice(t, t + W).reduce((a, b) => a + b, 0) / W });
    windows.sort((a, b) => b.v - a.v);
    const picks = [];
    for (const w of windows) { if (picks.every((p) => Math.abs(p.t - w.t) > 180)) picks.push(w); if (picks.length >= count) break; }
    return picks.map((p) => ({ start: p.t, end: p.t + W, how: 'loudest 20 s of audio' }));
  } catch (e) { log(`${videoId}: audio scan failed: ${e.message.split('\n')[0]}`); return []; }
  finally { rmSync(audio, { force: true }); }
}

function pickMoments(info, type) {
  const hm = (info.heatmap ?? []).filter((h) => h.start_time > 30 && h.end_time < info.duration - 30).sort((a, b) => b.value - a.value);
  if (hm.length) {
    const picks = [];
    for (const h of hm) { const mid = (h.start_time + h.end_time) / 2; if (picks.every((p) => Math.abs(p.mid - mid) > 120)) picks.push({ mid }); if (picks.length >= 2) break; }
    return picks.map(({ mid }) => ({ start: Math.max(0, Math.round(mid - 12)), end: Math.min(info.duration, Math.round(mid + 10)), how: 'YouTube "Most replayed"' }));
  }
  if (type === 'guide') { // guides usually explain the key step early: take 28 s after the intro
    const s0 = Math.min(Math.max(10, Math.round(info.duration * 0.05)), Math.max(0, info.duration - 30));
    return [{ start: s0, end: Math.min(info.duration, s0 + 28), how: 'start of the guide (after intro)' }];
  }
  return loudestWindows(info.id, info.duration, 2);
}

const TEMPLATES = {
  streamer: (ch, title) => ({ hook: `${ch.name} in GTA 6`, caption: title.slice(0, 40), line: `${ch.name} playing GTA 6 👀${title ? ` ${title}` : ''}`, prefix: 'S' }),
  creator: (ch, title) => ({ hook: title || 'This moment in GTA 6', caption: '', line: /GTA 6/i.test(title) ? `${title} 🎮` : `${title || 'This moment'} in GTA 6 🎮`, prefix: 'C' }),
  guide: (ch, title) => ({ hook: /^Mission: /.test(title) ? `HOW TO ${title.replace(/^Mission: /, 'BEAT ')}` : /tips|things|how to|guide/i.test(title) ? title : `HOW TO: ${title || 'this mission'}`, caption: 'GTA 6 mission tip', line: `GTA 6 tip: ${title.replace(/^Mission: /, 'how to beat ') || 'mission guide'} ✅ Save this for later\n⚠️ Mission spoilers`, prefix: 'T' }),
};

// ---------- scan sources for new uploads ----------
async function scan() {
  const sources = readJSON(join(ROOT, 'channels.json'), []);
  const seenFile = join(STATE, 'yt_seen.json');
  const seen = new Set(readJSON(seenFile, []));
  const all = drafts();
  const taken = new Set(all.map((d) => d.slot).filter(Boolean));
  const nextId = (prefix) => `${prefix}${Math.max(0, ...all.filter((d) => d.id.startsWith(prefix)).map((d) => parseInt(d.id.slice(1)) || 0)) + 1}`;
  let made = 0;
  for (const src0 of sources) {
    if (made >= MAX_NEW) break;
    const listUrl = src0.search ? `https://www.youtube.com/results?search_query=${encodeURIComponent(src0.search)}&sp=CAI%253D` : src0.youtube;
    let entries = [];
    try { entries = JSON.parse(YT(['--flat-playlist', '-J', '--playlist-end', '10', listUrl])).entries ?? []; }
    catch (e) { log(`${src0.name}: list failed: ${e.message.split('\n')[0]}`); continue; }
    let perSource = 0;
    for (const e of entries) {
      if (made >= MAX_NEW || perSource >= (src0.max ?? 2)) break;
      if (seen.has(e.id) || !/GTA ?(6|VI)|Grand Theft Auto VI/i.test(e.title ?? '')) continue;
      if (src0.exclude && new RegExp(src0.exclude, 'i').test(e.title ?? '')) { seen.add(e.id); continue; }
      let info;
      try { info = JSON.parse(YT(['-j', `https://www.youtube.com/watch?v=${e.id}`])); }
      catch (err) { log(`${e.id}: info failed (live or private?)`); continue; }
      if (info.is_live || info.live_status === 'is_live' || !info.duration || info.duration < 45) { if (!info.is_live) seen.add(e.id); continue; }
      seen.add(e.id);
      // Search results: credit the actual uploader of that video.
      const ch = src0.search ? { name: info.channel ?? info.uploader, type: src0.type, handles: {}, youtube: info.channel_url } : src0;
      const t = TEMPLATES[ch.type] ?? TEMPLATES.creator;
      const title = cleanTitle(info.title);
      for (const m of pickMoments(info, ch.type)) {
        if (made >= MAX_NEW) break;
        const tpl = t(ch, title);
        const id = nextId(tpl.prefix);
        const src = `media/raw/${id}_${e.id}.mp4`;
        log(`${id}: ${ch.name} "${info.title}" ${m.start}-${m.end}s (${m.how})`);
        try {
          YT(['-q', '--ffmpeg-location', BIN, '--download-sections', `*${m.start}-${m.end}`, '--force-keyframes-at-cuts',
            '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]', '--merge-output-format', 'mp4', '-o', src, `https://www.youtube.com/watch?v=${e.id}`]);
        } catch (err) { log(`${id}: download failed: ${err.message.split('\n')[0]}`); continue; }
        const hook = tpl.hook.toUpperCase().slice(0, 48);
        const credit = ch.handles?.tiktok ? `@${ch.handles.tiktok.replace(/^@/, '')}` : ch.name;
        const out = `media/edits/${id}.mp4`;
        const len = m.end - m.start;
        const xOut = render(src, 0, len, hook, credit, out, tpl.caption);
        const slot = nextSlot(taken); taken.add(slot);
        const d = {
          id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'draft', slot, credit: ch.name, category: ch.type,
          media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
          hook, captions: captionsFor(ch, tpl.line),
          source: { file: src, start: 0, end: len, credit, caption: tpl.caption, url: `https://www.youtube.com/watch?v=${e.id}&t=${m.start}s` },
          notes: `${ch.type} clip, picked by ${m.how} (${m.start}-${m.end}s) from ${ch.name}: https://youtu.be/${e.id}?t=${m.start}${src0.search ? ' — found by search: check this is the ORIGINAL creator' : ''}. Check for story spoilers. Change the on-screen text with: hook ${id}: NEW TEXT`,
        };
        saveDraft(d);
        all.push(d);
        sh(process.execPath, ['tools/approve.mjs', 'send', id]);
        made++; perSource++;
      }
    }
  }
  writeFileSync(seenFile, JSON.stringify([...seen].slice(-3000)));
  writeFileSync(join(STATE, 'last_scan'), new Date().toISOString());
  return made;
}

import { lookup } from 'node:dns/promises';
const LOCK = join(STATE, 'clipper.lock');
if (existsSync(LOCK)) {
  const pid = parseInt(readFileSync(LOCK, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { log(`another clipper run (pid ${pid}) is still working; skipping`); process.exit(0); }
}
writeFileSync(LOCK, String(process.pid));
process.on('exit', () => rmSync(LOCK, { force: true }));
const online = await Promise.race([lookup('www.youtube.com').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
if (!online) { log('offline (cannot resolve www.youtube.com): turn on the VPN / check Wi-Fi. Skipping this run.'); process.exit(0); }
writeFileSync(join(STATE, 'last_alive'), new Date().toISOString());
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
// GitHub delays scheduled runs on quiet repos; while the Mac is online, start the publisher every 30 min ourselves.
const kick = join(STATE, '.last_kick');
if (!existsSync(kick) || Date.now() - new Date(readFileSync(kick, 'utf8')) > 28 * 60_000) {
  try { sh('gh', ['workflow', 'run', 'tick']); writeFileSync(kick, new Date().toISOString()); log('started GitHub publisher'); }
  catch (e) { log(`could not start GitHub publisher: ${e.message.split('\n')[0]}`); }
}
