#!/usr/bin/env bash
# Turns a source clip into a 1080x1920 vertical post:
#   the clip cropped to fill the 9:16 frame (LAYOUT=full, default; FOCUS=0..1 picks the horizontal area),
#   hook text at the top, optional caption lines under the video, credit at the bottom.
#
# Usage:
#   tools/clip.sh <input> <start> <end> "<HOOK TEXT>" "<@credit>" [output] ["caption line"]
#   tools/clip.sh media/raw/nz_drive.mp4 00:01:12 00:01:31 "THE FIRST DRIVE IN VICE CITY 🌴" "@somecreator"
#
# Output defaults to media/edits/<input-name>_<start>.mp4 (H.264 + AAC, 1080x1920, 30fps).
set -euo pipefail
export PATH="$(cd "$(dirname "$0")" && pwd)/bin:$PATH"

if [ $# -lt 5 ]; then
  sed -n '2,11p' "$0"; exit 1
fi

IN=$1; START=$2; END=$3; HOOK=$4; CREDIT=$5
BASE=$(basename "${IN%.*}")
OUT=${6:-media/edits/${BASE}_${START//:/}.mp4}
CAPTION=${7:-}

FONTS="$(cd "$(dirname "$0")" && pwd)/fonts"
FONT_BOLD="$FONTS/TikTokSans-SemiBold.ttf"   # TikTok's own caption font (OFL), semi-bold
FONT="$FONTS/TikTokSans-Medium.ttf"

# Text goes through files so quotes, colons and emoji never break the filter.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# ffmpeg can't draw colour emoji, so strip them from burned-in text (keep them in the post caption).
noemoji() { perl -CSD -pe 's/[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}\x{FE0F}\x{200D}]//g; s/ +$//; s/^ +//'; }
printf '%s' "$HOOK" | noemoji | fold -s -w 28 > "$TMP/hook.txt"
printf 'via %s' "$CREDIT" | noemoji > "$TMP/credit.txt"
printf '%s' "$CAPTION" | noemoji | fold -s -w 30 > "$TMP/caption.txt"

# LAYOUT=full (default): the clip fills the whole 9:16 frame (crop of the landscape source).
#   FOCUS=0..1 picks which part of the width to keep (0 = left edge, 0.5 = centre, 1 = right edge).
# LAYOUT=blur: the older look (whole landscape clip in the middle, blurred copy above and below).
# LAYOUT=portrait: source is already vertical (Twitch portrait clip: streamer camera on top) — fill the frame as is.
# LAYOUT=stack: CAM="x,y,w,h" (0..1 of the frame) is the streamer's camera box; camera goes on top (40%),
#   gameplay fills the bottom (60%), hook sits on the seam so it never covers a face.
LAYOUT=${LAYOUT:-full}
FOCUS=${FOCUS:-0.5}
DUR_IN=$(awk -v s="$START" -v e="$END" 'function t(x, a,n){n=split(x,a,":");return n==3?a[1]*3600+a[2]*60+a[3]:(n==2?a[1]*60+a[2]:x)} BEGIN{printf "%.2f", t(e)-t(s)}')
FADE="fade=t=in:st=0:d=0.3,fade=t=out:st=$(awk -v d="$DUR_IN" 'BEGIN{printf "%.2f", (d>1?d-0.45:0)}'):d=0.45"
if [ "$LAYOUT" = "portrait" ]; then
  BASEV="[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,$FADE[v1];"
  HOOK_Y=${HOOK_Y:-820}; CAP_Y=$((HOOK_Y + 170)); CRED_Y=$((HOOK_Y + 245)); BOX=0
elif [ "$LAYOUT" = "stack" ]; then
  IFS=, read -r CX CY CW CH <<< "${CAM:?CAM=x,y,w,h needed for LAYOUT=stack}"
  BASEV="[0:v]split=2[c][g];
[c]crop=iw*$CW:ih*$CH:iw*$CX:ih*$CY,scale=1080:600:force_original_aspect_ratio=increase,crop=1080:600[cam];
[g]scale=-2:1320,crop=1080:1320:(iw-1080)*$FOCUS:0[game];
[cam][game]vstack=inputs=2,$FADE[v1];"
  HOOK_Y=${HOOK_Y:-625}; CAP_Y=$((HOOK_Y + 170)); CRED_Y=$((HOOK_Y + 245)); BOX=0
elif [ "$LAYOUT" = "blur" ]; then
  BASEV="[0:v]split=2[bg][fg];
[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.15[bgb];
[fg]scale=1080:-2[fgs];
[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v1];"
  HOOK_Y=230; CAP_Y=1380; CRED_Y=1640; BOX=0
else
  BASEV="[0:v]scale=-2:1920,crop=1080:1920:(iw-1080)*$FOCUS:0,$FADE[v1];"
  # Text stays inside the area TikTok/Reels/Shorts don't cover with their own buttons and captions.
  HOOK_Y=${HOOK_Y:-700}; CAP_Y=$((HOOK_Y + 170)); CRED_Y=$((HOOK_Y + 245)); BOX=0
fi
BOXOPT="box=$BOX:boxcolor=black@0.45:boxborderw=16"

TXT="fontcolor=white:borderw=3:bordercolor=black@0.85:shadowx=0:shadowy=3:shadowcolor=black@0.45"
# one drawtext per line so every line is centred (TikTok-style caption block)
HOOKF=""; i=0; LAST="v1"
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  printf '%s' "$line" > "$TMP/h$i.txt"
  HOOKF="$HOOKF
[$LAST]drawtext=fontfile='$FONT_BOLD':textfile='$TMP/h$i.txt':fontsize=58:$TXT:x=(w-text_w)/2:y=$((HOOK_Y + i * 70))[h$i];"
  LAST="h$i"; i=$((i + 1))
done < "$TMP/hook.txt"
FILTER="$BASEV$HOOKF
[$LAST]drawtext=fontfile='$FONT':textfile='$TMP/credit.txt':fontsize=30:fontcolor=white@0.9:borderw=2:bordercolor=black@0.8:x=(w-text_w)/2:y=$((HOOK_Y + i * 70 + 14)),format=yuv420p[v]"

mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -loglevel error -y -ss "$START" -to "$END" -i "$IN" \
  -filter_complex "$FILTER" -map "[v]" -map 0:a? -af "afade=t=in:st=0:d=0.3,afade=t=out:st=$(awk -v d="$DUR_IN" 'BEGIN{printf "%.2f", (d>1?d-0.45:0)}'):d=0.45" \
  -c:v libx264 -preset slow -crf 18 -maxrate 6M -bufsize 12M -profile:v high -fps_mode passthrough \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
echo "✓ $OUT  (${DUR%.*}s, 1080x1920)"
