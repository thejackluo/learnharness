#!/usr/bin/env bash
set -euo pipefail
umask 077

required=(DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY_FILE DEPLOY_KNOWN_HOSTS_FILE LH_PUBLIC_ORIGIN LH_IMAGE BACKUP_PASSFILE)
for name in "${required[@]}"; do
	if [[ -z "${!name:-}" ]]; then printf 'Missing required setting: %s\n' "$name" >&2; exit 2; fi
done
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.-]+$ && "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid deployment host or user." >&2; exit 2; }
[[ -f "$DEPLOY_SSH_KEY_FILE" && -f "$DEPLOY_KNOWN_HOSTS_FILE" && -f "$BACKUP_PASSFILE" ]] || {
	echo "SSH key, known-hosts file, and backup passphrase file must exist." >&2; exit 2;
}
[[ "$LH_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] || { echo "LH_IMAGE must be pinned by @sha256:<64 lowercase hex>." >&2; exit 2; }
[[ "$LH_PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo "LH_PUBLIC_ORIGIN must be an HTTPS origin without a path." >&2; exit 2; }
deploy_path="${DEPLOY_PATH:-/opt/learnharness}"
[[ "$deploy_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo "DEPLOY_PATH contains unsupported characters." >&2; exit 2; }
attempts="${DEPLOY_HEALTH_ATTEMPTS:-30}"
interval="${DEPLOY_HEALTH_INTERVAL:-5}"
[[ "$attempts" =~ ^[1-9][0-9]*$ && "$interval" =~ ^[0-9]+$ ]] || { echo "Invalid health poll settings." >&2; exit 2; }

ssh_bin="${DEPLOY_SSH:-ssh}"
target="${DEPLOY_USER}@${DEPLOY_HOST}"
ssh_args=(-i "$DEPLOY_SSH_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$DEPLOY_KNOWN_HOSTS_FILE")
remote() { "$ssh_bin" "${ssh_args[@]}" "$target" "$1"; }

previous_image="$(remote "cd '$deploy_path' && cid=\$(docker compose ps -a -q learnharness 2>/dev/null | head -n 1 || true); if [ -n \"\$cid\" ]; then docker inspect --format '{{.Config.Image}}' \"\$cid\"; fi")"
if [[ -n "$previous_image" && ! "$previous_image" =~ ^[A-Za-z0-9][A-Za-z0-9./:_@-]*$ ]]; then
	echo "Remote current image reference contains unsupported characters." >&2
	exit 1
fi
if [[ -n "$previous_image" ]]; then echo "Previous image: $previous_image"; else echo "No previous image found; rollback will be unavailable."; fi

backup_command="set -eu; umask 077; cd '$deploy_path'; image=\$(docker compose config --images | head -n 1); pass=\$(mktemp); trap 'rm -f \"\$pass\"' EXIT; cat >\"\$pass\"; BACKUP_PASSFILE=\"\$pass\" LH_IMAGE=\"\$image\" scripts/hosted/backup.sh --stop pre-deploy"
"$ssh_bin" "${ssh_args[@]}" "$target" "$backup_command" < "$BACKUP_PASSFILE"
remote "cd '$deploy_path' && docker pull '$LH_IMAGE'"
remote "cd '$deploy_path' && LH_IMAGE='$LH_IMAGE' docker compose up -d --no-build"

healthy() {
	local body
	body="$(curl --fail --silent --show-error --max-time 10 "$LH_PUBLIC_ORIGIN/api/health" 2>/dev/null)" || return 1
	node -e 'let body="";process.stdin.on("data",x=>body+=x).on("end",()=>{try{const j=JSON.parse(body);process.exit(j.ok===true&&typeof j.version==="string"?0:1)}catch{process.exit(1)}})' <<< "$body"
}
for ((attempt = 1; attempt <= attempts; attempt++)); do
	if healthy; then echo "Deployment healthy: $LH_IMAGE"; exit 0; fi
	((attempt == attempts)) || sleep "$interval"
done

echo "New deployment did not become healthy." >&2
if [[ -z "$previous_image" ]]; then
	echo "No prior image was running; automatic rollback is unavailable." >&2
	exit 1
fi
echo "Rolling back to the previous image." >&2
remote "cd '$deploy_path' && LH_IMAGE='$previous_image' docker compose up -d --no-build"
for ((attempt = 1; attempt <= attempts; attempt++)); do
	if healthy; then echo "Rollback healthy: $previous_image" >&2; exit 1; fi
	((attempt == attempts)) || sleep "$interval"
done
echo "Rollback health check also failed; inspect the remote service." >&2
exit 1
