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
- Approvals: Telegram (✅/❌ on each draft). Week 1 (until 2026-11-25): **everything** needs approval.
  After that: only unusual posts, rumors, or anything that could read as official.
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
