// Free Google Gemini (AI Studio key) watches each clip: safety, quality, best trim, facecam box, hook and caption.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { env } from './env.mjs';

const API = 'https://generativelanguage.googleapis.com';
const key = () => { if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing'); return env.GEMINI_API_KEY; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free models to try in order; when one is overloaded (503) or rate-limited (429) the next one is used.
const PREFERRED = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'];
let MODELS;
async function models() {
  if (MODELS) return MODELS;
  if (env.GEMINI_MODEL) return (MODELS = [env.GEMINI_MODEL]);
  const res = await (await fetch(`${API}/v1beta/models?pageSize=200&key=${key()}`)).json();
  const have = new Set((res.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace('models/', '')));
  MODELS = PREFERRED.filter((m) => have.has(m));
  if (!MODELS.length) MODELS = ['gemini-2.5-flash'];
  return MODELS;
}

async function uploadVideo(path) {
  const size = statSync(path).size;
  const start = await fetch(`${API}/upload/v1beta/files?key=${key()}`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': 'video/mp4', 'content-type': 'application/json' },
    body: JSON.stringify({ file: { display_name: basename(path) } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new Error(`Gemini upload start failed: ${start.status} ${(await start.text()).slice(0, 200)}`);
  const up = await (await fetch(url, { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'content-length': String(size) }, body: readFileSync(path) })).json();
  let file = up.file;
  for (let i = 0; i < 60 && file?.state === 'PROCESSING'; i++) { await sleep(3000); file = await (await fetch(`${API}/v1beta/${file.name}?key=${key()}`)).json(); }
  if (file?.state !== 'ACTIVE') throw new Error(`Gemini file not ready: ${file?.state ?? JSON.stringify(up).slice(0, 200)}`);
  return file;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    keep: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
    quality: { type: 'INTEGER' },
    reject_reasons: { type: 'ARRAY', items: { type: 'STRING', enum: ['sexual_or_nudity', 'story_spoiler', 'slur_or_hate', 'real_world_violence', 'leak_or_exploit', 'no_gameplay_just_talking', 'boring', 'blurry_or_low_quality', 'menus_or_loading', 'incomplete_moment', 'not_gta6'] } },
    what_happens: { type: 'STRING' },
    facecam_box: { type: 'OBJECT', nullable: true, properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, w: { type: 'NUMBER' }, h: { type: 'NUMBER' } } },
    trim_start: { type: 'NUMBER' },
    trim_end: { type: 'NUMBER' },
    hook: { type: 'STRING' },
    on_screen_caption: { type: 'STRING' },
    post_caption: { type: 'STRING' },
  },
  required: ['keep', 'confidence', 'quality', 'reject_reasons', 'what_happens', 'trim_start', 'trim_end', 'hook', 'on_screen_caption', 'post_caption'],
};

/** Watches a clip and returns the verdict JSON described in SCHEMA. ctx: { who, kind, title, duration, layout } */
export async function judgeClip(path, ctx) {
  const file = await uploadVideo(path);
  const prompt = `You review clips for "GTA6 Archives HQ", a faceless GTA 6 fan page posting 9:16 shorts on TikTok, Instagram Reels, YouTube Shorts and X.
Clip: ${ctx.kind} by ${ctx.who}. Original title: "${ctx.title}". Length ${Math.round(ctx.duration)} s. Source frame is ${ctx.layout}.

Facts: GTA 6 (Grand Theft Auto VI) was RELEASED on 19 November 2026 on PS5 and Xbox Series X|S and people are playing it now. Never call it upcoming or unreleased. ${ctx.kind.includes('Twitch') ? 'Twitch has already confirmed this clip is from GTA 6.' : ''}

Decide if this makes a strong, safe short for a worldwide GTA 6 audience, and prepare it:
- keep=false if it shows OR SAYS sexual content (nudity, strip clubs, close-ups of bodies, lap dances, crude sexual words or jokes in speech or on screen), major story spoilers (story cutscenes, character deaths, endings), slurs, real-world violence, leaks/exploits/glitches, is not GTA 6, is mostly menus/loading, blurry, or is just someone talking with no interesting gameplay or reaction.
- quality 1-10: how likely viewers stop scrolling and watch to the end (funny reaction, wild chase, crash, hidden detail, impressive graphics, useful tip). 7+ means a strong post.
- trim_start/trim_end (seconds, within the clip): the most complete moment, 8-45 s: start at the setup, end right after the payoff. Never cut mid-sentence or mid-action.
- facecam_box: only if a streamer's webcam is visible inside a landscape frame, give its box as fractions of the frame (x,y,w,h). Otherwise null.
- hook: the on-screen caption, written like a native TikTok caption: sentence case (NOT all caps), 35-60 characters, NO emoji, relatable and curiosity-driven, e.g. "These GTA 6 cops have me on my best behaviour", "Ludwig said he was the best driver and then this happened". Must be true to the clip.
- on_screen_caption: max 32 characters, NO emoji, adds context or a punchline, sentence case.
- post_caption: 1-2 short punchy sentences (max 140 characters) with exactly one emoji, written for a worldwide audience, ${ctx.who !== 'unknown' ? `naming ${ctx.who}` : ''}. No hashtags, no @handles, no links, no countries or cities, never claim it is official Rockstar news, no invented facts.
- what_happens: one plain sentence describing the clip.
Be strict: when unsure about safety, set keep=false or confidence below 0.6.`;
  const body = { contents: [{ parts: [{ file_data: { mime_type: 'video/mp4', file_uri: file.uri } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.6 } };
  let lastErr = '';
  for (const m of await models()) {
    for (let i = 1; i <= 2; i++) {
      const res = await fetch(`${API}/v1beta/models/${m}:generateContent?key=${key()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        fetch(`${API}/v1beta/${file.name}?key=${key()}`, { method: 'DELETE' }).catch(() => {});
        const v = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
        v.model = m;
        return v;
      }
      lastErr = `${m} ${res.status}: ${data.error?.message ?? ''}`.slice(0, 200);
      if (res.status === 503 || res.status === 429 || res.status >= 500) { await sleep(8000 * i); continue; } // busy: retry once, then next model
      break; // other errors (e.g. model can't read video): try next model
    }
  }
  throw new Error(`all Gemini models failed — last: ${lastErr}`);
}

/** Turns a verdict into an action: 'discard' | 'auto' | 'review' (send to Telegram) */
export function decide(v) {
  const hard = ['sexual_or_nudity', 'slur_or_hate', 'real_world_violence', 'leak_or_exploit'];
  if (!v || v.reject_reasons?.some((r) => hard.includes(r))) return { action: 'discard', why: (v?.reject_reasons ?? ['no verdict']).join(', ') };
  if (!v.keep || v.quality < 5) return { action: 'discard', why: `weak clip (quality ${v.quality}${v.reject_reasons?.length ? `, ${v.reject_reasons.join(', ')}` : ''})` };
  if (v.quality >= 7 && v.confidence >= 0.7 && !v.reject_reasons?.length) return { action: 'auto', why: `quality ${v.quality}/10` };
  return { action: 'review', why: `quality ${v.quality}/10, confidence ${v.confidence}${v.reject_reasons?.length ? `, ${v.reject_reasons.join(', ')}` : ''}` };
}
