# GTA6 Archives HQ — Playbook

## Identity
- Handle: **@gta6archiveshq** (same on every platform)
- Display name: **GTA6 Archives HQ**
- Platforms: X, Instagram (Professional/Creator), TikTok, YouTube Shorts (YouTube handle is **@gta6archiveshq1**; gta6archiveshq was unavailable there)
- Bio: `GTA 6 news, tips, hidden spots & the best clips, credited 🌴 Fan page. Not affiliated with Rockstar Games.`
- Audience: WORLDWIDE. Never mention Nigeria, West Africa, Lagos or WAT in any post text (owner rule, 2026-11-18).
- Voice: hype but clean. Short, punchy, sentence case. One emoji max (🌴 ⏳ 👀 🎥). Write "GTA 6". Text-only (no voiceover) for now.
- Niche: mixed — fast news, tips & hidden spots, funny moments, cars & customization.

## Owner
- Time zone: **WAT (Africa/Lagos, UTC+1)**. All schedule times below are WAT.
- Approval windows: **07:00 morning** and **evening**.
- Approvals (owner rule changed 2026-11-20): **auto-approve everything**; only posts flagged by tools/lib/risk.mjs (leaks, exploits, sexual content, spoilers, slurs, sensitive topics, official/rumor wording, unverified search creators, mission guides) go to Telegram for ✅/❌. Approving a flagged creator once trusts that channel (state/trusted.json).
- Never pay, upgrade, or add a card without asking.

## Tools
- Scheduler: Buffer **free plan** (3 channels, 10 queued posts per channel). Channels: Instagram, TikTok, YouTube.
  X is posted directly on x.com (fastest; free plan has no 4th slot).
- Editing: `tools/clip.sh` (ffmpeg, free). Owner prefers FULL-SCREEN clips (no blurred bands); text at top. FOCUS=0..1 to aim the crop. CapCut (free) for manual edits.
- Storage: this folder; finished clips also go to the public Supabase bucket `clips` (Buffer API needs public media URLs).
- Posting: `node tools/approve.mjs send <id>` → Telegram ✅ → `node tools/approve.mjs poll` → `node tools/publish.mjs <id> --now|--at <ISO>` (IG/TikTok/YouTube via Buffer API). X via Chrome/X scheduler.

## Daily mix
X (4–6/day, WAT):
1. 07:30 official news recap
2. 10:00 HOW TO tip
3. 13:00 gameplay clip
4. 16:00 nostalgia, one-liner or question
5. 18:30 spotlight or second clip
6. 21:00 daily recap ("Day X in Leonida")

Instagram 1–2/day, TikTok + Shorts 1–3/day: 11:00 and 18:00 WAT to start; let the scoreboard move them.
Quality beats volume. Skip a slot rather than post something weak or unverified.

## Pillar: Streamer moments (HIGH PRIORITY, owner request 2026-11-19)
- Clips of popular streamers playing GTA 6: funny reactions, wild moments, first impressions. Gameplay + streamer reaction is fine (webcam may stay in frame).
- TAG the streamer's own account on every platform (X @handle, TikTok @handle, IG @handle, YouTube @handle). Handles must be verified from the streamer's own channel/profile links and stored in streamers.md before use; never guess a handle.
- Source: the streamer's own VOD/clips/YouTube uploads (not re-uploaders). Short (7-30s), transformed (hook, captions, our framing). Takedown request = remove same day.
- No story spoilers in hook/thumbnail; label "SPOILER" if a story moment.

## Rules (short form — full prompt sections 5, 7, 14)
- Public posts only. Credit every clip on its own line: `🎥 @creator`. Official: `🎥 @RockstarGames`.
- Transform every clip: hook, tight trim, captions, our framing. No plain reposts.
- No leaks, piracy, exploits, "play early" tricks, rumors (unless approved and labelled RUMOR:).
- Every fact in facts.md with a source link. No AI-made "gameplay".
- Never imply we are Rockstar. Takedown requests: remove same day, log in takedowns.md.
- Mark story spoilers "SPOILER" in caption; never in hook or thumbnail.

## Automation (no AI)
- GitHub Actions (private repo, runs with the Mac off): `tick` every 30 min = Telegram taps/commands → publish approved drafts via Buffer at their slot → official news watch (PlayStation Blog, Xbox Wire). `report` daily 21:00 WAT = Buffer metrics → scoreboard + Telegram.
- Mac launchd `com.gta6archiveshq.clipper` (every 15 min; YouTube scan every 2 h): channels.json → "Most replayed" peak → full-screen clip with template hook → Supabase → Telegram. Re-renders on "hook <id>: TEXT".
- X: never automatic. Drafts get x_status "pending"; Claude asks the owner in a session and posts in Chrome.
- Control: `gta6 start|stop|status|clip|logs|cloud|pause|resume`, or Telegram /status /pause /resume /clip.

## Clip quality system (2026-11-21 redesign)
- Free Gemini watches every clip (tools/lib/gemini.mjs): drops sexual/hateful/leak content and weak clips (<5/10), auto-approves 7+/10 with no doubts, sends the rest to Telegram. It also picks the complete moment, finds the streamer webcam, and writes hook + on-screen caption + post caption.
- Layouts: Twitch portrait clip as is (camera on top) > camera stacked over gameplay > full-screen gameplay. Fades in/out.
- Hourly slots 08:00–23:00 WAT. Daily caps: TikTok 15, Instagram 5, YouTube 8 (channel verified 2026-11-21) (best-scored clips get IG/YouTube). Clips go to Buffer ~1 h before their slot (free plan queue = 10).

## 2026-11-22 owner changes
- Text: white with thick black outline, no box, in the middle band (on the camera/game seam), never over faces or the main action.
- Streamer clips: camera ~30% top, game ~70% (not Twitch's 50/50 portrait). Best source quality, original frame rate, whole Twitch clip.
- Instagram and TikTok: one video per hour (08:00–23:00). YouTube Shorts get the best engagement (top 3: C5 1.7K, S14 1.5K, S15 1.2K views): give YouTube the strongest clips (quality 8+).
- New source: viral X / Instagram / TikTok posts with good engagement (state/link_queue.json; Telegram "add <url>"), credited to the original creator.

## 2026-11-24 owner decision: no straight reposts
- TikTok/Instagram gave 0 views to single reposts of other creators' viral videos ("not eligible for recommendation": unoriginal).
- Viral links (X/IG/TikTok, Telegram "add <url> [credit @creator]") now go to a compilation pool (best 6-8 s each, Gemini-checked).
- Mon/Wed/Fri: tools/compile.mjs builds "5 GTA 6 moments you missed this week" (#5..#1, captions + per-segment credit, all creators credited in the caption).
