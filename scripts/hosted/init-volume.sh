#!/usr/bin/env bash
set -euo pipefail
umask 077

volume="${LH_VOLUME_NAME:-learnharness-state}"
image="${LH_IMAGE:-learnharness:local}"
while (($#)); do
	case "$1" in
		--volume) volume="${2:?missing volume name}"; shift 2 ;;
		--image) image="${2:?missing image tag}"; shift 2 ;;
		*) printf 'Usage: %s [--volume NAME] [--image IMAGE]\n' "$0" >&2; exit 2 ;;
	esac
done
[[ "$volume" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid volume name." >&2; exit 2; }

created=0
cleanup_created_volume() {
	local status=$?
	trap - EXIT
	if [[ "$created" == 1 && "$status" -ne 0 ]]; then
		docker volume rm "$volume" >/dev/null 2>&1 || printf 'Failed to remove newly created volume after initialization failure: %s\n' "$volume" >&2
	fi
	exit "$status"
}
trap cleanup_created_volume EXIT

if docker volume inspect "$volume" >/dev/null 2>&1; then
	echo "Refusing to initialize an existing volume: $volume" >&2
	exit 2
fi
docker volume create "$volume" >/dev/null
created=1
docker run --rm --user 0:0 -v "$volume:/var/lib/learnharness" --entrypoint /bin/sh "$image" \
	-euc 'for dir in data keys owner; do mkdir -p "/var/lib/learnharness/$dir"; chown 1000:1000 "/var/lib/learnharness/$dir"; chmod 0700 "/var/lib/learnharness/$dir"; done'

tty_args=(-i)
if [[ -t 0 ]]; then tty_args=(-i -t); fi
docker run "${tty_args[@]}" --rm --user 1000:1000 --read-only --tmpfs /tmp \
	--cap-drop ALL --security-opt no-new-privileges:true \
	-v "$volume:/var/lib/learnharness" \
	-e LH_OWNER_DIR=/var/lib/learnharness/owner \
	--entrypoint node "$image" /app/scripts/owner-passphrase.mjs --dir /var/lib/learnharness/owner
created=0
