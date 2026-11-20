// Shared clip-making helpers for the Mac YouTube clipper and the cloud Twitch clipper.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './env.mjs';

export const BIN = join(ROOT, 'tools', 'bin');
export const STATE = join(ROOT, 'state');
export const DRAFTS = join(ROOT, 'drafts');
export const SLOTS = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00']; // WAT (UTC+1): up to 8 clips a day
mkdirSync(STATE, { recursive: true });
export const log = (m) => console.log(`[${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}] ${m}`);
export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000, ...opts });
export const git = (...a) => sh('git', a);
export const readJSON = (f, dflt) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt);
export const drafts = () => readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DRAFTS, f), 'utf8')));
export const saveDraft = (d) => writeFileSync(join(DRAFTS, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n');

// Use tools/bin (Mac) when present, otherwise the system tool (GitHub runner).
export const tool = (name) => (existsSync(join(BIN, name)) ? join(BIN, name) : name);

export function cleanTitle(t) {
  const mission = t.match(/Mission\s*#?\s*\d+\s*[-–—:]\s*([^|\[(]+)/i);         // "Mission #3 - Gear Up (…)" -> "Mission: Gear Up"
  if (mission) return `Mission: ${mission[1].replace(/\s{2,}/g, ' ').trim()}`;
  let x = t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\uFE0F]/gu, '').replace(/\[[^\]]*\]|\([^)]*\)|#\S+/g, '');
  x = x.replace(/\b(Grand Theft Auto ?(VI|6)|GTA ?VI|GTA6)\b/gi, 'GTA 6')
       .replace(/\b(PS5( Pro)?|Xbox Series [XS|]+|4K|8K|60 ?FPS|HDR|Ultra|Max Settings|Gameplay Walkthrough|Walkthrough|Part \d+|Full Game|No Commentary)\b/gi, '');
  // keep the most meaningful part of "A - B | C" titles (not a bare "GTA 6")
  const parts = x.split(/\s[|–—]\s|\s-\s/).map((p) => p.replace(/\s{2,}/g, ' ').replace(/^[\s:!,.-]+|[\s:,.-]+$/g, '').trim()).filter((p) => p && !/^GTA 6$/i.test(p));
  return parts[0] ?? '';
}

export function render(src, start, end, hook, credit, out, caption) {
  sh(join(ROOT, 'tools', 'clip.sh'), [src, String(start), String(end), hook, credit, out, caption]);
  // X copy must stay under 10 MB: pick the video bitrate from the clip length
  const dur = Math.max(1, Number(end) - Number(start));
  const kbps = Math.max(800, Math.min(3200, Math.floor((9 * 8 * 1000) / dur) - 160));
  const xOut = out.replace(/\.mp4$/, '_x.mp4');
  sh(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c:v', 'libx264', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.1)}k`, '-bufsize', `${kbps * 2}k`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', xOut]);
  return xOut;
}

export function nextSlot(taken) {
  for (let day = 0; day < 4; day++) {
    for (const s of SLOTS) {
      const d = new Date(Date.now() + day * 86400000);
      const iso = `${d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })}T${s}:00+01:00`;
      if (new Date(iso) > new Date(Date.now() + 60 * 60_000) && !taken.has(iso)) return iso;
    }
  }
  return null;
}

export function captionsFor(ch, line) {
  const tag = (p) => (ch.handles?.[p] ? `@${ch.handles[p].replace(/^@/, '')}` : `${ch.name} on ${ch.platform ?? 'YouTube'}`);
  return {
    x: `${line}\n\n🎥 ${tag('x')}`,
    tiktok: `${line} 🎥 ${tag('tiktok')} #GTA6 #GTAVI #ViceCity`,
    youtube: `${line} 🎥 ${tag('youtube')} #GTA6 #GTAVI #ViceCity`,
    instagram: `${line}\n\n🎥 ${tag('instagram')}\n\n#GTA6 #GTAVI #ViceCity #Leonida #GrandTheftAuto`,
  };
}

