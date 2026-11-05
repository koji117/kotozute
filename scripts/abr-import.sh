#!/bin/zsh
# kotozute: import Tokyo ABR with residential-display (住居表示) data and coordinates (--pos).
# Usage: scripts/abr-import.sh ../abr-geocoder   (the abr-geocoder clone lives outside this repo)
# The DB password is generated here and never printed.
set -euo pipefail
cd "${1:?usage: scripts/abr-import.sh <abr-geocoder directory>}"
if [[ ! -f .env ]]; then
  cp .env.example .env
  pw=$(openssl rand -hex 24)
  sed -i '' "s/^DB_PASSWORD=.*/DB_PASSWORD=${pw}/" .env
  unset pw
fi
# Publish on localhost only. Tokyo, 住居表示, with coordinates.
sed -i '' \
  -e 's/^DB_PORT=.*/DB_PORT=127.0.0.1:55432/' \
  -e 's/^PORT=.*/PORT=127.0.0.1:3002/' \
  -e 's/^ABRDB_PREF=.*/ABRDB_PREF=13/' \
  -e 's/^ABRDB_CATEGORY=.*/ABRDB_CATEGORY=rsdtdsp/' \
  -e 's/^ABRDB_POS=.*/ABRDB_POS=true/' \
  -e 's|^ABRG_CORS_ALLOW_ORIGIN=.*|ABRG_CORS_ALLOW_ORIGIN=http://localhost:8787|' \
  .env
chmod 600 .env
echo "== $(date) postgres"
docker compose up -d postgres
echo "== $(date) init"
docker compose run --rm abrdb_app init --pref 13 --category rsdtdsp --pos -y
echo "== $(date) import"
docker compose run --rm abrdb_app import
echo "== $(date) cache build"
docker compose run --rm abrg_app cache build
echo "== $(date) serve"
docker compose up -d abrg_app
sleep 5
curl -s "http://127.0.0.1:3002/geocode?address=%E6%9D%B1%E4%BA%AC%E9%83%BD%E6%B8%AF%E5%8C%BA%E8%8A%9D%E5%85%AC%E5%9C%924-2-8" | head -c 600
echo
echo "== $(date) done"
