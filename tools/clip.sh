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

FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT="/System/Library/Fonts/Supplemental/Arial.ttf"

# Text goes through files so quotes, colons and emoji never break the filter.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# ffmpeg can't draw colour emoji, so strip them from burned-in text (keep them in the post caption).
noemoji() { perl -CSD -pe 's/[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}\x{FE0F}\x{200D}]//g; s/ +$//; s/^ +//'; }
printf '%s' "$HOOK" | noemoji | fold -s -w 22 > "$TMP/hook.txt"
printf 'via %s' "$CREDIT" | noemoji > "$TMP/credit.txt"
printf '%s' "$CAPTION" | noemoji | fold -s -w 30 > "$TMP/caption.txt"

# LAYOUT=full (default): the clip fills the whole 9:16 frame (crop of the landscape source).
#   FOCUS=0..1 picks which part of the width to keep (0 = left edge, 0.5 = centre, 1 = right edge).
# LAYOUT=blur: the older look (whole landscape clip in the middle, blurred copy above and below).
LAYOUT=${LAYOUT:-full}
FOCUS=${FOCUS:-0.5}
if [ "$LAYOUT" = "blur" ]; then
  BASEV="[0:v]split=2[bg][fg];
[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.15[bgb];
[fg]scale=1080:-2[fgs];
[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v1];"
  HOOK_Y=230; CAP_Y=1380; CRED_Y=1640; BOX=0
else
  BASEV="[0:v]scale=-2:1920,crop=1080:1920:(iw-1080)*$FOCUS:0[v1];"
  # Text stays inside the area TikTok/Reels/Shorts don't cover with their own buttons and captions.
  HOOK_Y=250; CAP_Y=440; CRED_Y=530; BOX=1
fi
BOXOPT="box=$BOX:boxcolor=black@0.45:boxborderw=16"

FILTER="$BASEV
[v1]drawtext=fontfile='$FONT_BOLD':textfile='$TMP/hook.txt':fontsize=72:fontcolor=white:borderw=6:bordercolor=black:line_spacing=12:$BOXOPT:x=(w-text_w)/2:y=$HOOK_Y[v2];
[v2]drawtext=fontfile='$FONT_BOLD':textfile='$TMP/caption.txt':fontsize=54:fontcolor=white:borderw=5:bordercolor=black:line_spacing=10:$BOXOPT:x=(w-text_w)/2:y=$CAP_Y[v3];
[v3]drawtext=fontfile='$FONT':textfile='$TMP/credit.txt':fontsize=40:fontcolor=white@0.95:borderw=3:bordercolor=black:x=(w-text_w)/2:y=$CRED_Y,fps=30,format=yuv420p[v]"

mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -loglevel error -y -ss "$START" -to "$END" -i "$IN" \
  -filter_complex "$FILTER" -map "[v]" -map 0:a? \
  -c:v libx264 -preset medium -crf 20 -profile:v high \
  -c:a aac -b:a 160k -ar 48000 -movflags +faststart "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
echo "✓ $OUT  (${DUR%.*}s, 1080x1920)"
