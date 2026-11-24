#!/usr/bin/env node
// Frees disk space: deletes local video files that are no longer needed.
//   - files of clips that are posted / pulled / retired / rejected, once they're older than KEEP_DAYS
//   - leftovers no draft points to (old source downloads, tests, previews) older than KEEP_DAYS
// Never touches files of clips that are still waiting to be posted, re-rendered or put on X.
// The posted videos stay on the platforms, and the edited copies stay in Supabase.
//   node tools/cleanup.mjs            (default: older than 2 days)
//   node tools/cleanup.mjs --days 0   (everything that's safe, now)

import { readdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const i = process.argv.indexOf('--days');
const KEEP_DAYS = i > 0 ? Number(process.argv[i + 1]) : 2;
const cutoff = Date.now() - KEEP_DAYS * 86400_000;

const keep = new Set();
for (const f of readdirSync(join(ROOT, 'drafts')).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(ROOT, 'drafts', f), 'utf8'));
  const files = [d.media, d.media_x, d.source?.file].filter(Boolean);
  const stillNeeded = ['approved', 'sent', 'draft', 'rehook'].includes(d.status) || d.x_status === 'pending';
  if (stillNeeded) files.forEach((x) => keep.add(x));
}
for (const x of ['media/official']) keep.add(x); // official art kit
try { for (const it of JSON.parse(readFileSync(join(ROOT, 'state', 'comp_pool.json'), 'utf8'))) if (!it.used) keep.add(it.file); } catch {}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
let freed = 0, count = 0;
const media = join(ROOT, 'media');
if (existsSync(media)) for (const p of walk(media)) {
  const rel = relative(ROOT, p);
  if (keep.has(rel) || rel.startsWith('media/official')) continue;
  if (keep.has(rel.replace(/_x10\.mp4$|_x\.mp4$/, '.mp4'))) continue;
  const st = statSync(p);
  if (st.mtimeMs > cutoff) continue;
  rmSync(p, { force: true }); freed += st.size; count++;
}
console.log(`[${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}] cleanup: deleted ${count} file(s), freed ${(freed / 1e9).toFixed(2)} GB (kept clips not yet posted)`);
