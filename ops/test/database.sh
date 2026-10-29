#!/bin/sh
# Isolated synthetic PostgreSQL fixture; never point at an existing data volume.
set -eu
/usr/local/bin/docker-entrypoint.sh postgres -c max_connections=24 -c shared_buffers=128MB -c max_wal_size=128MB -c listen_addresses=127.0.0.1 &
db_pid=$!
observer_pid=''
finish(){ kill -TERM "$db_pid" ${observer_pid:+"$observer_pid"} 2>/dev/null || true; wait "$db_pid" 2>/dev/null || true; }
trap finish TERM INT EXIT
while ! pg_isready -h 127.0.0.1 -U synthetic_bootstrap -d rolemorrow_synthetic >/dev/null 2>&1; do kill -0 "$db_pid"; sleep 1; done
(
 while kill -0 "$db_pid" 2>/dev/null; do
  df -B1 /var/lib/postgresql/data | awk -v observed="$(date +%s)000" 'NR==2 {printf "{\"database\":\"rolemorrow_synthetic\",\"storeId\":\"synthetic-pgdata\",\"observedAt\":%s,\"totalBytes\":%s,\"freeBytes\":%s}\n",observed,$2,$4}' > /observe/capacity.tmp
  chmod 0644 /observe/capacity.tmp
  mv /observe/capacity.tmp /observe/capacity.json
  sleep 5
 done
) &
observer_pid=$!
wait "$db_pid"
