#!/usr/bin/env node
// Telegram approvals for GTA6 Archives HQ. Nothing gets posted without a ✅.
//
//   node tools/approve.mjs send <draft-id>   send drafts/<id>.json (+ media) to Telegram with ✅/❌
//   node tools/approve.mjs poll              read taps, update each draft's status
//   node tools/approve.mjs list              show drafts and their status
//
// Draft file (drafts/<id>.json):
//   { "id": "L1", "platforms": ["x","instagram","tiktok","youtube"],
//     "captions": { "x": "...", "instagram": "...", "tiktok": "...", "youtube": "..." },
//     "media": "media/edits/clip.mp4",          // optional: .mp4 / .jpg / .png
//     "notes": "why this post, source links" }
// Replying to the bot with "edit <id>: new text" stores the new X caption and marks the draft "edited".

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRAFTS = join(ROOT, 'drafts');
import { env } from './lib/env.mjs';
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const CHAT = env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
const API = `https://api.telegram.org/bot${TOKEN}`;

// Retries network failures and 5xx (flaky DNS / Telegram gateway); Telegram's own 4xx errors fail at once.
async function call(method, body, attempts = 5) {
  const isForm = body instanceof FormData;
  for (let i = 1; ; i++) {
    let res, data;
    try {
      res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      data = await res.json().catch(() => null);
    } catch (e) {
      if (i >= attempts) throw new Error(`Telegram ${method} unreachable after ${i} tries: ${e.cause?.code ?? e.message}`);
      await new Promise((r) => setTimeout(r, 5000 * i));
      continue;
    }
    if (data?.ok) return data.result;
    if (res.status >= 500 && i < attempts) { await new Promise((r) => setTimeout(r, 5000 * i)); continue; }
    throw new Error(`Telegram ${method} failed: ${data?.description ?? res.status}`);
  }
}

const draftPath = (id) => join(DRAFTS, `${id}.json`);
const load = (id) => JSON.parse(readFileSync(draftPath(id), 'utf8'));
const save = (d) => writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2) + '\n');
const stamp = () => new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' WAT';

const STATE = join(ROOT, 'state');
function control(cmd) {
  mkdirSync(STATE, { recursive: true });
  if (cmd === 'pause') { writeFileSync(join(STATE, 'paused'), stamp()); return '⏸ Paused: nothing will be published until /resume.'; }
  if (cmd === 'resume') { rmSync(join(STATE, 'paused'), { force: true }); return '▶️ Resumed: approved posts will publish.'; }
  if (cmd === 'clip') { writeFileSync(join(STATE, 'clip_request'), stamp()); return '🎬 Clip request saved. Your Mac picks it up on its next check (within ~15 min while it is on).'; }
  const ds = readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DRAFTS, f), 'utf8')));
  const by = (st) => ds.filter((d) => d.status === st).map((d) => d.id).join(', ') || '—';
  const xq = ds.filter((d) => d.x_status === 'pending').map((d) => d.id).join(', ') || '—';
  return [existsSync(join(STATE, 'paused')) ? '⏸ Publishing PAUSED' : '▶️ Publishing active',
    `Waiting for your ✅: ${by('sent')}`, `Approved, publishing next: ${by('approved')}`, `Re-render queued: ${by('rehook')}`,
    `X posts waiting for Claude + you: ${xq}`].join('\n');
}

function preview(d) {
  const lines = [`📝 ${d.id} → ${d.platforms.join(', ')}`];
  const seen = new Set();
  for (const [p, text] of Object.entries(d.captions)) {
    if (seen.has(text)) { lines.push(`\n[${p}] same as above`); continue; }
    seen.add(text);
    lines.push(`\n[${p}]\n${text}`);
  }
  if (d.notes) lines.push(`\nℹ️ ${d.notes}`);
  return lines.join('\n');
}

async function send(id) {
  const d = load(id);
  const buttons = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `gta:ok:${id}` }, { text: '❌ Reject', callback_data: `gta:no:${id}` }]] };
  const text = preview(d);
  let msg;
  if (d.media) {
    const file = join(ROOT, d.media);
    const isVideo = ['.mp4', '.mov'].includes(extname(file).toLowerCase());
    const form = new FormData();
    form.append('chat_id', String(CHAT));
    // Local file when on the Mac; otherwise the public Supabase link (GitHub Actions has no media files).
    if (existsSync(file)) form.append(isVideo ? 'video' : 'photo', new Blob([readFileSync(file)]), basename(file));
    else if (d.media_url) form.append(isVideo ? 'video' : 'photo', d.media_url);
    else throw new Error(`Media not found: ${d.media}`);
    form.append('caption', text.slice(0, 1024));
    form.append('reply_markup', JSON.stringify(buttons));
    msg = await call(isVideo ? 'sendVideo' : 'sendPhoto', form);
    if (text.length > 1024) await call('sendMessage', { chat_id: CHAT, text: `(full text for ${id})\n${text}` });
  } else {
    msg = await call('sendMessage', { chat_id: CHAT, text, reply_markup: buttons, link_preview_options: { is_disabled: true } });
  }
  Object.assign(d, { status: 'sent', sent_at: stamp(), message_id: msg.message_id });
  save(d);
  console.log(`sent ${id} (message ${msg.message_id})`);
}

async function poll() {
  const updates = await call('getUpdates', { timeout: 0, limit: 100 });
  let last = 0;
  for (const u of updates) {
    last = Math.max(last, u.update_id);
    const q = u.callback_query;
    if (q && String(q.message?.chat?.id) === String(CHAT) && q.data?.startsWith('gta:')) {
      const [, verdict, id] = q.data.split(':');
      if (!existsSync(draftPath(id))) continue;
      const d = load(id);
      d.status = verdict === 'ok' ? 'approved' : 'rejected';
      d.decided_at = stamp();
      save(d);
      const note = verdict === 'ok' ? '✅ Approved — posting next' : '❌ Rejected';
      await call('answerCallbackQuery', { callback_query_id: q.id, text: note }).catch(() => {});
      await call('editMessageReplyMarkup', { chat_id: CHAT, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'gta:done' }]] } }).catch(() => {});
      console.log(`${id}: ${d.status}`);
    }
    const m = u.message;
    // Phone controls: /status /pause /resume /clip, and "hook <id>: NEW HOOK" to re-render a clip's on-screen hook.
    const mine = m && String(m.chat?.id) === String(CHAT);
    const cmd = mine && m.text?.trim().match(/^\/(status|pause|resume|clip)\b/i)?.[1].toLowerCase();
    if (cmd) {
      await call('sendMessage', { chat_id: CHAT, text: control(cmd).slice(0, 3900) });
      continue;
    }
    const hook = mine && m.text?.match(/^hook\s+(\S+):\s*([\s\S]+)/i);
    if (hook && existsSync(draftPath(hook[1]))) {
      const d = load(hook[1]);
      Object.assign(d, { hook_request: hook[2].trim(), status: 'rehook' });
      save(d);
      await call('sendMessage', { chat_id: CHAT, text: `🎬 ${d.id}: new hook saved. Your Mac re-renders it on its next run (every 2 h, or sooner after /clip) and sends it back for ✅.` });
      continue;
    }
    const edit = m && String(m.chat?.id) === String(CHAT) && m.text?.match(/^edit\s+(\S+):\s*([\s\S]+)/i);
    if (edit && existsSync(draftPath(edit[1]))) {
      const d = load(edit[1]);
      d.captions.x = edit[2].trim();
      d.status = 'edited';
      save(d);
      await call('sendMessage', { chat_id: CHAT, text: `✏️ ${d.id} updated. Re-sending for approval.` });
      await send(d.id);
    }
  }
  // Confirm everything read so taps aren't processed twice.
  if (last) await call('getUpdates', { offset: last + 1, limit: 1, timeout: 0 });
  if (!updates.length) console.log('no new taps');
}

function list() {
  for (const f of readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(join(DRAFTS, f), 'utf8'));
    console.log(`${d.id.padEnd(8)} ${(d.status ?? 'draft').padEnd(9)} ${d.platforms.join(',').padEnd(28)} ${(d.captions.x ?? Object.values(d.captions)[0]).split('\n')[0]}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'send' && arg) await send(arg);
else if (cmd === 'poll') await poll();
else if (cmd === 'list') list();
else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'));
