#!/bin/sh
# Re-creates /share/homes symlink if missing (QTS quirk on cold boot).
LOG=/var/log/autorun.log
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
for i in $(seq 1 60); do
  [ -d /share/CACHEDEV1_DATA/homes ] && break
  sleep 1
done
if [ ! -d /share/CACHEDEV1_DATA/homes ]; then
  echo "$STAMP autorun: ERROR /share/CACHEDEV1_DATA/homes not found after 60s" >> "$LOG"
  exit 0
fi
if [ "$(readlink /share/homes)" != "/share/CACHEDEV1_DATA/homes" ]; then
  ln -sfn /share/CACHEDEV1_DATA/homes /share/homes
  echo "$STAMP autorun: (re)created /share/homes -> /share/CACHEDEV1_DATA/homes" >> "$LOG"
else
  echo "$STAMP autorun: /share/homes symlink already correct" >> "$LOG"
fi
exit 0
