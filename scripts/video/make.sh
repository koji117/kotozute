#!/bin/sh
# デモ動画を1回で作る：録画（本物のアプリと本物の Claude）→ コマ → 声 → ~/kotozute-video/kotozute-demo-<日付>.mp4
# 実行（リポジトリのどこからでも）：sh scripts/video/make.sh            全部録り直す
#                                    sh scripts/video/make.sh --no-record   今の events.json のまま作る
#                                    sh scripts/video/make.sh ex2           指定した組だけ録り直す（record.mjs の組の名前）
# 要るもの：kotozute のサーバ（http://127.0.0.1:8787。Claude のキーはサーバの環境にだけある）、Playwright、ffmpeg、.env の ELEVENLABS_API_KEY（TTS=say なら say）。
# 出力は Git の外（~/kotozute-video）。3分（180秒）を超えたら失敗で終わる。
set -eu
# 声は ElevenLabs（2026-11-07 にユーザーが決定。声は Atsuji - Calm、速さ 1.15）。キーは .env の ELEVENLABS_API_KEY。TTS=say で macOS の Kyoko
export TTS="${TTS:-elevenlabs}" ELEVENLABS_VOICE_ID="${ELEVENLABS_VOICE_ID:-Ncfr0DOB9MiCWyPewqcL}" ELEVENLABS_SPEED="${ELEVENLABS_SPEED:-1.15}"
cd "$(dirname "$0")/../.."
OUT="$HOME/kotozute-video"
MP4="$OUT/kotozute-demo-$(date +%Y%m%d-%H%M).mp4"
start=$(date +%s)
if [ "${1:-}" != "--no-record" ]; then node scripts/video/record.mjs "$@"; fi
cd docs/storyboard
node render.js full
MP4="$MP4" node narrate.js
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4")
echo "$MP4：${dur}秒（作るのにかかった時間 $(( $(date +%s) - start ))秒）"
awk -v d="$dur" 'BEGIN { exit !(d <= 180.0) }' || { echo "180秒を超えています" >&2; exit 1; }
