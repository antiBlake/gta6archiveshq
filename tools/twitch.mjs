#!/usr/bin/env node
// Cloud streamer clipper (GitHub Actions, Mac not needed).
// 1. Collects the most-viewed GTA 6 Twitch clips (last 24 h) of the streamers in channels.json ("twitch": login).
// 2. Downloads Twitch's PORTRAIT version when it exists (streamer camera on top, game below), else the landscape clip.
// 3. Free Gemini watches each clip: rejects unsafe/weak ones, picks the complete moment, finds the facecam, writes hook + captions.
// 4. Renders 1080x1920 (portrait as is / camera stacked over gameplay / full-screen gameplay), uploads to Supabase.
// 5. Strong clips are auto-approved (published at their slot); unsure ones go to Telegram; bad ones are dropped.

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, env } from './lib/env.mjs';
import { upload } from './publish.mjs';
import { riskReasons } from './lib/risk.mjs';
import { judgeClip, decide } from './lib/gemini.mjs';
import { STATE, log, sh, readJSON, drafts, saveDraft, tool, render, nextSlot, captionsFor } from './lib/clips.mjs';

const MAX_NEW = Number(process.env.MAX_NEW ?? 4);   // drafts per run
const MAX_JUDGED = 10;                               // Gemini calls per run (free tier friendly)
const PER_STREAMER = 3;
const MIN_VIEWS = 300;
const GAME = /Grand Theft Auto VI/i;
const YT = (args) => sh(tool('yt-dlp'), ['--no-warnings', '--socket-timeout', '20', '--retries', '5', ...args]);
if (!env.GEMINI_API_KEY) { log('GEMINI_API_KEY missing: not making clips (quality/safety check required)'); process.exit(0); }

const streamers = readJSON(join(ROOT, 'channels.json'), []).filter((c) => c.twitch);
const seenFile = join(STATE, 'tw_seen.json');
const seen = new Set(readJSON(seenFile, []));
const saveSeen = () => writeFileSync(seenFile, JSON.stringify([...seen].slice(-3000)));

// 1. candidates
const candidates = [];
for (const st of streamers) {
  let urls = [];
  try { urls = YT(['--flat-playlist', '--playlist-end', '8', '--print', '%(url)s', `https://www.twitch.tv/${st.twitch}/clips?filter=clips&range=24hr`]).split('\n').filter(Boolean); }
  catch (e) { log(`${st.name}: clip list failed: ${e.message.split('\n')[0]}`); continue; }
  let n = 0;
  for (const url of urls) {
    if (seen.has(url) || n >= PER_STREAMER) continue;
    let info;
    try { info = JSON.parse(YT(['-j', url])); } catch { continue; }
    seen.add(url);
    if (!(info.categories ?? []).some((c) => GAME.test(c))) continue;
    if ((info.view_count ?? 0) < MIN_VIEWS || info.duration < 8) continue;
    candidates.push({ st, url, info }); n++;
  }
}
candidates.sort((a, b) => (b.info.view_count ?? 0) - (a.info.view_count ?? 0));
log(`${candidates.length} GTA 6 clip(s) to review`);

// 2-5. judge, render, decide
const all = drafts();
const taken = new Set(all.map((d) => d.slot).filter(Boolean));
let made = 0, judged = 0;
for (const { st, url, info } of candidates) {
  if (made >= MAX_NEW || judged >= MAX_JUDGED) break;
  const portrait = null; // owner wants the game bigger than Twitch's 50/50 portrait: use the landscape clip + our 30/70 camera stack
  const src = `media/raw/tw_${info.id}.mp4`;
  try { YT(['-q', '-f', 'bv*[height<=1080]+ba/1080p60/1080/best[height<=1080]/best', '-S', 'res,fps', '-o', src, url]); } catch { log(`${info.id}: download failed`); continue; }

  let v;
  try {
    judged++;
    v = await judgeClip(join(ROOT, src), { who: st.name, kind: 'Twitch stream clip', title: info.title ?? '', duration: info.duration, layout: portrait ? 'vertical: streamer camera on top, game below' : 'landscape 16:9 stream (may contain a webcam overlay)' });
  } catch (e) { log(`${info.id}: Gemini failed: ${e.message}`); continue; }
  const verdict = decide(v);
  const textFlags = riskReasons({ title: info.title, hook: v.hook, caption: `${v.on_screen_caption} ${v.post_caption}` });
  if (verdict.action === 'discard') { log(`✗ ${st.name} "${info.title}": dropped (${verdict.why}) — ${v.what_happens}`); rmSync(join(ROOT, src), { force: true }); continue; }

  const id = `S${Math.max(0, ...all.filter((d) => /^S\d+$/.test(d.id)).map((d) => parseInt(d.id.slice(1)))) + 1}`;
  // Owner: complete length. Keep the whole Twitch clip (viewers already trimmed it to the moment).
  const start = 0, end = info.duration;
  const layout = portrait ? { layout: 'portrait' } : v.facecam_box?.w > 0.05 ? { layout: 'stack', cam: v.facecam_box } : { layout: 'full' };
  const credit = st.handles?.tiktok ? `@${st.handles.tiktok.replace(/^@/, '')}` : `twitch.tv/${st.twitch}`;
  const out = `media/edits/${id}.mp4`;
  let xOut;
  try { xOut = render(src, start, end, v.hook, credit, out, v.on_screen_caption, layout); } catch (e) { log(`${id}: render failed: ${e.message.split('\n')[0]}`); continue; }
  const slot = nextSlot(taken, 'even'); taken.add(slot);
  const auto = verdict.action === 'auto' && !textFlags.length;
  const d = {
    id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: auto ? 'approved' : 'draft', auto_approved: auto, slot, credit: st.name, category: 'streamer',
    media: out, media_x: xOut, media_url: (await upload(out)).url, media_x_url: (await upload(xOut)).url,
    hook: v.hook, captions: captionsFor({ ...st, platform: 'Twitch' }, v.post_caption),
    judge: { quality: v.quality, confidence: v.confidence, reasons: v.reject_reasons, what: v.what_happens, model: v.model, layout: layout.layout },
    source: { file: src, start, end, credit, caption: v.on_screen_caption, url, twitch: st.twitch, views: info.view_count, layout },
    notes: `${verdict.why}${textFlags.length ? `; text flags: ${textFlags.join('; ')}` : ''}. ${v.what_happens} Source: ${url} (${info.view_count} views). Change the on-screen hook with: hook ${id}: NEW TEXT`,
  };
  saveDraft(d); all.push(d);
  if (!auto) sh(process.execPath, ['tools/approve.mjs', 'send', id]);
  log(`${auto ? '✓ auto' : '? review'} ${id}: ${st.name} [${layout.layout}] "${v.hook}" q${v.quality} → ${slot}`);
  made++;
}
saveSeen();
log(`done: ${made} clip(s), ${judged} judged`);
