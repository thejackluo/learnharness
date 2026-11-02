#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 2)); then
	echo "Usage: BACKUP_PASSFILE=/private/passfile $0 BACKUP.tar.gz.enc NEW_EMPTY_VOLUME" >&2
	exit 2
fi
archive="$1"
volume="$2"
image="${LH_IMAGE:-learnharness:local}"
passfile="${BACKUP_PASSFILE:-}"
[[ -f "$archive" && -s "$archive" ]] || { echo "Backup archive not found or empty." >&2; exit 2; }
[[ -n "$passfile" && -f "$passfile" && -s "$passfile" ]] || { echo "BACKUP_PASSFILE must name a non-empty passphrase file." >&2; exit 2; }
[[ "$volume" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid volume name." >&2; exit 2; }
if docker volume inspect "$volume" >/dev/null 2>&1; then
	echo "Restore requires a new volume; this volume already exists: $volume" >&2
	exit 2
fi
docker volume create "$volume" >/dev/null
docker run --rm --user 0:0 -v "$volume:/restore" --entrypoint node "$image" \
	-e 'process.exit(require("node:fs").readdirSync("/restore").length === 0 ? 0 : 1)' || {
	echo "Refusing to restore into a non-empty volume: $volume" >&2
	exit 2
}
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$passfile" -in "$archive" |
	docker run --rm -i --user 0:0 -v "$volume:/restore" --entrypoint tar "$image" -xzf - -C /restore
docker run --rm --user 0:0 -v "$volume:/restore" --entrypoint /bin/sh "$image" \
	-euc 'chown -R 1000:1000 /restore; chmod 0700 /restore/data /restore/keys /restore/owner'
printf 'Restored into new volume %s. Revoke restored sessions and rotate provider credentials before returning to service.\n' "$volume"
printf 'After setting LH_VOLUME_NAME=%s, revoke sessions with: docker compose run --rm --user 1000:1000 learnharness node /app/scripts/owner-passphrase.mjs --dir /var/lib/learnharness/owner\n' "$volume"
