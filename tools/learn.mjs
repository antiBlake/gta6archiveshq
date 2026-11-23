#!/usr/bin/env node
// Learning loop (runs nightly on GitHub, after the report).
// 1. Collects engagement for every post (Buffer metrics for TikTok/Instagram/YouTube-via-Buffer, YouTube API for direct uploads).
// 2. Scores each post against the median post on the same platform (so platforms are comparable).
// 3. Learns which groups beat the median: streamer, source type, length, posting hour, hook style.
// 4. Writes state/learning.json, used by the clippers/publisher, and a lessons block in learning.md.
//    Groups need >= 3 posts before they count (shrunk toward 1.0 until then) so one lucky post can't swing it.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, env } from './lib/env.mjs';
import { youtubeReady, accessToken } from './youtube.mjs';

const DRAFTS = join(ROOT, 'drafts');
const drafts = readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DRAFTS, f), 'utf8')));
const gql = async (query, variables) => (await (await fetch('https://api.buffer.com', { method: 'POST', headers: { authorization: `Bearer ${env.BUFFER_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60_000) })).json());

// ---------- 1. collect ----------
const posts = [];
let ytToken = null;
if (youtubeReady()) { try { ytToken = await accessToken(); } catch {} }
for (const d of drafts) {
  if (['pulled', 'superseded', 'rejected'].includes(d.status)) continue;
  for (const [platform, b] of Object.entries(d.buffer ?? {})) {
    let m = null, sentAt = null;
    try {
      if (b.videoId && ytToken) {
        const r = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${b.videoId}`, { headers: { authorization: `Bearer ${ytToken}` } })).json();
        const st = r.items?.[0]?.statistics; sentAt = r.items?.[0]?.snippet?.publishedAt;
        if (st) m = { views: +st.viewCount || 0, likes: +st.likeCount || 0, comments: +st.commentCount || 0, shares: 0 };
      } else if (b.id && !b.deleted) {
        const p = (await gql(`query($id: PostId!) { post(input:{id:$id}) { status sentAt metrics { type value } } }`, { id: b.id })).data?.post;
        if (p?.status === 'sent') { sentAt = p.sentAt; const x = Object.fromEntries((p.metrics ?? []).map((k) => [k.type, k.value])); m = { views: x.views ?? x.impressions ?? x.reach ?? 0, likes: x.reactions ?? x.likes ?? 0, comments: x.comments ?? 0, shares: x.shares ?? 0, avgWatch: x.averageTimeWatched ?? null }; }
      }
    } catch {}
    if (!m || !sentAt) continue;
    const ageH = (Date.now() - new Date(sentAt)) / 3600_000;
    if (ageH < 12) continue; // too fresh to judge
    const hook = d.hook ?? '';
    posts.push({
      id: d.id, platform, ...m, ageH, sentAt,
      engagement: m.views + 20 * m.likes + 40 * (m.comments + m.shares),
      streamer: d.category === 'streamer' ? d.credit : null,
      source: d.category ?? (d.id[0] === 'S' ? 'streamer' : d.id[0] === 'T' ? 'guide' : d.id[0] === 'V' ? 'viral' : 'creator'),
      length: d.source?.end ? Math.round(d.source.end - (d.source.start ?? 0)) : null,
      hour: new Date(new Date(sentAt).getTime() + 3600_000).getUTCHours(), // WAT
      hookStyle: /then this happened|right before|until|when/i.test(hook) ? 'setup-payoff' : /\?$/.test(hook) ? 'question' : /^how to|tip|secret|free|easy/i.test(hook) ? 'tip' : hook === hook.toUpperCase() ? 'all-caps' : 'statement',
      hook,
    });
  }
}

// ---------- 2. score vs platform median ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const medByPlatform = {};
for (const p of new Set(posts.map((x) => x.platform))) medByPlatform[p] = Math.max(1, median(posts.filter((x) => x.platform === p).map((x) => x.engagement)));
for (const p of posts) p.score = p.engagement / medByPlatform[p.platform];

// ---------- 3. learn group multipliers ----------
const MIN_N = 3;
function groups(key) {
  const g = {};
  for (const p of posts) { const k = typeof key === 'function' ? key(p) : p[key]; if (k == null) continue; (g[k] ??= []).push(p.score); }
  return Object.fromEntries(Object.entries(g).map(([k, s]) => {
    const n = s.length, raw = median(s);
    const w = (n / (n + MIN_N)) * raw + (MIN_N / (n + MIN_N)) * 1; // shrink toward 1 when few posts
    return [k, { n, score: +w.toFixed(2) }];
  }));
}
const learning = {
  updated: new Date().toISOString(),
  posts: posts.length,
  platforms: Object.fromEntries(Object.entries(medByPlatform).map(([k, v]) => [k, { median_engagement: Math.round(v), posts: posts.filter((p) => p.platform === k).length }])),
  streamer: groups('streamer'),
  source: groups('source'),
  hookStyle: groups('hookStyle'),
  length: groups((p) => (p.length == null ? null : p.length <= 20 ? '≤20s' : p.length <= 35 ? '21-35s' : p.length <= 50 ? '36-50s' : '>50s')),
  hour: groups('hour'),
  best_hooks: [...posts].sort((a, b) => b.score - a.score).filter((p, i, a) => p.hook && a.findIndex((q) => q.hook === p.hook) === i).slice(0, 5).map((p) => ({ hook: p.hook, platform: p.platform, views: p.views, score: +p.score.toFixed(1) })),
};
writeFileSync(join(ROOT, 'state', 'learning.json'), JSON.stringify(learning, null, 2));

// ---------- 4. lessons ----------
const fmt = (g) => Object.entries(g).filter(([, v]) => v.n >= MIN_N).sort((a, b) => b[1].score - a[1].score).map(([k, v]) => `${k} ${v.score}× (${v.n})`).join(', ') || 'not enough posts yet';
const lessons = [
  `### ${new Date().toISOString().slice(0, 10)} — ${posts.length} posts scored`,
  `- Streamers: ${fmt(learning.streamer)}`,
  `- Source types: ${fmt(learning.source)}`,
  `- Hook styles: ${fmt(learning.hookStyle)}`,
  `- Length: ${fmt(learning.length)}`,
  `- Best hours (WAT): ${fmt(learning.hour)}`,
  `- Top hooks: ${learning.best_hooks.map((h) => `"${h.hook}" (${h.platform} ${h.views} views)`).join('; ')}`,
].join('\n');
const lf = join(ROOT, 'learning.md');
writeFileSync(lf, (existsSync(lf) ? readFileSync(lf, 'utf8') : '# Learning\n') + `\n${lessons}\n`);
console.log(lessons);
if (process.argv.includes('--telegram') && env.TELEGRAM_BOT_TOKEN) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `🧠 What's working (vs your typical post)\n${lessons.split('\n').slice(1).join('\n')}`.slice(0, 3900) }) }).catch(() => {});
}
