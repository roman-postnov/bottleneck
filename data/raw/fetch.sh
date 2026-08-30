#!/usr/bin/env bash
# Geofabrik extracts. norcal covers both Paradise and San Francisco.
set -u
cd "$(dirname "$0")"
for u in \
  "https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf" \
  "https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf" \
  "https://download.geofabrik.de/north-america/us/florida-latest.osm.pbf" ; do
  f="$(basename "$u")"
  echo "[$(date +%H:%M:%S)] -> $f"
  curl -sSL -C - -o "$f" "$u" && echo "[$(date +%H:%M:%S)] ok $f $(du -h "$f" | cut -f1)" \
    || echo "[$(date +%H:%M:%S)] FAIL $f"
done
echo "[$(date +%H:%M:%S)] готово"
