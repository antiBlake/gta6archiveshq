#!/usr/bin/env node
// YouTube clipper: runs on the Mac (launchd, every 15 min). No AI.
//  - Every 2 h (or right after /clip in Telegram): checks channels.json for new GTA 6 uploads,
//    cuts each video's YouTube "Most replayed" peak (~20 s) full-screen with a template hook,
//    uploads it to Supabase and sends it to Telegram for ✅.
//  - Any time: re-renders clips whose hook you changed with "hook <id>: NEW TEXT".
// State is shared with GitHub Actions through the git repo (pull before, push after).

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/env.mjs';
import { upload } from './publish.mjs';
import { riskReasons } from './lib/risk.mjs';
import { judgeClip, decide } from './lib/gemini.mjs';
import { env } from './lib/env.mjs';
import { BIN, STATE, DRAFTS, SLOTS, log, sh, git, readJSON, drafts, saveDraft, tool, cleanTitle, render, nextSlot, captionsFor } from './lib/clips.mjs';

const SCAN_EVERY_MS = 2 * 60 * 60 * 1000;
const MAX_NEW = 6;

function sync(msg) {
  try {
    git('add', '-A', 'drafts', 'state', 'log.md', 'scoreboard.csv', 'channels.json');
    if (git('status', '--porcelain', 'drafts', 'state', 'log.md', 'scoreboard.csv', 'channels.json').trim()) git('commit', '-m', msg);
    git('pull', '--rebase', '--autostash', '-X', 'theirs', '-q'); // on a clash, keep this run's record of what it did
    git('push', '-q');
  } catch (e) { log(`git sync failed: ${e.message.split('\n')[0]}`); }
}

// ---------- re-render clips with a new hook ----------
async function rehooks() {
  for (const d of drafts().filter((x) => x.status === 'rehook' && x.source)) {
    const s = d.source;
    if (!existsSync(join(ROOT, s.file)) && /twitch\.tv/.test(s.url ?? '')) {   // made in the cloud: fetch the Twitch clip again
      const fmt = s.layout?.layout === 'portrait' ? 'portrait-1296/portrait-1080/portrait-720' : '1080/720/best[height<=1080]/best';
      try { YT(['-q', '-f', fmt, '-o', s.file, s.url]); } catch (e) { log(`${d.id}: could not re-download ${s.url}`); }
    }
    if (!existsSync(join(ROOT, s.file))) { log(`${d.id}: source ${s.file} missing, cannot re-render`); continue; }
    const v = (d.version ?? 1) + 1;
    const out = `media/edits/${d.id}_v${v}.mp4`;
    log(`${d.id}: re-rendering with hook "${d.hook_request}"`);
    const xOut = render(s.file, s.start, s.end, d.hook_request, s.credit, out, s.caption ?? '', s.layout ?? {});
    Object.assign(d, { media: out, media_x: xOut, version: v, hook: d.hook_request, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url });
    delete d.hook_request;
    if (d.auto_approved || d.keep_approved) { d.status = 'approved'; delete d.keep_approved; saveDraft(d); continue; } // fix-only re-render: stays approved
    saveDraft(d);
    sh(process.execPath, ['tools/approve.mjs', 'send', d.id]);
  }
}

// ---------- link queue: viral posts from X / Instagram / TikTok added by the owner (Telegram "add <url>") or Claude ----------
async function processQueue() {
  const qf = join(STATE, 'link_queue.json');
  const q = readJSON(qf, []);
  const todo = q.filter((x) => !x.done);
  if (!todo.length) return 0;
  const all = drafts();
  const taken = new Set(all.map((d) => d.slot).filter(Boolean));
  let made = 0;
  for (const item of todo.slice(0, 4)) {
    item.done = new Date().toISOString();
    let info;
    try { info = JSON.parse(YT(['-j', item.url])); } catch (e) { item.result = `info failed: ${e.message.split('\n')[0].slice(0, 120)}`; continue; }
    const id = `V${Math.max(0, ...all.filter((d) => /^V\d+$/.test(d.id)).map((d) => parseInt(d.id.slice(1)))) + 1}`;
    const src = `media/raw/${id}.mp4`;
    try { YT(['-q', '--ffmpeg-location', BIN, '-f', 'bv*+ba/b', '-S', 'res,fps', '--merge-output-format', 'mp4', '-o', src, item.url]); }
    catch (e) { item.result = 'download failed'; continue; }
    const platform = /x\.com|twitter\.com/.test(item.url) ? 'X' : /instagram/.test(item.url) ? 'Instagram' : /tiktok/.test(item.url) ? 'TikTok' : 'YouTube';
    const who = info.uploader ?? info.channel ?? 'unknown';
    const handle = info.uploader_id && !/^\d+$/.test(info.uploader_id) ? info.uploader_id.replace(/^@/, '') : null;
    let v;
    try { v = await judgeClip(join(ROOT, src), { who, kind: `viral ${platform} post (credit the creator)`, title: (info.title ?? info.description ?? '').slice(0, 200), duration: info.duration ?? 30, layout: info.height > info.width ? 'vertical 9:16 video (may already have its own text)' : 'landscape 16:9 video' }); }
    catch (e) { item.result = `Gemini failed: ${e.message.slice(0, 120)}`; continue; }
    const verdict = decide(v);
    if (verdict.action === 'discard') { item.result = `dropped: ${verdict.why}`; rmSync(join(ROOT, src), { force: true }); log(`✗ ${id} ${item.url} dropped (${verdict.why})`); continue; }
    const vertical = info.height > info.width;
    const dur = info.duration ?? 30;
    const start = dur <= 90 ? 0 : Math.max(0, v.trim_start ?? 0), end = dur <= 90 ? dur : Math.min(dur, Math.max(start + 15, v.trim_end ?? dur));
    const layout = vertical ? { layout: 'portrait' } : v.facecam_box?.w > 0.05 ? { layout: 'stack', cam: v.facecam_box } : { layout: 'full' };
    const credit = handle ? `@${handle}` : who;
    const out = `media/edits/${id}.mp4`;
    // vertical posts usually carry their own text: only add the credit line, no hook
    const xOut = render(src, start, end, vertical ? '' : v.hook, credit, out, vertical ? '' : v.on_screen_caption, { ...layout, ...(vertical ? { hookY: 1330 } : {}) });
    const slot = nextSlot(taken, 'odd'); taken.add(slot);
    const ch = { name: who, handles: platform === 'X' && handle ? { x: handle } : {}, platform: platform === 'X' && handle ? `X (@${handle})` : platform };
    const d = {
      id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'draft', slot, credit: who, category: 'viral',
      media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
      hook: v.hook, captions: captionsFor(ch, v.post_caption),
      judge: { quality: v.quality, confidence: v.confidence, reasons: v.reject_reasons, what: v.what_happens, model: v.model, layout: layout.layout },
      source: { file: src, start, end, credit, caption: v.on_screen_caption, layout, url: item.url, likes: info.like_count, views: info.view_count },
      notes: `Viral ${platform} post by ${who}${handle ? ` (@${handle})` : ''}, ${info.like_count ?? '?'} likes. ${verdict.why}. ${v.what_happens} ${item.url}`,
    };
    const auto = verdict.action === 'auto';
    if (auto) Object.assign(d, { status: 'approved', auto_approved: true });
    saveDraft(d); all.push(d);
    if (!auto) sh(process.execPath, ['tools/approve.mjs', 'send', id]);
    item.result = `${id} ${auto ? 'auto-approved' : 'sent for review'} (${slot})`;
    log(`${auto ? '✓ auto' : '? review'} ${id} ${who} [${layout.layout}] q${v.quality} → ${slot}`);
    made++;
  }
  writeFileSync(qf, JSON.stringify(q, null, 2));
  return made;
}

// ---------- finding moments without AI ----------
function YT(args, tries = 3) {
  for (let i = 1; ; i++) {
    try { return sh(tool('yt-dlp'), ['--no-warnings', '--socket-timeout', '20', '--retries', '5', ...args]); }
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
    const out = sh(tool('ffmpeg'), ['-hide_banner', '-nostats', '-i', audio, '-af', 'asetnsamples=n=44100,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  if (!env.GEMINI_API_KEY) { log('GEMINI_API_KEY missing: not making clips (quality/safety check required)'); return 0; }
  const sources = readJSON(join(ROOT, 'channels.json'), []).filter((c) => c.youtube || c.search); // Twitch streamers are clipped in the cloud
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
        // download a wider window so Gemini can pick a complete moment inside it
        const w0 = Math.max(0, ch.type === 'guide' ? m.start : Math.round((m.start + m.end) / 2) - 35);
        const w1 = Math.min(info.duration, ch.type === 'guide' ? m.start + 90 : w0 + 70);
        const src = `media/raw/${id}_${e.id}.mp4`;
        log(`${id}: ${ch.name} "${info.title}" window ${w0}-${w1}s (${m.how})`);
        try {
          YT(['-q', '--ffmpeg-location', BIN, '--download-sections', `*${w0}-${w1}`, '--force-keyframes-at-cuts',
            '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]', '--merge-output-format', 'mp4', '-o', src, `https://www.youtube.com/watch?v=${e.id}`]);
        } catch (err) { log(`${id}: download failed: ${err.message.split('\n')[0]}`); continue; }
        let v;
        try { v = await judgeClip(join(ROOT, src), { who: ch.name, kind: ch.type === 'guide' ? 'GTA 6 mission guide / tips video (make it a useful how-to tip)' : ch.type === 'streamer' ? 'streamer video' : 'gameplay video', title: info.title, duration: w1 - w0, layout: 'landscape 16:9 YouTube video' }); }
        catch (err) { log(`${id}: Gemini failed: ${err.message}`); continue; }
        const verdict = decide(v);
        if (verdict.action === 'discard') { log(`✗ ${id} dropped (${verdict.why}) — ${v.what_happens}`); rmSync(join(ROOT, src), { force: true }); continue; }
        const len = w1 - w0;
        const start = Math.max(0, Math.min(v.trim_start ?? 0, len - 6)), end = Math.min(len, Math.max(start + 6, v.trim_end ?? len));
        const layout = v.facecam_box?.w > 0.05 ? { layout: 'stack', cam: v.facecam_box } : { layout: 'full' };
        const hook = (v.hook || tpl.hook).slice(0, 70);
        const credit = ch.handles?.tiktok ? `@${ch.handles.tiktok.replace(/^@/, '')}` : ch.name;
        const out = `media/edits/${id}.mp4`;
        const xOut = render(src, start, end, hook, credit, out, v.on_screen_caption ?? '', layout);
        const slot = nextSlot(taken, 'odd'); taken.add(slot);
        const post = ch.type === 'guide' ? `${v.post_caption}\n⚠️ Mission spoilers` : v.post_caption;
        const d = {
          id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'draft', slot, credit: ch.name, category: ch.type,
          media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
          hook, captions: captionsFor(ch, post),
          judge: { quality: v.quality, confidence: v.confidence, reasons: v.reject_reasons, what: v.what_happens, model: v.model, layout: layout.layout },
          source: { file: src, start, end, credit, caption: v.on_screen_caption, layout, url: `https://www.youtube.com/watch?v=${e.id}&t=${w0 + Math.round(start)}s` },
          notes: `${verdict.why}. ${v.what_happens} From ${ch.name}: https://youtu.be/${e.id}?t=${w0 + Math.round(start)}${src0.search ? ' (found by search)' : ''}. Change the on-screen hook with: hook ${id}: NEW TEXT`,
        };
        d.channel_url = info.channel_url;
        const trusted = new Set(readJSON(join(STATE, 'trusted.json'), []));
        const reasons = riskReasons({ title: info.title, hook, caption: `${v.on_screen_caption} ${v.post_caption}`, foundBySearch: !!src0.search && !trusted.has(info.channel_url), category: ch.type });
        const auto = verdict.action === 'auto' && !reasons.length;
        if (!auto) { d.flags = [...reasons, ...(verdict.action === 'review' ? [verdict.why] : [])]; d.notes = `⚠️ Check: ${d.flags.join('; ')}.\n${d.notes}`; }
        else Object.assign(d, { status: 'approved', auto_approved: true });
        saveDraft(d);
        all.push(d);
        if (!auto) sh(process.execPath, ['tools/approve.mjs', 'send', id]);
        log(`${auto ? '✓ auto' : '? review'} ${id} [${layout.layout}] "${hook}" q${v.quality}`);
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
  const [pid, since] = readFileSync(LOCK, 'utf8').split(' ');
  let alive = false; try { process.kill(parseInt(pid), 0); alive = true; } catch {}
  const ageMin = (Date.now() - new Date(since ?? 0)) / 60000;
  if (alive && ageMin < 90) { log(`another clipper run (pid ${pid}) is still working; skipping`); process.exit(0); }
  if (alive) { try { process.kill(parseInt(pid)); } catch {} log(`killed stuck clipper run (pid ${pid}, ${Math.round(ageMin)} min)`); }
}
writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}`);
process.on('exit', () => rmSync(LOCK, { force: true }));
const online = await Promise.race([lookup('www.youtube.com').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
if (!online) { log('offline (cannot resolve www.youtube.com): turn on the VPN / check Wi-Fi. Skipping this run.'); process.exit(0); }
writeFileSync(join(STATE, 'last_alive'), new Date().toISOString());
const KICK = join(STATE, '.last_kick');
if (!existsSync(KICK) || Date.now() - new Date(readFileSync(KICK, 'utf8')) > 28 * 60_000) {
  try { sh('gh', ['workflow', 'run', 'tick']); writeFileSync(KICK, new Date().toISOString()); log('started GitHub publisher'); } catch {}
}
try { git('pull', '--rebase', '--autostash', '-q'); } catch (e) { log(`git pull failed: ${e.message.split('\n')[0]}`); }
await rehooks();
if (env.GEMINI_API_KEY) log(`link queue: ${await processQueue()} new clip(s)`);
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
