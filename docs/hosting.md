# Private hosted deployment

LearnHarness can run as a single-owner service in Docker. The hosted runtime uses the same application and stores as local/Electron mode, with owner authentication and a single-writer lock. Keep the deployment private behind an HTTPS reverse proxy; Compose publishes the app only on `127.0.0.1:3000`.

## Requirements and initial setup

- Docker Engine with the Compose plugin.
- A public HTTPS origin, for example `https://learn.example.org`, terminating TLS at a reverse proxy on the host.
- A private backup passphrase file and a long, unique owner passphrase.
- A host firewall that exposes only the reverse proxy, not port 3000.

From a checked-out release:

```sh
export LH_PUBLIC_ORIGIN=https://learn.example.org
export LH_IMAGE=learnharness:local
docker compose build
printf '%s\n' 'your owner passphrase' | scripts/hosted/init-volume.sh
docker compose up -d
```

Without piped input, `init-volume.sh` prompts for the owner passphrase with terminal echo disabled. It creates `learnharness-state` and its `data`, `keys`, and `owner` directories with uid 1000 ownership, then provisions the owner verifier in a one-off container. Do not put the passphrase in Compose configuration or a committed file.

The container runs as uid 1000 with a read-only root filesystem, a temporary `/tmp`, no Linux capabilities, and `no-new-privileges`. Durable state is mounted at `/var/lib/learnharness`; the owner verifier, session records, provider keys, settings, chats, and graph records survive container replacement. Set provider keys and model choices through the authenticated settings UI. Hosted mode does not enable arbitrary web research or generated demo/visual/PDF jobs.

Configure the reverse proxy to forward HTTPS requests to `http://127.0.0.1:3000` and preserve the public `Host`/forwarded-protocol information. The app must receive the exact `LH_PUBLIC_ORIGIN`; do not expose the upstream port publicly. `/api/health` is an unauthenticated liveness endpoint and returns the application version.

To use a separately named state volume, set `LH_VOLUME_NAME` consistently for the helper scripts and Compose. Backups and restores operate on the volume name supplied by that variable.

## Encrypted backups and restore

Create a private passphrase file outside the repository and restrict its permissions:

```sh
install -m 600 /dev/null "$HOME/learnharness-backup.pass"
```

Write the passphrase to that file using a secret manager or another private method. Do not place backups in CI artifacts or public object storage. `backup.sh` requires the service to be stopped, or accepts `--stop` to stop it for the duration of the volume snapshot and restart it afterward:

```sh
BACKUP_PASSFILE="$HOME/learnharness-backup.pass" \
  LH_BACKUP_DIR="$HOME/learnharness-backups" \
  scripts/hosted/backup.sh --stop
```

Archives are encrypted with OpenSSL AES-256-CBC, PBKDF2, and 200,000 iterations, written with private permissions, and stored outside the application volume. The script retains seven daily archives and separately tagged backups such as `pre-deploy`.

Restore only into a new, empty volume; the helper refuses non-empty volumes and never overwrites or deletes an existing volume:

```sh
BACKUP_PASSFILE="$HOME/learnharness-backup.pass" \
  scripts/hosted/restore.sh "$HOME/learnharness-backups/learnharness-YYYY-MM-DD.tar.gz.enc" learnharness-restored
```

Before returning a restored service to use, rotate provider credentials and run the owner passphrase setup again to revoke restored sessions. Treat backup files and the passphrase file as equally sensitive.

## Manual production deploy

The `Deploy hosted` GitHub Actions workflow is `workflow_dispatch` only. It accepts an image reference pinned to `@sha256:<64 lowercase hex>` and requires approval through the protected `production` environment. Configure these environment secrets/variables:

| Setting | Type | Purpose |
|---|---|---|
| `DEPLOY_HOST`, `DEPLOY_USER` | secret | SSH destination |
| `DEPLOY_SSH_PRIVATE_KEY` | secret | deployment key |
| `DEPLOY_KNOWN_HOSTS` | secret | pinned SSH host key |
| `BACKUP_PASSPHRASE` | secret | encrypt the remote pre-deploy backup |
| `LH_PUBLIC_ORIGIN` | variable | public HTTPS origin |
| `DEPLOY_PATH` | optional variable | remote checkout path; defaults to `/opt/learnharness` |

The remote checkout must contain the Compose file and hosted scripts, with `LH_PUBLIC_ORIGIN` configured for Compose. Deploy records the running image, streams the backup passphrase to a temporary remote file over SSH stdin, makes a pre-deploy backup, pulls the requested digest, updates the single Compose service, then checks `/api/health` for both `ok: true` and a version. A failed health check restores the previous image and checks it again. Deployment does not remove or reset volumes. No workflow is triggered by pull-request code.

## Local verification

`node scripts/smoke-hosted.mjs` exercises the built standalone server with synthetic owner data, including login throttling, CSP nonces on authenticated and anonymous pages, same-origin writes, import refusal without a configured model, writer-lock recovery, record persistence, and empty-data isolation. `bash scripts/hosted/smoke-container.sh` builds and exercises the container, including stop/restart, backup/restore, the read-only/non-root runtime, and a payload scan.
