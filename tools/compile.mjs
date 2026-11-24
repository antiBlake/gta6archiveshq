#!/usr/bin/env node
// Weekly compilations (owner choice, 2026-11-24): instead of reposting other people's viral videos one by one
// (TikTok/Instagram flag those as unoriginal), combine the best 6-8 s of 4-5 of them into one numbered video:
//   "5 GTA 6 moments you missed this week"  #5 … #1, each segment with its own caption + creator credit.
// Runs on the Mac (clipper calls it) on Mon/Wed/Fri when the pool has >= 4 unused segments.
//   node tools/compile.mjs            (respects the schedule)
//   node tools/compile.mjs --force    (build one now if the pool allows)

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.mjs';
import { upload } from './publish.mjs';
import { STATE, log, sh, tool, readJSON, drafts, saveDraft, render, nextSlot, captionsFor } from './lib/clips.mjs';

const poolF = join(STATE, 'comp_pool.json');
const lastF = join(STATE, 'last_compilation');
const force = process.argv.includes('--force');
const pool = readJSON(poolF, []);
const fresh = pool.filter((p) => !p.used && existsSync(join(ROOT, p.file)) && (p.quality ?? 0) >= 6);
const dayWAT = new Date(Date.now() + 3600_000).getUTCDay(); // 1=Mon 3=Wed 5=Fri
const last = existsSync(lastF) ? new Date(readFileSync(lastF, 'utf8')) : new Date(0);

if (!force && (![1, 3, 5].includes(dayWAT) || Date.now() - last < 40 * 3600_000)) { log('compile: not a compilation day yet'); process.exit(0); }
if (fresh.length < 4) { log(`compile: only ${fresh.length} segment(s) in the pool, need 4`); process.exit(0); }

// best 5 (or 4), strongest last so the video builds up to #1
const picks = fresh.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0)).slice(0, 5).reverse();
const n = picks.length;
const title = `${n} GTA 6 moments you missed this week`;
const id = `K${Math.max(0, ...drafts().filter((d) => /^K\d+$/.test(d.id)).map((d) => parseInt(d.id.slice(1)))) + 1}`;
const work = join(ROOT, 'media', 'work', id);
mkdirSync(work, { recursive: true });

// 1. render each segment in the house style: "#n  caption", credit underneath; the first one also carries the title
const parts = [];
picks.forEach((p, i) => {
  const num = n - i;
  const hook = `${i === 0 ? `${title}\n` : ''}#${num}  ${p.caption ?? ''}`.trim();
  const credit = p.handle ? `@${p.handle}` : p.who;
  const out = join('media', 'work', id, `${i}.mp4`);
  render(p.file, p.start, p.end, hook, credit, out, '', p.vertical ? { layout: 'portrait', hookY: 300 } : { layout: 'full', hookY: 300 });
  rmSync(join(ROOT, out.replace(/\.mp4$/, '_x.mp4')), { force: true });
  parts.push(out);
});

// 2. join them (re-encode so frame rates/sizes match), plus an X-sized copy
const list = join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${join(ROOT, p)}'`).join('\n'));
const outMain = `media/edits/${id}.mp4`, outX = `media/edits/${id}_x.mp4`;
sh(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '6M', '-bufsize', '12M', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', outMain], { timeout: 1_800_000 });
const dur = parseFloat(sh(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outMain]));
const kbps = Math.max(800, Math.min(3200, Math.floor((9 * 8 * 1000) / dur) - 160));
sh(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', outMain, '-c:v', 'libx264', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.1)}k`, '-bufsize', `${kbps * 2}k`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outX]);

// 3. draft: credits for every creator, auto-approved (each segment already passed the Gemini check)
const credits = picks.slice().reverse().map((p, i) => `#${i + 1} ${p.handle ? `@${p.handle}` : p.who}`).join(' · ');
const line = `${title} 👀 Which one is your favourite?\n\nCredits: ${credits}`;
const all = drafts();
const taken = new Set(all.map((d) => d.slot).filter(Boolean));
const d = {
  id, platforms: ['x', 'tiktok', 'youtube', 'instagram'], status: 'approved', auto_approved: true, slot: nextSlot(taken),
  credit: picks.map((p) => p.who).join(', '), category: 'compilation',
  media: outMain, media_x: outX, media_url: (await upload(outMain)).url, media_x_url: (await upload(outX)).url,
  hook: title, captions: {
    x: line.slice(0, 270),
    tiktok: `${line} #GTA6 #GTAVI #ViceCity`,
    youtube: `${line} #GTA6 #GTAVI #ViceCity`,
    instagram: `${line}\n\n#GTA6 #GTAVI #ViceCity #Leonida #GrandTheftAuto`,
  },
  judge: { quality: Math.round(picks.reduce((a, p) => a + (p.quality ?? 6), 0) / n), what: `Compilation of ${n} moments`, layout: 'compilation' },
  source: { segments: picks.map((p) => ({ url: p.url, start: p.start, end: p.end, who: p.who })) },
  notes: `Compilation of ${n} credited moments: ${picks.map((p) => p.url).join(' ')}`,
};
saveDraft(d);
for (const p of picks) Object.assign(pool.find((x) => x.id === p.id), { used: id });
writeFileSync(poolF, JSON.stringify(pool, null, 2));
writeFileSync(lastF, new Date().toISOString());
rmSync(work, { recursive: true, force: true });
log(`✓ compilation ${id}: ${title} (${Math.round(dur)} s) → ${d.slot}`);
