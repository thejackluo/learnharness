import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repo = path.resolve(".");
const deploy = path.join(repo, "scripts/hosted/deploy.sh");
const initVolume = path.join(repo, "scripts/hosted/init-volume.sh");

function fixture(mode = "healthy") {
	const root = mkdtempSync(path.join(tmpdir(), "lh-deploy-test-"));
	const sshLog = path.join(root, "ssh.log");
	const curlCount = path.join(root, "curl.count");
	for (const name of ["key", "known-hosts", "passfile"]) writeFileSync(path.join(root, name), "synthetic\n", { mode: 0o600 });
	const ssh = path.join(root, "ssh");
	writeFileSync(ssh, `#!/bin/sh
last=""
for arg do last="$arg"; done
printf '%s\\n' "$last" >> "$SSH_LOG"
case "$last" in *"docker compose ps"*) printf '%s\\n' "$PREVIOUS_IMAGE";; esac
cat >/dev/null
`, { mode: 0o700 });
	chmodSync(ssh, 0o700);
	const bin = path.join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const curl = path.join(bin, "curl");
	writeFileSync(curl, `#!/bin/sh
n=0
[ ! -f "$CURL_COUNT" ] || n=$(cat "$CURL_COUNT")
n=$((n + 1))
printf '%s' "$n" > "$CURL_COUNT"
if [ "$CURL_MODE" = fail-first ] && [ "$n" -eq 1 ]; then
  printf '%s\\n' '{"ok":false,"version":"failed"}'
else
  printf '%s\\n' '{"ok":true,"version":"synthetic"}'
fi
`, { mode: 0o700 });
	chmodSync(curl, 0o700);
	return { root, ssh, sshLog, curlCount, bin, mode };
}

function run(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
	return spawnSync("bash", [deploy], {
		cwd: repo,
		encoding: "utf8",
		env: {
			PATH: `${f.bin}:${process.env.PATH}`,
			HOME: process.env.HOME ?? "",
			NODE_ENV: "test",
			DEPLOY_HOST: "host.invalid",
			DEPLOY_USER: "owner",
			DEPLOY_SSH_KEY_FILE: path.join(f.root, "key"),
			DEPLOY_KNOWN_HOSTS_FILE: path.join(f.root, "known-hosts"),
			DEPLOY_SSH: f.ssh,
			DEPLOY_PATH: "/srv/learnharness",
			DEPLOY_HEALTH_ATTEMPTS: "1",
			DEPLOY_HEALTH_INTERVAL: "0",
			LH_PUBLIC_ORIGIN: "https://lh.invalid",
			LH_IMAGE: `registry.invalid/learnharness@sha256:${"a".repeat(64)}`,
			BACKUP_PASSFILE: path.join(f.root, "passfile"),
			SSH_LOG: f.sshLog,
			CURL_COUNT: f.curlCount,
			CURL_MODE: f.mode,
			PREVIOUS_IMAGE: "registry.invalid/learnharness@sha256:" + "b".repeat(64),
			...extra,
		},
	});
}

function volumeFixture(preexisting = false) {
	const root = mkdtempSync(path.join(tmpdir(), "lh-volume-test-"));
	const bin = path.join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const dockerLog = path.join(root, "docker.log");
	const runCount = path.join(root, "docker-run.count");
	const docker = path.join(bin, "docker");
	writeFileSync(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = volume ] && [ "$2" = inspect ]; then
  [ "$DOCKER_PREEXISTING" = 1 ]
  exit $?
fi
if [ "$1" = volume ] && [ "$2" = create ]; then exit 0; fi
if [ "$1" = volume ] && [ "$2" = rm ]; then exit 0; fi
if [ "$1" = run ]; then
  n=0
  [ ! -f "$DOCKER_RUN_COUNT" ] || n=$(cat "$DOCKER_RUN_COUNT")
  n=$((n + 1))
  printf '%s' "$n" > "$DOCKER_RUN_COUNT"
  [ "$n" -lt 2 ]
  exit $?
fi
exit 90
`, { mode: 0o700 });
	chmodSync(docker, 0o700);
	return { root, bin, dockerLog, runCount, preexisting };
}

function runInitVolume(f: ReturnType<typeof volumeFixture>, volume: string) {
	return spawnSync("bash", [initVolume, "--volume", volume, "--image", "synthetic:hosted"], {
		cwd: repo,
		encoding: "utf8",
		env: {
			PATH: `${f.bin}:${process.env.PATH ?? ""}`,
			DOCKER_LOG: f.dockerLog,
			DOCKER_RUN_COUNT: f.runCount,
			DOCKER_PREEXISTING: f.preexisting ? "1" : "0",
		},
	});
}

test("deploy fails closed when required deployment configuration is missing", () => {
	const result = spawnSync("bash", [deploy], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Missing required setting: DEPLOY_HOST/);
});

test("deploy orders backup before digest pull and compose update without volume deletion", () => {
	const f = fixture();
	try {
		const result = run(f);
		assert.equal(result.status, 0, result.stderr);
		const commands = readFileSync(f.sshLog, "utf8").trim().split("\n");
		const backup = commands.findIndex((command) => command.includes("scripts/hosted/backup.sh --stop pre-deploy"));
		const deployIndex = commands.findIndex((command) => command.includes("docker pull") && command.includes("@sha256:"));
		const pull = commands.findIndex((command) => command.includes("docker pull") && command.includes("@sha256:"));
		const update = commands.findIndex((command) => command.includes("docker compose up -d --no-build"));
		assert.ok(backup >= 0 && backup < deployIndex && deployIndex < update, commands.join("\n"));
		assert.equal(commands.some((command) => /docker volume (rm|prune)|compose down -v/.test(command)), false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("deploy rolls back to the prior image after a health failure", () => {
	const f = fixture("fail-first");
	try {
		const result = run(f);
		assert.equal(result.status, 1);
		const commands = readFileSync(f.sshLog, "utf8");
		assert.match(commands, /LH_IMAGE='registry\.invalid\/learnharness@sha256:bbbb/);
		assert.match(result.stderr, /Rolling back to the previous image/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("init-volume removes a newly created volume when owner provisioning fails", () => {
	const f = volumeFixture();
	const volume = "lh-volume-provision-failure";
	try {
		const result = runInitVolume(f, volume);
		assert.equal(result.error, undefined, result.error?.message);
		assert.notEqual(result.status, 0);
		const commands = readFileSync(f.dockerLog, "utf8").trim().split("\n");
		assert.ok(commands.includes(`volume create ${volume}`), commands.join("\n"));
		assert.equal(readFileSync(f.runCount, "utf8"), "2");
		assert.ok(commands.includes(`volume rm ${volume}`), commands.join("\n"));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("init-volume refuses a pre-existing volume without removing it", () => {
	const f = volumeFixture(true);
	const volume = "lh-volume-already-exists";
	try {
		const result = runInitVolume(f, volume);
		assert.equal(result.error, undefined, result.error?.message);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /Refusing to initialize an existing volume/);
		const commands = readFileSync(f.dockerLog, "utf8").trim().split("\n");
		assert.ok(commands.includes(`volume inspect ${volume}`), commands.join("\n"));
		assert.equal(commands.includes(`volume create ${volume}`), false);
		assert.equal(commands.includes(`volume rm ${volume}`), false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
