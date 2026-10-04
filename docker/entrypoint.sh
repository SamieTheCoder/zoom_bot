#!/bin/sh
set -eu
# A single replica owns this profile and database. Never share them between running replicas.
chown node:node /data
chmod 700 /data
# Chrome leaves these behind on container crashes. No browser is running at entrypoint time.
rm -f /data/browser-profile/SingletonLock /data/browser-profile/SingletonCookie /data/browser-profile/SingletonSocket
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/meeting-desk.conf
