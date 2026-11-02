#!/usr/bin/env bash
set -euo pipefail
umask 077

stop_app=0
if [[ "${1:-}" == "--stop" ]]; then stop_app=1; shift; fi
tag="${1:-}"
if (($# > 1)) || [[ -n "$tag" && ! "$tag" =~ ^[A-Za-z0-9._-]+$ ]]; then
	echo "Usage: $0 [--stop] [tag]" >&2
	exit 2
fi
volume="${LH_VOLUME_NAME:-learnharness-state}"
image="${LH_IMAGE:-learnharness:local}"
passfile="${BACKUP_PASSFILE:-}"
backup_dir="${LH_BACKUP_DIR:-./backups}"
[[ -n "$passfile" && -f "$passfile" && -s "$passfile" ]] || { echo "BACKUP_PASSFILE must name a non-empty passphrase file." >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required on the backup host." >&2; exit 2; }
docker volume inspect "$volume" >/dev/null

stopped=0
running="$(docker compose ps --status running --services 2>/dev/null || true)"
if printf '%s\n' "$running" | grep -Fxq learnharness; then
	((stop_app)) || { echo "Stop the learnharness service first, or pass --stop." >&2; exit 2; }
	docker compose stop learnharness
	stopped=1
fi
restart_app() {
	if ((stopped)); then docker compose start learnharness >/dev/null || echo "Warning: failed to restart learnharness." >&2; fi
}
trap restart_app EXIT

mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"
day="$(date -u +%F)"
suffix=""
[[ -z "$tag" ]] || suffix="-$tag"
destination="$backup_dir/learnharness-${day}${suffix}.tar.gz.enc"
temporary="$(mktemp "$backup_dir/.backup.XXXXXXXX")"
trap 'rm -f "$temporary"; restart_app' EXIT
docker run --rm --user 1000:1000 -v "$volume:/source:ro" --entrypoint tar "$image" \
	-czf - -C /source . |
	openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$passfile" -out "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$destination"

daily=()
for file in "$backup_dir"/learnharness-????-??-??.tar.gz.enc; do
	[[ -f "$file" ]] && daily+=("$file")
done
if ((${#daily[@]} > 7)); then
	mapfile -t old_daily < <(printf '%s\n' "${daily[@]}" | sort -r | tail -n +8)
	((${#old_daily[@]} == 0)) || rm -f -- "${old_daily[@]}"
fi
printf 'Encrypted backup written: %s\n' "$destination"
