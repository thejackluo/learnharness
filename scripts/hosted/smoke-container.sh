#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tag="${LH_IMAGE:-learnharness:hosted-smoke}"
name="lh-hosted-smoke-$$"
volume="lh-hosted-smoke-$$"
restored="lh-hosted-restored-$$"
fresh="lh-hosted-empty-$$"
tmp="$(mktemp -d)"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export LH_IMAGE="$tag" LH_PUBLIC_ORIGIN="${LH_PUBLIC_ORIGIN:-https://lh.invalid}" LH_VOLUME_NAME="$volume" LH_HOST_PORT="$port"
passfile="$tmp/backup.pass"
printf '%s\n' 'synthetic container smoke passphrase' > "$passfile"
chmod 0600 "$passfile"

cleanup() {
	docker compose -f "$root/compose.yaml" down >/dev/null 2>&1 || true
	docker rm -f "$name" "$fresh" >/dev/null 2>&1 || true
	docker volume rm "$volume" "$restored" "$fresh" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

docker build -t "$tag" "$root"
printf '%s\n' 'synthetic hosted smoke passphrase' | "$root/scripts/hosted/init-volume.sh" --volume "$volume" --image "$tag"
compose=(docker compose -f "$root/compose.yaml")
wait_healthy() {
	local base="$1"
	for _ in {1..60}; do
		if curl --fail --silent --max-time 2 "$base/api/health" >/dev/null; then return 0; fi
		sleep 1
	done
	echo "Container did not become healthy at $base." >&2
	return 1
}
login() {
	local base="$1" passphrase="${2:-synthetic hosted smoke passphrase}" headers="$tmp/login.headers" body="$tmp/login.body" cookie
	curl --silent --show-error -D "$headers" -o "$body" -X POST "$base/api/auth/login" \
		-H 'Origin: https://lh.invalid' -H 'Content-Type: application/json' \
		--data "{\"passphrase\":\"$passphrase\"}"
	cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-lh_session=[^;]*;\).*/\1/p' "$headers" | tr -d '\r' | head -n1)"
	[[ "$cookie" == __Host-lh_session=* ]] || { cat "$body" >&2; echo "Login did not issue a session cookie." >&2; return 1; }
	printf '%s' "${cookie%;}"
}
assert_json() {
	CHAT_ID="${2:-}" node -e 'let text="";process.stdin.on("data",x=>text+=x).on("end",()=>{const x=JSON.parse(text);if(!eval(process.argv[1]))process.exit(1)})' "$1"
}
base="http://127.0.0.1:$port"
"${compose[@]}" up -d --no-build
wait_healthy "$base"
cookie="$(login "$base")"
chat="$(curl --fail --silent "$base/api/chats" -X POST -H "Cookie: $cookie" -H 'Origin: https://lh.invalid' -H 'Content-Type: application/json' --data '{"title":"container-persistence-smoke"}')"
chat_id="$(node -e 'process.stdin.on("data",x=>{const j=JSON.parse(x);process.stdout.write(j.id)})' <<< "$chat")"
[[ -n "$chat_id" ]]
curl --fail --silent "$base/api/settings/general" -X PUT -H "Cookie: $cookie" -H 'Origin: https://lh.invalid' -H 'Content-Type: application/json' --data '{"autoUpdate":false}' >/dev/null
curl --fail --silent "$base/api/keys/OPENAI_API_KEY" -X PUT -H "Cookie: $cookie" -H 'Origin: https://lh.invalid' -H 'Content-Type: application/json' --data '{"value":"sk-synthetic-hosted-smoke-0123456789abcdef"}' >/dev/null
import_result="$(curl --fail --silent "$base/api/graph/import" -X POST -H "Cookie: $cookie" -H 'Origin: https://lh.invalid' -F 'files=@-;filename=synthetic.txt;type=text/plain' <<< 'synthetic bounded import')"
assert_json 'x.results?.length===1&&x.results[0].code==="models_not_configured"' <<< "$import_result"

cid="$("${compose[@]}" ps -q learnharness)"
[[ "$(docker exec "$cid" id -u)" == 1000 ]]
if docker exec --user 0 "$cid" sh -c 'touch /root/read-only-check'; then
	echo "Container root filesystem unexpectedly accepted writes." >&2; exit 1
fi
docker stop "$cid" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
[[ "$exit_code" == 0 ]] || { echo "SIGTERM shutdown exited with $exit_code." >&2; exit 1; }
"${compose[@]}" up -d --no-build
wait_healthy "$base"
chats="$(curl --fail --silent "$base/api/chats" -H "Cookie: $cookie")"
assert_json 'x.chats?.some(c=>c.id===process.env.CHAT_ID)' "$chat_id" <<< "$chats"

"${compose[@]}" down
backup_dir="$tmp/backups"
LH_BACKUP_DIR="$backup_dir" BACKUP_PASSFILE="$passfile" LH_IMAGE="$tag" LH_VOLUME_NAME="$volume" \
	"$root/scripts/hosted/backup.sh" persist-smoke
archive="$backup_dir/learnharness-$(date -u +%F)-persist-smoke.tar.gz.enc"
BACKUP_PASSFILE="$passfile" LH_IMAGE="$tag" "$root/scripts/hosted/restore.sh" "$archive" "$restored"

LH_VOLUME_NAME="$restored" LH_HOST_PORT="$port" "${compose[@]}" up -d --no-build
wait_healthy "$base"
restored_cid="$("${compose[@]}" ps -q learnharness)"
docker exec "$restored_cid" ls -ln /var/lib/learnharness/owner
docker exec --user 1000:1000 "$restored_cid" test -r /var/lib/learnharness/owner/owner.json
restored_chats="$(curl --fail --silent "$base/api/chats" -H "Cookie: $cookie")"
assert_json 'x.chats?.some(c=>c.id===process.env.CHAT_ID)' "$chat_id" <<< "$restored_chats"

printf '%s\n' 'synthetic empty volume owner passphrase' | "$root/scripts/hosted/init-volume.sh" --volume "$fresh" --image "$tag"
docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
	-p 127.0.0.1::3000 -e LH_RUNTIME=hosted -e LH_PUBLIC_ORIGIN=https://lh.invalid \
	-e LH_DATA_DIR=/var/lib/learnharness/data -e LH_AUTH_FILE=/var/lib/learnharness/keys/auth.json \
	-e LH_OWNER_DIR=/var/lib/learnharness/owner -e NEXT_MANUAL_SIG_HANDLE=true -e NEXT_TELEMETRY_DISABLED=1 \
	-v "$fresh:/var/lib/learnharness" "$tag" >/dev/null
fresh_port="$(docker port "$name" 3000/tcp | sed 's/.*://')"
fresh_base="http://127.0.0.1:$fresh_port"
wait_healthy "$fresh_base"
fresh_cookie="$(login "$fresh_base" 'synthetic empty volume owner passphrase')"
empty_chats="$(curl --fail --silent "$fresh_base/api/chats" -H "Cookie: $fresh_cookie")"
assert_json 'Array.isArray(x.chats)&&x.chats.length===0' <<< "$empty_chats"

cid="$("${compose[@]}" ps -q learnharness)"
docker export "$cid" | tar -xf - -C "$tmp"
sentinel="LEARNHARNESS_HOSTED_$(printf 'SENTINEL')_NOT_SHIPPED"
node "$root/scripts/scan-payload.mjs" "$tmp" --sentinel "$sentinel"
echo "Container persistence, backup/restore, isolation, and hardening smoke passed."
