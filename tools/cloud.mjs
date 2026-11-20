#!/usr/bin/env node
// Runs on GitHub Actions (no AI, no laptop needed).
//   node tools/cloud.mjs tick     every 30 min: Telegram taps/commands → publish approved via Buffer → official news check
//   node tools/cloud.mjs report   every evening: Buffer metrics → scoreboard.csv + Telegram summary
// Never posts anything you haven't approved. X posts are queued (x_status: pending) for Claude to post with you.

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { env, ROOT } from './lib/env.mjs';

const DRAFTS = join(ROOT, 'drafts');
const STATE = join(ROOT, 'state');
mkdirSync(STATE, { recursive: true });
const wat = () => new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
const log = (m) => console.log(`[${wat()}] ${m}`);
const drafts = () => readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DRAFTS, f), 'utf8')));
const saveDraft = (d) => writeFileSync(join(DRAFTS, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n');
const node = (args) => execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 600_000 }).trim();

async function telegram(text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3900), link_preview_options: { is_disabled: true } }),
  }).catch((e) => log(`telegram failed: ${e.message}`));
}

async function buffer(query, variables) {
  const res = await fetch('https://api.buffer.com', {
    method: 'POST', headers: { authorization: `Bearer ${env.BUFFER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data;
}

// ---------- publish approved drafts ----------
function publishApproved() {
  if (existsSync(join(STATE, 'paused'))) return log('paused: not publishing');
  for (const d of drafts().filter((x) => x.status === 'approved')) {
    const buf = d.platforms.filter((p) => p !== 'x');
    if (!buf.length) { // X-only post (e.g. news): queue for Claude + owner
      Object.assign(d, { status: 'queued_x', x_status: 'pending' }); saveDraft(d);
      log(`${d.id}: X-only, queued`); continue;
    }
    const slot = d.slot ? new Date(d.slot) : null;
    const when = slot && slot > new Date(Date.now() + 5 * 60_000) ? ['--at', d.slot] : ['--now'];
    try {
      log(node(['tools/publish.mjs', d.id, ...when]));
      const after = JSON.parse(readFileSync(join(DRAFTS, `${d.id}.json`), 'utf8'));
      const failed = Object.entries(after.buffer ?? {}).filter(([, v]) => v.error);
      after.status = failed.length ? 'publish_error' : 'published_buffer';
      saveDraft(after);
      appendFileSync(join(ROOT, 'log.md'), `| ${wat()} | ${when[0] === '--at' ? d.slot : 'now'} | ${buf.join('+')} (GitHub) | ${(d.captions.x ?? '').split('\n')[0]} | ${d.media_url ?? ''} | ${d.credit ?? ''} | ${failed.length ? 'ERROR' : 'ok'} |\n`);
      telegram(failed.length ? `⚠️ ${d.id} failed: ${failed.map(([s, v]) => `${s}: ${v.error}`).join('; ')}`
        : `🚀 ${d.id} ${when[0] === '--at' ? `scheduled for ${new Date(d.slot).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}` : 'published'} on ${buf.join(', ')}.${d.platforms.includes('x') ? ' X version queued: Claude will ask you before posting it.' : ''}`);
    } catch (e) { log(`publish ${d.id} failed: ${e.message.split('\n')[0]}`); }
  }
}

// ---------- official news watch ----------
const FEEDS = [
  ['PlayStation Blog', 'https://blog.playstation.com/feed/'],
  ['Xbox Wire', 'https://news.xbox.com/en-us/feed/'],
];
async function newsWatch() {
  const seenFile = join(STATE, 'news_seen.json');
  const seen = new Set(existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : []);
  const first = seen.size === 0;
  let n = drafts().filter((d) => /^N\d+$/.test(d.id)).length;
  for (const [source, url] of FEEDS) {
    let xml = '';
    try { xml = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).text(); } catch (e) { log(`${source} feed failed: ${e.message}`); continue; }
    for (const item of xml.split('<item>').slice(1, 30)) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? '').replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
      if (!link || seen.has(link)) continue;
      seen.add(link);
      if (first || !/\bGTA\b|Grand Theft Auto/i.test(title)) continue; // first run only remembers the backlog
      const d = { id: `N${++n}`, platforms: ['x'], status: 'draft', credit: source,
        captions: { x: `GTA 6 news: ${title}\n\nSource: ${source} 🔗 ${link}` },
        notes: `Official source (${source}). Check the article before approving. ${link}` };
      saveDraft(d);
      try { log(node(['tools/approve.mjs', 'send', d.id])); } catch (e) { log(`send ${d.id} failed: ${e.message.split('\n')[0]}`); }
    }
  }
  writeFileSync(seenFile, JSON.stringify([...seen].slice(-500)));
}

// ---------- evening report ----------
async function report() {
  const rows = [];
  for (const d of drafts()) for (const [service, b] of Object.entries(d.buffer ?? {})) {
    if (!b.id) continue;
    try {
      const p = (await buffer(`query($id: PostId!) { post(input:{id:$id}) { status sentAt externalLink metrics { name type value } } }`, { id: b.id })).post;
      if (!p || p.status !== 'sent') continue;
      const m = Object.fromEntries((p.metrics ?? []).map((x) => [x.type ?? x.name, x.value]));
      rows.push({ id: d.id, service, link: p.externalLink, m });
      appendFileSync(join(ROOT, 'scoreboard.csv'), `${d.id}-${service},${new Date().toISOString().slice(0, 10)},snapshot,${service},,,,,${d.credit ?? ''},${m.views ?? m.impressions ?? ''},,,${m.likes ?? m.reactions ?? ''},${m.shares ?? ''},${m.comments ?? ''},${m.saves ?? ''},,,"${JSON.stringify(m).replace(/"/g, "'")}"\n`);
    } catch (e) { log(`metrics ${d.id}/${service}: ${e.message}`); }
  }
  const views = (r) => r.m.views ?? r.m.impressions ?? r.m.reach ?? 0;
  rows.sort((a, b) => views(b) - views(a));
  const lines = rows.slice(0, 8).map((r) => `${r.id} ${r.service}: ${Math.round(views(r))} views, ${Math.round(r.m.likes ?? r.m.reactions ?? 0)} likes`);
  const pendingX = drafts().filter((d) => d.x_status === 'pending').map((d) => d.id);
  await telegram([`📊 Daily report (${wat()})`, ...(lines.length ? lines : ['No metrics yet.']), '', `X posts waiting for you + Claude: ${pendingX.join(', ') || 'none'}`].join('\n'));
}

// ---------- Mac watchdog: tell the owner when the clipper has gone quiet ----------
async function macWatchdog() {
  const f = join(STATE, 'last_alive'), sent = join(STATE, 'watchdog_sent');
  if (!existsSync(f)) return;
  const quietH = (Date.now() - new Date(readFileSync(f, 'utf8'))) / 3600_000;
  const lastSent = existsSync(sent) ? new Date(readFileSync(sent, 'utf8')) : new Date(0);
  if (quietH > 4 && Date.now() - lastSent > 8 * 3600_000) {
    await telegram(`💤 Your Mac clipper hasn't been online for ${Math.round(quietH)} h, so no new clips are being made. Wake the Mac, keep it plugged in and turn the VPN on. (Approved posts still publish from GitHub.)`);
    writeFileSync(sent, new Date().toISOString());
  }
}

const mode = process.argv[2] ?? 'tick';
if (mode === 'tick') {
  try { log(node(['tools/approve.mjs', 'poll'])); } catch (e) { log(`poll failed: ${e.message.split('\n')[0]}`); }
  publishApproved();
  await newsWatch();
  await macWatchdog();
} else if (mode === 'report') await report();
log('done');
