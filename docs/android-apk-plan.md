---
status: in-progress
phase: 8
updated: 2026-10-25
---

# Implementation Plan: SillyBunny Android APK (first-party install method)

## Goal

Ship a first-party SillyBunny Android APK (GitHub Releases only) that acts as the Android equivalent of `scripts/bootstrap/install.sh` + `start.sh`: it bundles Node (the only JavaScript runtime for now), git, bash and npm, clones and self-updates a real git checkout of SillyBunny exactly like the desktop launchers, and updates its own runtime shell from GitHub Releases. Bun packaging is deferred by the confirmed 2026-10-21 decision (§9.10); non-APK Bun support stays unchanged. The first test build is `v2.0.0-rc.1`, and it goes stable in `v2.0.0`.

---

## 0. Read this first (handoff instructions for the implementing agent)

- This file is self-contained. It was produced in a planning/grilling session between Geechan (maintainer) and an agent on 2026-10-21. You need no prior context. Every decision is final unless marked open under **§9 Caveats and confirmations**.
- **Your first task (1.1):** commit this file unchanged to a new branch `feat/android-apk` (branched from `staging`) as `docs/android-apk-plan.md`. Keep its checkboxes updated as you work.
- **The repo's `AGENTS.md` takes precedence over this file.** The rules most relevant to this work:
  - PRs target `staging`. This work is **one cohesive PR** from `feat/android-apk`.
  - **Do not write PR titles or bodies, docs, release notes, README/CONTRIBUTING/SECURITY/PRODUCT copy, or any user-facing prose.** Use the exact placeholder `lorum ipsum` and list every location (see §8). §8 gives *guidance on what humans should write*, not the wording itself.
  - `AGENTS.md` may only receive brief, terse additions, and **only under maintainer supervision** (ask first, show the diff).
  - Do not remove `.npmrc` settings (`ignore-scripts=true`, `min-release-age=7`, etc.).
  - Prefer self-contained additions. Where a base file must change, add a short inline comment explaining where and why (for future upstream merges).
  - Node parity: there must be no Bun-only APIs in server code.
  - ESLint style: ESM, 4-space indent, single quotes, semicolons, trailing commas.
- Repo `path:line` references below were re-verified against `staging` commit `21b571a1d`, before this branch's changes (task 1.2). Re-verify them if `staging` moves.
- Research claims marked *(unverified)* came from secondary research summaries. Verify them during Phase 2 spikes.

---

## 1. Background

### 1.1 The v2.0.0 distribution model (what the APK must match)

- SillyBunny v2.0.0 only supports **git checkouts**, and releases provide **installer files** that set users up with a git environment. ZIP installs are being retired. GHCR and CI automate the pipeline.
- Release assets today are the bootstrap installers in `scripts/bootstrap/` (`install.sh`, `Install-SillyBunny.ps1`, `Install-SillyBunny.cmd`), plus `SHA256SUMS`. Build-provenance attestations cover these files and are stored by GitHub's attestation service, not uploaded as release assets (`.github/workflows/release.yml:71-111`).
- Tags: stable `vX.Y.Z` (must be on `release`, marked `--latest`) and RC `vX.Y.Z-rc.N` (on `staging` or `release`, marked `--prerelease`). Releases are created as **drafts** for maintainers to publish, and the tag must equal `package.json` version (`release.yml:41-69, 95-111`).
- Launchers self-update on startup:
  - **Update:** `start.sh` → `bash scripts/self-update.sh --optional` (`start.sh:192-196`) runs `git fetch`, then `git pull --ff-only` on the current branch's upstream. It requires a clean worktree and a named branch with an upstream, and it skips with exit 0 when the update is optional (`scripts/self-update.sh:14-113`). APK mode instead merges the checked commit (§3.2).
  - **Then:** a dependency-profile check runs `npm ci` / `bun install` only when needed, followed by `init`, then server start. The APK uses Node/npm only; other installs retain their runtime choice (§9.10). The launcher loops on exit code **75** (`start.sh:221-375`).
- `install.sh` clones with `git clone --filter=blob:none --branch "$ref"` (default `release`) and supports `--dir`, `--ref`, `--repo`, `--migrate-from`, `--use-bun`, `--use-node`, `--no-start` (`scripts/bootstrap/install.sh:39-60, 79-123, 380`).

### 1.2 Why the APK is a "runtime host + git installer", not a code snapshot

Decided in Round 1 Q1. The APK contains **no SillyBunny code snapshot**. On first launch it runs `install.sh` to clone the repo; on every launch it runs `start.sh`, exactly like desktop. As a result:
- the in-app Server Tools updater, branch switcher, extensions and server plugins work unchanged
- every install method is unified, with no special-case code for the APK
- the APK itself only needs updating when the bundled runtime/tools (Node, git, bash, npm) or the Android shell changes; Bun is deferred (§9.10)

### 1.3 Termux status

Termux stays supported. Its docs visibility is reduced **only once the APK is proven seamless**. **While the app is unregistered with Google developer verification (see §9), Termux must stay visible in the docs.** Android ≤ 9 users and power users still use Termux. Termux migration tooling is out of scope.

---

## 2. Architecture overview

### 2.1 What the APK contains

```
APK (applicationId io.github.sillybunnyteam.sillybunny, label "SillyBunny")
├── Kotlin + Jetpack Compose shell (minimal native UI)
├── jniLibs/<abi>/   (extracted to nativeLibraryDir for bundled executables; system executables remain allowed)
│   ├── libnode.so       Node.js (pin: v26.12.1, §9; built from upstream source with the NDK)
│   ├── libgit.so        git (repackaged pinned Termux package)
│   ├── libgit-remote-http.so (and any other helpers git execs by name)
│   ├── libbash.so       bash (repackaged pinned Termux package)
│   ├── libnpm.so        native trampoline → libnode.so <npm-cli.js> "$@"
│   ├── libnpx.so        native trampoline → libnode.so <npx-cli.js> "$@"
│   └── lib*.so          shared libs needed by git/bash (openssl, curl, zlib, nghttp2, pcre2, iconv, ...; inspect ELF DT_NEEDED)
└── assets/
    ├── runtime/npm/     npm package (JS), version >= 11.10.0 (needed for .npmrc min-release-age); pin: 11.20.0 from Node's deps/npm, one ZIP asset
    ├── runtime/certs/   CA bundle for git/curl/openssl
    ├── runtime/git-templates/
    ├── runtime/git-core-links.txt  tab-separated helper basename → native filename map
    ├── THIRD_PARTY_NOTICES (license texts for all bundled binaries)
    └── runtime-manifest.json (versions + sha256 of bundled binaries)
```

ABIs: **arm64-v8a** (primary, Node only), **armeabi-v7a** (fallback, Node only), **x86_64** (Node-only CI emulator tests, never published). No `libbun.so` ships while Bun is deferred (§9.10).

### 2.2 On-device layout (all under `Context.filesDir`; never hardcode `/data/data/...`, so work profiles, secondary users and Private Space work)

```
filesDir/
├── runtime/
│   ├── bin/            symlinks: node, git, bash, npm, npx → nativeLibraryDir/lib*.so; no bun
│   ├── libexec/git-core/  all 148 symlinks from git-core-links.txt → nativeLibraryDir/lib*.so
│   ├── lib/node_modules/npm/   (extracted from assets)
│   ├── share/git-core/templates/, etc/certs/cert.pem
│   ├── openssl-modules/  empty directory; optional providers/engines are not bundled
│   └── installed-runtime.json  (which APK versionCode laid this out; re-run setup when it changes)
├── home/               HOME (npm cache, .gitconfig)
├── status/             files written by scripts for the app to read (e.g. update-blocked.json)
├── logs/               rotated server logs
├── SillyBunny/         THE git checkout (data/ and config.yaml live inside it, gitignored, same as every other install)
└── SillyBunny.broken-<timestamp>/   left behind by Repair; deleted only by explicit user action
```

**Phase 5 layout contract (P4-T, §6):** package `android/runtime/out/<abi>/jniLibs/` with extraction enabled. Link `runtime/bin/git` and `bash` to `libgit.so` and `libbash.so`; parse every `git-core-links.txt` line as `<basename><TAB><native filename>` and create all helper links, including both `git-remote-http` and `git-remote-https` → `libgit-remote-http.so`. Copy `git-templates/` and `certs/cert.pem` from the runtime assets to the locations above. Never copy executables into writable `filesDir`; refresh links/assets and resolve the current `nativeLibraryDir` when APK versionCode changes.

### 2.3 Process model

`ServerService` (foreground service, type `specialUse`) → `ProcessBuilder(nativeLibraryDir/libbash.so, "--noprofile", "--norc", "start.sh")` with cwd `filesDir/SillyBunny`.

- `start.sh` → `node server.js` (the supervisor, `src/server-supervisor.js`) → `node server.js` (the server child, spawned via `argv[0]`, `src/server-supervisor.js:219-229`). git, npm and other short-lived processes come and go.
- Android 12+ counts these processes towards a configurable **system-wide default** limit of 32 (the "phantom process" limit), not a per-app pool. Foreground importance does not exempt them; keep update/install work sequential (R2, §2).
- **Stopping:** send SIGTERM to the whole process group (or to the supervisor PID). The supervisor sends the child the IPC message `sillybunny:shutdown`, with a 5 s SIGKILL fallback (`src/server-supervisor.js:177-211`). **Verified (S2.5):** with the server started under an app-owned `setsid` shell, SIGTERM to the negative PGID removed every process in 67–151 ms on API 29/36/37, without SIGKILL. A supervisor-only SIGTERM diagnostic showed the graceful path (shutdown message → child exit 0 → supervisor exit 0) in 36–43 ms. Group SIGTERM proves clean removal, not graceful IPC delivery to a child that receives the signal too.

### 2.4 Startup sequence (every launch)

1. Make sure the runtime layout matches the installed APK (refresh the symlinks and assets if `installed-runtime.json` differs).
2. Kick off the APK update check in parallel (non-blocking, §5.5).
3. If `SillyBunny/` is not a finished checkout (missing, empty, or without `.git/HEAD`, `.git/index` or `package.json`) and neither the server nor a setup job is running → run the first-run flow (§4.3). An interrupted Repair resumes first (§4.7). A partial checkout shows Interrupted with Repair; first run moves only partial checkouts aside (P5.5).
4. Otherwise start `ServerService`. It runs `start.sh`, which self-updates (gated by min-app-version, §3.2), installs dependencies if needed, runs `init`, and starts the server.
5. Poll the server's health (with the launch-token cookie). When it is ready, load the WebView.

### 2.5 Environment set by the app for `start.sh` / `install.sh`

| Variable | Value / purpose |
|---|---|
| `SILLYBUNNY_ANDROID_APP` | `1`: enables APK mode in the scripts (§3.1) |
| `SILLYBUNNY_ANDROID_APP_VERSION_CODE` | installed APK versionCode (for the min-app-version gate) |
| `SILLYBUNNY_ANDROID_STATUS_DIR` | `filesDir/status` |
| `SILLYBUNNY_LAUNCHER` | already exported as `1` by `start.sh:330`; host updates request exit 77→75 and the launcher loop relaunches the supervisor (`src/endpoints/server-admin.js:392-416`) |
| `SILLYBUNNY_LAUNCH_TOKEN` | 32 random bytes (hex), regenerated each time the app starts the server (§3.3) |
| `SILLYBUNNY_AUTO_UPDATE` | from the native setting (default on) |
| `SILLYBUNNY_USE_NODE=1` | Node only for APKs; leave `SILLYBUNNY_USE_BUN` and `SILLYBUNNY_BUN_SMOL` unset (§9.10) |
| `SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH=1`, `SILLYTAVERN_BROWSERLAUNCH_ENABLED=false` | no browser launch from the server (config-to-env mapping: `src/util.js:36-42, 92-113`) |
| `SILLYTAVERN_LISTEN=false` | enforce localhost-only even if the user edits `config.yaml` (LAN is out of scope for v1) |
| `PATH` | `filesDir/runtime/bin:/system/bin`; no `bun` executable/symlink, because the in-app updater selects `bun install` whenever it finds `bun` (§3.4) |
| `npm_config_script_shell` (optional note) | npm runs `sh` from `PATH`, not `/bin/sh`; keep `/system/bin` on `PATH` or point this variable at the bundled bash |
| `HOME`, `TMPDIR` | `filesDir/home`, `cacheDir/tmp`; create writable directories before spawning |
| `LD_LIBRARY_PATH` | `nativeLibraryDir` |
| `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR` | `filesDir/runtime/libexec/git-core`, `filesDir/runtime/share/git-core/templates` |
| `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1` | isolate compiled-in Termux system config and attributes |
| `GIT_SSL_CAINFO`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` | `filesDir/runtime/etc/certs/cert.pem` |
| `OPENSSL_CONF`, `OPENSSL_MODULES` | `/dev/null`, `filesDir/runtime/openssl-modules` (empty; no optional providers/engines) |
| `LD_PRELOAD`, `BASH_ENV`, `ENV` | unset before spawning; no inherited Termux preload or shell startup file |
| `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` | fixed neutral local identity `SillyBunny` / `sillybunny@localhost.invalid` (S2.5) so `git stash` works (`autoStashBeforePull`, `src/endpoints/server-admin.js:1062-1078`) |
| `SILLYBUNNY_ANDROID_NPM_CLI`, `SILLYBUNNY_ANDROID_NPX_CLI` | paths used by the npm/npx trampolines |

Pass the server port as `start.sh -- --port <P>` (an argument, not an environment variable). Start from an empty environment except the inherited Android framework roots (`ANDROID_ROOT`, `ANDROID_DATA`, `ANDROID_TZDATA_ROOT`, plus `ANDROID_ART_ROOT` and `ANDROID_I18N_ROOT` on API 36+), which S2.5 kept on every API. Invoke bundled Bash with `--noprofile --norc` for both launchers. Preserve deliberate app-owned Git configuration/identity; P4-T's hook/global-config/automatic-maintenance disabling was test isolation, not the production contract (P4-T, §6).

---

## Context & Decisions (summary; the full Q&A is in Appendix A)

| Decision | Rationale | Source |
|---|---|---|
| APK = runtime host + git installer; the code is a real git checkout updated by `start.sh` | Matches v2.0.0 exactly. Extensions, plugins and Server Tools work unchanged | Round 1 Q1; `scripts/self-update.sh`, `start.sh:182-375` |
| targetSdk/compileSdk = latest (37); minSdk 29 | Must not break on future Android. Android 10+ blocks running files from app data, so programs ship as `lib*.so` in nativeLibraryDir | Round 1 Q2; https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission |
| Bundle the real git (pinned Termux package), not isomorphic-git | Extension update/branch, the plugin loader/updater and self-update all use system git | Round 1 Q3; `src/endpoints/extensions.js`, `src/plugin-loader.js:359-421`, `src/server-plugin-manager.js:688-711` |
| Node built from upstream source with the NDK, in CI, stored in GHCR | Termux's Node is patched to use Termux's `sh` path. Upstream Node on Android uses `/system/bin/sh`. Hours of CI only when the pins change | Round 2 Q2, Round 3 Q1; https://github.com/nodejs/node/blob/main/BUILDING.md#android, https://github.com/Sanitised/ST-android |
| git + bash from repackaged pinned Termux packages | Proven by TavernDroid/VSCodroid. Fast | Round 2 Q2; https://github.com/S0ul-Sh3ll/TavernDroid, https://github.com/rmyndharis/VSCodroid |
| nodejs-mobile / Capacitor-NodeJS rejected | Stuck on Node 18.20.4 (below `engines.node >= 20`). No child_process, no in-process restart | https://github.com/nodejs-mobile/nodejs-mobile/releases (verified) |
| Node-only APK for now; Bun bundle deferred | Confirmed 2026-10-21; S2.4 found startup/16 KB and unchanged install-policy failures. Revisit gates in §9.10; non-APK Bun support unchanged | Maintainer agreement relayed by user 2026-10-21; S2.4 (`s24-bun.md`, §§4, 6); supersedes Round 1 Q13 / Round 2 Q11 |
| npm/npx via native trampolines on PATH | Scripts and server code look for `npm` by name. Scripts in app data can't be executed directly. No base-code change | Round 2 Q3 |
| Reuse `install.sh` / `start.sh` via the bundled bash in an APK mode | One source of truth for update behaviour. Helpers are already run as `bash script.sh` (`start.sh:186-196`) | Round 2 Q4 |
| Data/config stay inside the checkout | Same as every other install, so no special-case code | Round 2 Q5; `src/command-line.js:54-60` |
| min-app-version gate before any git update | Code needing a newer runtime must not brick the app | Round 2 Q6 |
| Launch-token gate for localhost | Same-profile apps can reach 127.0.0.1; Android 17's cross-profile block does not remove that threat. The default user is admin with no auth | Round 1 Q8; R2 §2; `default/config.yaml:58-115`, `src/users.js:979-989`, `src/constants.js:59-67` |
| WebView by default + "Open in browser" | Integrated, with a browser escape hatch | Round 1 Q9 |
| Foreground service (`specialUse`) with Stop | Long generations survive switching apps | Round 1 Q11; https://developer.android.com/develop/background-work/services/fgs/service-types |
| Minimal native UI | The phone UI lives in the SillyBunny web app | Round 1 Q12 |
| `allowBackup=false`, `hasFragileUserData=true`, file-manager provider (`data/` + `config.yaml`), existing SB backup | `data/` holds `secrets.json`. App data is wiped on uninstall | Round 1 Q14, Round 3 Q5 |
| Android code lives in `android/` in the main repo; APKs are attached to normal releases | First-party install method, shipped alongside the desktop installers | Round 1 Q4 |
| Package `io.github.sillybunnyteam.sillybunny`, display name "SillyBunny" | Permanent identity | Round 1 Q5 |
| CI signing in a protected environment | Automation, with the implications explained to TheLonelyDevil (§6.4) | Round 1 Q6 |
| Stay **unregistered** with Google developer verification for now | Small project scope. **Caveat: needs confirmation (§9)** | Round 1 Q7; https://developer.android.com/developer-verification/guides (verified) |
| Independent APK versionCode; stable asset names; `android-update.json` manifest; byte-identical re-attach when unchanged | Users are only asked to update when the APK actually changes | Round 2 Q7 |
| Update check on launch, non-blocking, native dialog | Seamless; no web UI changes in v1 | Round 2 Q8 |
| RC builds clone `staging`; stable builds clone `release` | The `release` branch lacks the APK hooks until stable | Round 4 Q2 |
| Native Repair; never deletes data automatically | Recovery path without uninstalling | Round 4 Q1, Round 3 Q3 |
| CI emulator smoke automates the full end-user procedure; team does manual device tests | Release gate | Round 3 Q2, Round 4 Q3 |
| One PR: `feat/android-apk` → `staging`. First test tag `v2.0.0-rc.1`, then `v2.0.0` | AGENTS.md "one cohesive larger PR for a feature" | Round 3 Q10, Q11 |

---

## 3. Base repository changes (SillyBunny scripts and server)

All changes must be inert unless their env var is set, so other installs keep their exact current behaviour.

### 3.1 APK mode in the launcher scripts

Files: `start.sh`, `scripts/self-update.sh`, `scripts/bootstrap/install.sh`, `scripts/install-prerequisites.sh` (and anything they source).

When `SILLYBUNNY_ANDROID_APP=1`:
- **Skip the prerequisites installer entirely.** The APK provides git, node, npm and bash, not Bun. `install-prerequisites.sh` uses download, archive, checksum and package-management commands that may not exist on Android (full inventory in B.1).
- **Skip Termux detection and the shared-storage check** (`start.sh:22-24, 26-39, 52-58, 157-162, 213-216, 257-259`); these already stay inactive without a Termux env.
- **Runtime selection:** the APK host sets `SILLYBUNNY_USE_NODE=1` and leaves Bun overrides unset (§2.5). Preserve the launcher's existing override support for other installs; do not trigger ARM/macOS auto-switch messages in APK mode.
- **`install.sh` runs non-interactively** when given flags or when stdin is not a TTY; the wizard requires both a TTY and no arguments. Its three `curl` hits are comments, not commands.
- **Verify tool availability.** Check every external command the APK-mode path calls on API 29, API 36 and API 37 emulators. Baseline inventories (git/bash/runtimes are bundled; other commands must be in toybox or bundled):
  - `start.sh` in the Node-only APK: `dirname`, `tr`, `uname`, `git`, `bash`, `node`, `npm`; `mkdir` is Termux-only. No standalone `date` or `diff` (`git diff` is a git subcommand).
  - `install.sh`: `cat`, `grep`, `ls`, `git`, `bash`, `mkdir`, `cp`, `dirname`, `basename`, `head`, `sed`, `tr`, `uname`; git bootstrap can also call `sudo`, `pkg`, `xcode-select`, `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, `apk` (skipped in APK mode). No `tail` or `curl` command.
  - The implemented APK shell gate additionally calls `mkdir`, `mv`, `rm`; the APK installer skips wizard/platform/package-manager paths, and the prerequisites script runs no external commands in APK mode.

  Anything missing gets bundled from Termux (e.g. `busybox` or `coreutils`) and added to `runtime/bin`. **Verified (S2.5):** with `PATH=runtime/bin:/system/bin`, every command above resolves on API 29/36/37 (toybox 0.8.0/0.8.12/0.8.13). Only the skipped package-manager/prerequisite commands, the comment-only `curl` and the deliberately absent `bun` are missing, so no gap-filler is needed. OEM toybox builds remain **UNVERIFIED**.

Add short inline comments at each APK-mode branch (AGENTS.md rule for diverging base files).

### 3.2 min-app-version gate (blocks git updates that need a newer APK)

- **The file:** add `android/min-app-version`, containing a single integer: the minimum APK versionCode the code at that commit needs. It starts at the first APK's versionCode.
- **Shell gate** (`scripts/self-update.sh`, APK mode only): after `git fetch` and before fast-forwarding:
  1. Resolve the upstream SHA once and read `git show "<sha>:android/min-app-version"`. Missing or invalid files block instead of defaulting to 0, because those branches predate the launch-token and update gates (**needs maintainer confirmation**, §9).
  2. If the minimum is newer, missing or invalid: skip the update, log `lorum ipsum`, and write `$SILLYBUNNY_ANDROID_STATUS_DIR/update-blocked.json` = `{"required":N|null,"installed":M,"reason":"newer|missing|invalid","upstream":"<sha>","branch":"<name>"}`.
  3. In optional mode, exit 0, so the server still starts on the current code.
  4. Remove the file when no block applies.
- **Checked-commit pinning:** the shell and server update paths merge exactly the checked SHA; server runtime-branch switches check out that SHA and retain the resolved remote as upstream (`577a50968`, `fd037cbd7`; P3-B). The ordinary `git.checkout(branch)` fallback remains unchanged after the gate.
- **Server gate.** The in-app updater bypasses `self-update.sh`, so the same check is needed on the server side:
  - Add a small self-contained module (e.g. `src/android-app-gate.js`) that is a no-op unless `SILLYBUNNY_ANDROID_APP=1`.
  - **`POST /api/server-admin/update`** (`src/endpoints/server-admin.js:1044-1141`): check the tracking branch's minimum after the final fetch and before merging.
  - **`/switch-branch`** (`src/endpoints/server-admin.js:1177-1260`): check the resolved remote branch (not necessarily `origin/<branch>`) or requested local fallback before either checkout path; restore request-owned auto-stashes on a block.
  - Return HTTP **409** with `code: android_app_update_required`; Server Tools hides the supplied message of every 403. Any new UI string is `lorum ipsum`.
- **Not gated:** extensions and server plugins.
- **Release safety:** a CI check fails the release if `android/min-app-version` is greater than the versionCode of the APK attached to the same release (§6.2).
- **Tests:** Jest unit tests in `tests/` for the gate module (allowed, blocked, missing/invalid file, checked-commit pinning, non-APK mode no-op).

### 3.3 Launch-token gate (localhost hardening)

**Why it's needed:** apps in the same profile can reach loopback. Android 17 blocks cross-profile loopback by default, but does not remove the same-profile threat (R2, §2). With SillyBunny defaults:
- whitelist on, allowing `127.0.0.1`, `::1`, `172.16.0.0/12` and `192.168.0.0/16` (`default/config.yaml:59-70`)
- basic auth only applies when `listen: true` (`src/server-main.js:200-202`)
- accounts disabled, so the default user is admin (`default/config.yaml:108-115`, `src/users.js:979-989`, `src/constants.js:59-67`)

So **any installed app in the same profile can call the admin endpoints** (update, branch switch, extension and plugin install, which amount to running arbitrary code, and reading API keys). CSRF doesn't help, because a local client can fetch `/csrf-token` (`src/server-main.js:322-377`).

Spec:
- **Module:** new self-contained middleware `src/middleware/launchToken.js`, following the existing middleware pattern (`src/middleware/whitelist.js:57-104`). It is enabled **only** when `process.env.SILLYBUNNY_LAUNCH_TOKEN` is non-empty, so it is inert for every other install.
- **Mounting:** in `src/server-main.js`, immediately after helmet and before the whitelist, basic auth, session/user middleware and static files, with an inline comment. It applies to every route, including static files. The Phase 3 search found no HTTP WebSocket upgrade handler in `src/`.
- **What it accepts:** a request passes if it carries the cookie `sillybunny_launch=<token>`, compared in constant time with `crypto.timingSafeEqual` (Node + Bun). Otherwise the server replies `403` with a minimal body.
  - **Cookie flags:** `HttpOnly`, `SameSite=Strict`, `Path=/`. Not `Secure`, because this is plain http on localhost.
- **Browser handoff endpoint** (`GET /__sillybunny/handoff?c=<code>`), used by "Open in browser" and optionally by the WebView:
  - **Code format:** 16-byte random nonce, 8-byte unsigned big-endian Unix expiry milliseconds, then HMAC-SHA256 keyed with the UTF-8 token over `ASCII("handoff") || nonce || expiry`; encode all 56 bytes as unpadded base64url (75 characters).
  - **Validity:** expires within 60 s; the nonce is single-use and tracked in memory.
  - **Response:** sets the cookie and answers `200` with a minimal page that moves to `/` by `<meta http-equiv="refresh">`. Not a `302`: Chrome does not send the `SameSite=Strict` cookie on the redirect of a navigation that another app started, so Open in browser landed on the 403 (P5.6).
  - **No token in the URL:** the long-lived token itself must never appear in a URL.
- **WebView:** set the cookie via the asynchronous `CookieManager.setCookie("http://127.0.0.1:<port>", ..., callback)` on the UI/Looper thread and require success before loading, or use the handoff URL. `flush()` persists cookies; it is not the async completion barrier. Cookies are not port-isolated; §4.5 must review other-localhost-port exposure, not claim navigation callbacks contain every cookie (R2, §4).
  - **Verified (P5.6):** the app sets the cookie for its per-install origin `http://sb-<label>.localhost:<port>` (§4.5), not for `127.0.0.1`. The native HTTP clients still connect to `127.0.0.1:<port>` and send the cookies stored for that origin.
- **App health probe:** `GET /__sillybunny/health` returns **204** with a valid launch cookie (403 without it).
- **Compatible with account logins:** the gate is independent of `enableUserAccounts`, `perUserBasicAuth` and `basicAuthMode`. If accounts are on, users log in normally after passing the gate. Do not touch the `cookie-session` cookie.
- **Cookie clearing:** `/api/cookies/clear` skips `sillybunny_launch` when the gate is enabled; account/session clearing remains unchanged.
- **Token lifetime:** the supervisor's child inherits the env, so the token is stable for the lifetime of one `start.sh` run. A new token is issued each time the app starts the server.
- **Tests (Jest, `tests/`):**
  - disabled when the env is unset
  - 403 without the cookie, 200 with it
  - handoff success, expiry and replay rejection
  - with accounts enabled, login still works behind the gate

### 3.4 Things that need no base change (verify only)

- **git found by name:** `simple-git` and `command-exists` find `git` on `PATH` (`src/git/client.js:25`, `src/util.js:141`). The symlink in `runtime/bin` covers this. `command-exists` runs `command -v` through a shell. Upstream Node on Android uses `/system/bin/sh` for `shell: true` (confirmed in v24.22.0 `lib/child_process.js`).
- **npm found by name:** `npm` is looked up by name in `start.sh`, `src/endpoints/server-admin.js:552-631` (`npm ci --omit=dev`) and `src/server-plugin-manager.js:688-711, 713-864` (`npm ci --omit=dev --ignore-scripts`). The trampoline covers all of these. The in-app updater's `getInstallCommand` chooses `bun install` whenever `bun` is on `PATH`, even under Node, so keep Bun off the APK's PATH (§2.5); other installs are unchanged.
- **Platform checks:** the server already handles `process.platform === 'android'` (`src/server-main.js:637`, `src/endpoints/characters.js:43`) because Termux's Node reports `android`. Upstream Node built for Android reports `android` too.
- **Data location:** `data/` and `config.yaml` stay in the checkout (gitignored, `.gitignore:24, 54`).

---

## 4. Android app (`android/`)

### 4.1 Project basics

- **Project:** a Gradle project at `android/` with a committed Gradle wrapper. Kotlin + Jetpack Compose, minimal Views.
- **Kept separate from the JS tooling:** it is not covered by the root npm scripts or ESLint, the same as `src/electron/`. Add Android lint to CI.
- **SDK levels:** `minSdk 29`, `targetSdk` and `compileSdk` = latest stable (Android 17 / API 37 as of 2026-10-20).
- **Build pins (R2, §1):** SDK package `platforms;android-37.0` (not `android-37`), Build Tools `37.0.0`, NDK `30.0.16248370`, build JDK 21; AGP `9.4.1`, Gradle `9.6.0`, Kotlin/Compose compiler plugin `2.4.21`. Use AGP 9's built-in Kotlin, explicitly upgrade its runtime KGP classpath, and do not apply `org.jetbrains.kotlin.android`; the Compose BOM does not pin the compiler.
  - **Build-verified integration (P5.1):** AGP `9.4.1` + Gradle `9.6.0` + Kotlin/Compose compiler `2.4.21` (runtime KGP resolved to `2.4.21`) pass debug/release builds and Android lint, so no fallback is needed. Kotlin's fully supported matrix still ends at AGP `9.3.1`; if staying within that matrix is mandatory, use AGP `9.3.1` / Gradle `9.5.0` / Kotlin+compiler `2.4.21`, still API 37-capable. Match Java/Kotlin bytecode targets (e.g. 17) separately from build JDK 21; do not suppress obsolete-AGP compile-SDK warnings.
  - **UI pins:** Compose BOM `2026.09.00` (Material3 `1.4.0`, UI/runtime `1.12.1`), Activity Compose `1.13.0`, Core KTX `1.19.1`, Lifecycle runtime-compose/viewmodel-compose `2.11.0`, WebKit `1.18.0`. Leave BOM-managed library versions unset and import the BOM for instrumentation dependencies too when used. DocumentFile `1.1.0` is optional, not a DocumentsProvider requirement. R2 verified metadata/POM availability, not transitive resolution or the exact BOM announcement day.
- **IDs:** `applicationId io.github.sillybunnyteam.sillybunny`. Debug and test builds use the suffix `.debug` and a test signing key.
- **Packaging:**
  - `packaging.jniLibs.useLegacyPackaging = true`, deliberately compressing/extracting binaries to `nativeLibraryDir`; minSdk 29's default would keep them uncompressed. Set the Gradle option, not a competing manifest `extractNativeLibs`; no obsolete `android.bundle.enableUncompressedNativeLibs=false` workaround (R2, §1).
  - Per-ABI APK splits: `arm64-v8a`, `armeabi-v7a` and (CI only) `x86_64`.
- **16 KB pages:** check ZIP offsets with `zipalign -c -P 16 -v 4`, separately from every bundled executable/dependency ELF using NDK `llvm-readelf -lW`. Compressed ZIP entries passing proves no ELF compatibility. Require 16 KB `PT_LOAD` alignment/congruence, valid RELRO layout and page-size-independent code; `zipalign` cannot repair incompatible ELFs, which need relinking. For RELRO sharing a LOAD with following writable data, require `(p_vaddr+p_memsz)%0x4000 == 0`; isolated-LOAD rules differ and RELRO `p_align=1` alone is not failure (R2, §1; https://developer.android.com/guide/practices/page-sizes).
  - NDK r28+ defaults arm64/x86_64 to 16 KB alignment; verify all prebuilts and native add-ons too. P4-T's ARM32 payload deliberately remains 4 KB-aligned; this is not satisfaction of an all-ELF 16 KB gate (§10). Test actual `PAGE_SIZE=16384` and 4 KB environments; x86_64 tests/Android 16 compatibility mode do not replace physical arm64 validation (R2, §2; P4-T, §§5–6).
- **Version:** `versionCode` / `versionName` come from `android/app-version.properties`. Humans bump them in PRs; CI enforces the rules in §6.2.
- **BuildConfig:**
  - `DEFAULT_REF`: `staging` for prerelease builds, `release` for stable (set by CI, §6.2)
  - `REPO_URL`: the official `https://github.com/SillyBunnyTeam/SillyBunny.git`
  - debug/test builds only: a repo URL and update-manifest URL override, so CI can use fixtures
- **Icon:** a **placeholder** adaptive icon. The real logo comes from a future design plan in PR #870. Don't spend effort on icon design.
- **Target-37 UI:** use AndroidX/Compose insets and predictive-back handling; test edge-to-edge, keyboard/IME after rotation, large-screen resizing and gesture/button navigation. Target 36 removes edge-to-edge opt-out/legacy back interception; target 37 removes large-screen orientation/resizability opt-outs (R2, §2).

### 4.2 Manifest

- **Permissions:**
  - `INTERNET`, `ACCESS_NETWORK_STATE`
  - `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`
  - `POST_NOTIFICATIONS`
  - `REQUEST_INSTALL_PACKAGES`
  - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (allowed because the app isn't on Play)
- **`<application>` attributes:**
  - `android:allowBackup="false"`, plus `dataExtractionRules` that exclude everything (Android 12+)
  - `android:hasFragileUserData="true"`
  - explicit network security config: base cleartext denied; exact `127.0.0.1` domain allowed for API 29–36. Android 17's implicit localhost exemption does not replace this; NSC is host-, not port-scoped and `usesCleartextTraffic` is ignored when NSC is present (R2, §2)
- **Network scope:** no LAN listener in v1 remains the decision. Outbound Node backends on LAN still need dangerous `ACCESS_LOCAL_NETWORK` on Android 17/target 37, covering native children and WebView; Android 16 protection is opt-in. Request it only for actual LAN use, not same-profile loopback; do not request non-public `USE_LOOPBACK_INTERFACE`. Permission-denied OEM loopback behavior remains **UNVERIFIED**. NSC is not a firewall for native Node/git/curl sockets; keep loopback binding/authentication separate (R2, §2).
- **`ServerService`:** `foregroundServiceType="specialUse"`, with child property `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE` (`lorum ipsum`, a free-form explanation). Promote with the API 34 type only on API 34+; no specialUse runtime-permission prerequisite (R2, §2).
- **`DataDocumentsProvider`** (§4.8): authority `${applicationId}.documents`, exported/grantable, protected by provider `android:permission="android.permission.MANAGE_DOCUMENTS"` and action `android.content.action.DOCUMENTS_PROVIDER`. Do not request `MANAGE_DOCUMENTS` as an app permission (R2, §7).
- **Receiver** for `ACTION_MY_PACKAGE_REPLACED` (§5.6).

### 4.3 First-run flow (native screens; all copy is `lorum ipsum`)

1. **Welcome.** Ask for notification permission (Android 13+); denial must not block installation/server startup. Offer the battery-optimisation exemption (optional, never forced, also available in Settings). An FGS still requires its notification when permission is denied, though only Task Manager may show it (R2, §2).
2. **Preflight:**
   - free storage check: require `FirstRunStorage.REQUIRED_FREE_BYTES`, 1,341,351,936 B (about 1.34 GB): the measured peak plus 50% (P2.6). On x86_64 emulators (API 37 with 16 KB pages, API 29), sampled every 2 s from Welcome through the first start's `npm ci` to the loaded UI, the app's data directory only grew, so its peak is its installed size: 868–894 MB by `du` (`df` saw 735–761 MB; `du` counts 8 KiB for each small file where `df` uses 4 KiB). It holds the checkout, 716 MB (`node_modules` 463 MB, `.git` 82 MB), `home/` with the npm cache, 110 MB, `runtime/`, 34 MB, and up to 33 MB of caches (the WebView's and Node's compile cache). The extracted natives (113 MB on x86_64) arrive with the APK, before the check. The margin covers later growth of the repository and the npm tree, and other file systems
   - network check; on a metered or mobile connection, show a warning with the **measured** estimated download size (clone + `npm ci`) and let the user continue. P2.6 measured the clone at 80.6–80.7 MB and the first start's `npm ci` at 98.5–98.7 MB, 179.1–179.3 MB together, cloning `feat/android-apk` on x86_64 (per-UID netstats); S2.5's standalone `npm ci` with audit traffic received up to 108 MB
3. **Lay out the runtime** (§2.2).
4. **Install.** Run `libbash.so install.sh --no-start --dir filesDir/SillyBunny --ref BuildConfig.DEFAULT_REF --use-node` with the APK-mode env (§2.5), and show streamed progress and log output; no runtime picker while Bun is deferred.
5. **On success:** start `ServerService` → WebView.
6. **On failure:** an error screen with Retry, View/Share logs, and Repair (if a partial checkout exists). **Never delete a partial checkout automatically. Move it aside** (same rule as Repair).

There is **no branch picker**; branches are switched via Server Tools in the web UI (Round 2 Q13).

**Lifecycle (R2, §2):** let an FGS own runtime/clone/npm work that must survive backgrounding. Start it from a visible activity/user action, promote promptly after service start, then run I/O off-main. Recheck visibility after asynchronous preflight; a fresh background start needs an exemption. The promotion deadline starts at service start, not clone start; activity-owned installation alone is not a deadline violation.

### 4.4 `ServerService` (foreground service)

- **Starting:** start from a currently visible activity/user action; recheck after async work, then promptly promote with API-aware `ServiceCompat.startForeground` (§4.3). Android 12+ background-start limits otherwise apply unless exempt (R2, §2).
- **Notification:** ongoing, with a **Stop** action (`lorum ipsum` copy).
- **Running:** `ProcessBuilder` starts bash running `start.sh` with the env from §2.5. stdout/stderr go to `filesDir/logs/` (rotated, size-capped) and to the in-app log view.
- **Exit handling:**
  - Exit 75 is handled inside `start.sh`'s loop.
  - A user-requested Stop or a clean exit (0) leaves the server stopped.
  - **An unexpected exit or the process being killed** (out of memory, battery-manager kill) triggers an automatic restart with backoff, **at most 3 times within 5 minutes**. After that, show an error screen with the last N log lines and **Restart** / **Share logs** (Android share sheet, with a `lorum ipsum` warning that logs may contain sensitive details).
  - Distinguish child exit from whole-host death: an in-memory loop cannot run while the host is dead; `START_STICKY` recreation may have a null intent and no latency guarantee. Preserve the bounded-recovery policy without resurrecting a user-stopped server from jobs/alarms. Android 13 Task Manager Stop has no callback; guard exit-history APIs at API 30, and do not treat ambiguous `REASON_USER_REQUESTED` as a reason to reject a fresh explicit launch (R2, §2).
- **Data safety:** restarts and recovery **never** touch `data/` or `config.yaml`, never re-clone, and never run Repair on their own.
- **Stopping:** SIGTERM the supervisor first (the graceful IPC path), then SIGTERM the process group, then SIGKILL after a timeout. Group SIGTERM alone removed every process in ≤151 ms in S2.5 but does not prove graceful IPC delivery (§2.3). This matches the supervisor's 5 s force-kill (`src/server-supervisor.js:31`).
- **Health check:** poll `GET /__sillybunny/health` with the launch-token cookie until it returns 204, but only after the server child itself prints `is listening on … IPv4: 127.0.0.1:<port>` for the session port. Before that line another app could hold the port and receive the token. Polling pauses while the supervisor replaces that child (P5.4 review; `tests/android-listener-announcement.test.js` pins the line). A challenge-response check that never sends the token would remove the residual races, but it needs a server change (§10).
- **Node on Android (S2.1):** `process.getuid`/`geteuid`/`getgid`/`getegid`/`getgroups` do not exist on Android builds; read `/proc/self/status` for identity. Node's native stderr output, including uncaught-exception and fatal-error reports, goes to logcat tag `nodejs`, not to captured stderr, so log capture must also collect the app's own `nodejs` logcat entries or install its own reporter (S2.1, §6).
- **Platform limits:** the six-hour/24-hour timeouts for `dataSync`/`mediaProcessing` do not apply to `specialUse`; this is not an uptime/Doze/OEM-survival guarantee. Android 16 job quotas still affect WorkManager/JobScheduler/DownloadManager, not a documented timer on ProcessBuilder children (R2, §2).

### 4.5 WebView screen

- **Loading:** load `http://127.0.0.1:<port>/` (port from `config.yaml` / default 4444; read it via config or use a fixed env override, decided in the Phase 2 spike) with the launch-token cookie set first.
  - **Verified (P5.6):** the app loads a per-install origin, `http://sb-<label>.localhost:<port>/` (`web/WebAddress.kt`). The label is 16 random bytes in lowercase base32, kept out of backups, device transfer and logs. Chromium resolves `*.localhost` to loopback itself, also offline, and treats the origin as a secure context. The network security config allows cleartext to `localhost` and its subdomains.
- **Settings:** explicitly enable JavaScript and `domStorageEnabled`; use a persistent WebView profile. IndexedDB does not need deprecated WebSQL `setDatabaseEnabled`. Keep file/universal-file access disabled, including for Blob handling (R2, §4). Keep the app origin/profile/port stable so drafts, LocalForage caches and QIG IndexedDB/localStorage remain reachable; test Web Locks/quota (QIG durable mutation falls back to session-only without locks/IDB). AccountStorage is server-backed, not IndexedDB (S2.7b, §3; R2, §2).
- **WebView debugging:** enabled **only in debug builds**.
- **File uploads:** `WebChromeClient.onShowFileChooser` → SAF. The audit found 53 input declarations, 15 `multiple`, none capture/directory; preserve dynamic/hidden inputs, MIME/display-name/extensions and all returned `ClipData` URIs. Use `ACTION_OPEN_DOCUMENT` + `CATEGORY_OPENABLE` for open/single/multiple; extension-only or literal `*.json` filters need permissive fallbacks, not restrictive guessed MIME (S2.7b, §3).
  - Complete the owned callback with URI array or `null` exactly once; cancel replaced/abandoned requests. Handle save via `ACTION_CREATE_DOCUMENT`, API 37 folder via `ACTION_OPEN_DOCUMENT_TREE`, and API 37 editable-original permission modes with the required grants or cancel; guard new APIs and cancel unsupported modes. Validate source authorization, reject `file:`/sensitive own-provider targets, and use only returned grants; readability alone is insufficient. No broad storage permission or filesystem-path conversion (R2, §4).
  - Test blank/octet-stream MIME, Unicode/extension-only names, cloud URIs, cancellation and async/command-driven activation. DOM file paste/drop does not invoke the chooser; retain its handlers and touch-picker fallback (S2.7b, §§3, 6).
- **Downloads:**
  - `setDownloadListener` reports HTTP(S) metadata, not bytes, and omits the anchor's suggested filename. Capture the name in JavaScript where needed; use an app-owned streaming fetch to a user-selected SAF destination with MIME/user agent and explicit WebView cookies (including `sillybunny_launch`) only for the exact app origin. Check redirects, never forward cookies cross-origin/other-port, and do not replay POST as GET (S2.7b, §3; R2, §4).
  - Install feature-gated document-start interception before page scripts, covering detached/programmatic anchor clicks as well as DOM clicks. Core helpers/backups revoke Blob URLs immediately after `click()`; retain the Blob or start dereferencing in that click path before revocation/SAF delay, then stream asynchronously. Cancel browser handling after native capture to avoid duplicate saves; native DownloadManager cannot resolve Blob/data URLs. Bound `data:` decoding and queue/cancel/clean up concurrent exports; do not marshal whole backups as one base64 message (S2.7b, §3; R2, §4).
  - **Proposed bridge:** prefer `addWebMessageListener`, feature-gated by `WEB_MESSAGE_LISTENER`, with exact `http://127.0.0.1:<actual-port>` allowlist plus checked `sourceOrigin` and `isMainFrame`. Gate document-start/array-buffer support separately. Offer Open in browser if unsupported, not a frame-blind `addJavascriptInterface` fallback. Permit only narrowly scoped saving to a user-selected `ACTION_CREATE_DOCUMENT` URI, never JS-chosen native paths/URIs; use ordered bounded chunks, acknowledgements/backpressure, total limits, timeout/navigation cancellation and off-main writes. Safe bounds/complete interception remain **UNVERIFIED**; same-origin malicious scripts remain able to call the bridge (R2, §4).
  - The five server attachment responses also serve backup/character fetch-to-Blob, chat-backup preview/restore, and content importURL/importUUID. Headers must not create unsolicited or duplicate saves. Data Maid/Conversation HTTP download links may lack attachment headers; acquire Data Maid responses before a delayed picker outlives the dialog token. Preview/TTS/background Blob URLs are not downloads (S2.7b, §3).
- **Links/popups:** keep only the exact app scheme/host/port in-app; external main-frame HTTP(S) → `Intent.ACTION_VIEW`, with an independent scheme policy for other links. Handle `window.open`/`_blank` via `onCreateWindow` if multiple windows are enabled; process Blob/data exports before generic routing and never expose the bridge to external pages/popups or opaque-origin card frames. OpenRouter uses top-level external auth, not an opener popup; define an authenticated return/handoff across separate browser/WebView profiles (S2.7b, §3).
  - **Verified (P5.6):** OpenRouter's page loads in-app only when the app origin starts the flow to exactly `https://openrouter.ai` with one `callback_url` of `<app origin>/callback/openrouter`. The app cancels the return navigation and loads `/?source=openrouter&query=...` itself, the same target as the server's `307`, so the request carries the launch cookie. The provider page gets no bridge, page script, downloads, file chooser or permissions, and no path is exempt from the gate. Sign-ins that leave openrouter.ai (GitHub, X, LinkedIn) open in the browser. In the external browser the return gets a `403`, because a cross-site navigation does not send the `SameSite=Strict` cookie. A real sign-in was not run (it needs an account). The key exchange also fails in every browser until the frontend reads the verifier after `accountStorage` is ready: `readSecretState()` calls `checkOpenRouterAuth()` before `getSettings()` initialises it.
- **Cookie containment:** navigation callbacks exclude some POSTs/app loads/subresources and resource redirect destinations. Review those plus external-browser handoff and other localhost ports; `HttpOnly`/`SameSite=Strict` do not supply port isolation, and browser-held cookies are outside app navigation controls (R2, §4).
  - **Measured (P5.6):** on WebView 145 (API 37) and 74 (API 29), the label host's cookie reached no other port addressed as `127.0.0.1`, `localhost` or another `*.localhost` name, by any request kind or redirect hop. Only the label host on another port receives it, through redirect hops and WebSocket handshakes from the app, and a local listener needs the label for that. The label leaves the app in the `Origin` header of the page's CORS and WebSocket requests and in OpenRouter's `callback_url`. Because the label origin passed these measurements, the in-app loopback proxy was not built.
- **Back button:** exit a fullscreen custom view first, then use AndroidX/Compose BackHandler/PredictiveBackHandler only while WebView has history, otherwise normal back-to-home (server keeps running); no legacy key interception (R2, §2; S2.7b, §3).
- **"Open in browser":** a menu or toolbar action. The app computes the handoff code itself (§3.3) and opens `http://127.0.0.1:<port>/__sillybunny/handoff?c=...` in a browser in the same profile; Android 17 blocks cross-profile loopback by default (R2, §2).
  - **Verified (P5.6):** the intent URL is `http://<label>.localhost:<port>/__sillybunny/handoff?c=<code>`. It carries the label and a single-use 30-second code, never the token. Whoever handles the intent can redeem the code once and so obtain the token. The browser then keeps the token as a host-only session cookie for `<label>.localhost`. Chrome 145 on API 37 sent it to that host on every port and to no other host, so another local app needs the label to collect it. The cookie lasts until the browser drops its session cookies, and the token is valid for the whole server run. Before the label origin, Chrome sent a `127.0.0.1` cookie to every `127.0.0.1` port.
- **Clipboard:** test text copy/read and PNG ClipboardItem writes, including async/command-driven gesture failures. Some existing helpers fall back only when the API is absent, not after rejection; generic media permission does not grant clipboard access (S2.7b, §3).
  - **Measured (P5.6a):** on WebView 74, async `writeText` and `readText` reject, and the frontend's copy helper does not fall back after a rejection. On WebView 145, a PNG `ClipboardItem` write resolves but leaves the Android clipboard empty. v1 ships both as known limitations; the frontend is unchanged.
- **Service workers/dialogs:** test `/sw.js` registration/cache and cookie-preserving restart/clear flows without blanket storage purges (TTS model caches and QIG gallery differ). Preserve JS alert/confirm/prompt/beforeunload results; unload is not a reliable Android shutdown signal (S2.7b, §3).
- **Media:** test asynchronous TTS/audio, speechSynthesis, AudioWorklet/worker/WASM, audio focus/gesture setting and background audio; provide custom-view fullscreen/Back callbacks. Grant only explicitly allowed, requested resources from the trusted origin after Android permission; no shipped camera/microphone requirement was found. Foreground server service alone does not keep suspended WebView reminder timers running. Target-37 background-audio capability must be tested after a qualifying user start (S2.7b, §3; R2, §2).
  - **Measured (P5.6a):** `speechSynthesis` is absent in WebView 74 and 145, so System TTS cannot work in the APK. v1 ships this as a known limitation.
- **Minimum WebView version:** if the WebView major version is below the minimum, show a **warning, not a block** (`lorum ipsum`), with "Open in browser" and a link to update Android System WebView.
  - **How to set the minimum:** audit the frontend's newest CSS/JS features against the project baseline (AGENTS.md: Safari/WebKit 16.4+).
  - **Starting proposal:** Chromium 111 remains **UNVERIFIED**; the shell ships `MINIMUM_MAJOR = 111`, and P5.6a measured only WebView 74 and 145. Read nullable provider `PackageInfo.versionName` via `getCurrentWebViewPackage`, parse defensively and keep unknown/malformed as unknown; not UA/versionCode or a hardcoded package. Reduced-UA rollout/target gate is **UNVERIFIED**. WebKit `1.18.0` fits minSdk 29, but provider features still need gates; explicitly enforce debug policy even though recent WebViews auto-enable it for debuggable apps (R2, §§2, 4).

### 4.6 Native Settings (minimal; copy is `lorum ipsum`)

- **Auto-update SillyBunny on launch** (git), maps to `SILLYBUNNY_AUTO_UPDATE`. Default on.
- **Runtime:** Node only for now; no Bun selector or runtime-switch/reinstall UI while packaging is deferred (§9.10).
- **App updates:** an on/off toggle for the automatic check, plus "Check now".
- **Battery optimisation exemption** shortcut.
- **Open in browser.**
- **Logs:** view and share.
- **Repair installation** (§4.7).
- **Leftover folders:** list `SillyBunny.broken-*` folders, with deletion behind a clearly confirmed separate screen.
- **Open-source licenses** (`THIRD_PARTY_NOTICES`).
- **Stop server.**

### 4.7 Repair (recovery path; must never lose data)

Triggered manually from Settings or the error screens:
1. Stop the server.
2. Rename `SillyBunny/` to `SillyBunny.broken-<timestamp>/`. Nothing is deleted.
3. Run `install.sh --no-start --dir filesDir/SillyBunny --ref <previously tracked branch, else DEFAULT_REF> --use-node --migrate-from filesDir/SillyBunny.broken-<timestamp> --allow-git-source`.
   - **Verified:** the new opt-in `--allow-git-source` bypasses the existing git-source refusal (baseline `scripts/bootstrap/install.sh:280-310`); existing copying (`scripts/bootstrap/install.sh:312-375`) preserves `config.yaml`, the relative data root, user plugins, third-party extensions, legacy `secrets.json` and `certs/`. Absolute data roots are retained/reused, not copied.
4. Start the server.
5. Keep the broken folder until the user deletes it from the separate confirmed screen (§4.6).

**Verified (P5.9):** Repair shows the branch it installs. A failure on a branch other than `DEFAULT_REF`, for example one deleted upstream, offers an explicit retry on `DEFAULT_REF`, and that choice persists for later retries. The app never switches silently, because git exits 128 for a missing branch and a lost network alike. A success clears the Repair record before the provider leaves maintenance.

**External writers (R2, §7):** coordinate provider maintenance mode/writer quiescence before migration. Revoking URI grants does not close an already-delivered writable descriptor; it may still write the moved source after copying. Define grant/ID behavior across Repair and test an open writable descriptor (§4.8).

### 4.8 File-manager access (`DocumentsProvider`)

- **What it exposes:** **`data/` and `config.yaml` only**, read and write. The rest of the checkout stays hidden: edits to tracked files would make the worktree dirty and block `self-update.sh`.
- **Who can access contents:** apps holding the user's SAF URI grants; the system picker can see root metadata. No broad storage permission is required, and Android 11's external-directory picker restrictions do not prohibit this provider for its own internal files (R2, §7).
- **Surface:** implement `onCreate`, `queryRoots`, `queryDocument`, the abstract String-overload `queryChildDocuments`, and `openDocument`; honor projections, immediate children and concurrent calls. DocumentFile is optional, not required (R2, §7).
- **Scope/authorization:** a synthetic root exposes only `data` and exact `config.yaml`, never the checkout root, source, `.git`, runtime/home/logs or broken folders. Use `FLAG_LOCAL_ONLY`, root creation/child flags and per-directory `FLAG_DIR_SUPPORTS_CREATE` only for implemented operations. Flags are not authorization: every method must reject root/anchor mutation and config rename/delete even for a writable tree grantee. A root grant includes secrets in both branches (R2, §7).
- **Containment:** validate every query/open/create/rename/delete/child-check, all descendant depths and source authorization. Reject traversal, absolute/unknown IDs, unsafe names, special files and symlink escapes; compare canonical path components, not string prefixes. Canonicalize-then-open races a same-UID symlink writer; choose a verified no-follow directory-relative strategy or explicitly trust that writer. Race-free target-device support remains **UNVERIFIED** (R2, §7).
- **Writes:** provide seekable `rw`, cancellation and deliberate truncation; `ParcelFileDescriptor` mode `w` does not imply truncate, unlike `wt`/`rwt`. Test shorter replacements. Notify document/child/root URIs as appropriate after close, mutations and server-side writes, not only provider-owned changes (R2, §7).
- **IDs/grants:** durable unique IDs, all-depth `isChildDocument`, deleted-descendant grant revocation and no recycling for unrelated content; define whether IDs follow migrated data or are revoked on Repair (§4.7). Test direct DocumentsContract operations bypassing picker flags, hostile IDs/URIs/symlinks and open-writer Repair. API 37 trash/restore is optional; 37.1 search is not a 37.0 requirement, and OEM picker behavior is **UNVERIFIED** (R2, §7).

### 4.9 Native-binary packaging details (from prior art)

- **Prior art:** TavernDroid's `tools/prepare.sh` and `tools/elfpatch.py`, and VSCodroid's `scripts/download-termux-tools.sh` (URLs in Appendix B), show how to:
  - rename binaries to `lib*.so`
  - rewrite `DT_NEEDED`/`DT_SONAME` entries
  - set `LD_LIBRARY_PATH`
  - symlink git's helpers into `GIT_EXEC_PATH`
- **Ruled out:** VSCodroid found that HTTPS clone fails if `git-remote-https` sits in writable `filesDir`. The helper must resolve to `nativeLibraryDir`.
- **Termux hardcoded paths to check:**
  - P4-T replaces exactly one compiled-in Termux shell literal in each Git/HTTP-helper binary (six across three ABIs) with same-length NUL-padded `/system/bin/sh`; the API 37 real-app shell-alias probe passes. This does not make writable hooks executable or add SSH/submodule/GUI support.
  - bash's rc paths: run with `--noprofile --norc`
  - any `/data/data/com.termux/...` strings: use `strings` on each binary
- **npm/npx trampolines:** a tiny C program built with the NDK. It works out its name from `argv[0]` and runs `execv(nativeLibraryDir/libnode.so, [node, $SILLYBUNNY_ANDROID_NPM_CLI|NPX_CLI, argv[1:]...])`. It is packaged as `libnpm.so` / `libnpx.so` (an executable named like a library, so it needs a small Gradle copy step; AGP only auto-packages CMake library targets). **Verified (S2.5):** a 57-line C trampoline (source in `s25-app-install.md` §4) builds for all three ABIs as a stripped PIE with 16 KB LOAD alignment and NEEDED limited to libc/libdl. It runs `npm`/`npx` 11.19.1 on API 29/36/37, resolves `libnode.so` next to its own `/proc/self/exe`, and also accepts the `libnpm.so`/`libnpx.so` names.
- **Execution proof (R2, §2):** use absolute Context-derived native paths for direct starts; a `.so` name only makes a packaging candidate, not a valid executable. Validate the actual app-launched chain/helper symlink targets on the required API/OEM matrix, not `run-as`. Interpreting writable JS/shell files differs from directly executing them. Target-37 `System.load()` requires modules read-only to the app UID; installed 0755 files owned elsewhere need not be 0444. This Java rule does not establish a blanket native dlopen/exec/npm-add-on ban; test those paths separately.
- **Bun [DEFERRED]:** Node is the only bundled JavaScript runtime (confirmed 2026-10-21, §9.10); no Bun fetch/packaging now. Retain `bun-linux-aarch64-android.zip` (https://github.com/oven-sh/bun/releases) as a Bionic candidate fact, not a qualified runtime; S2.4's failures and future patched-build gates remain in §10.

---

## 5. Runtime pipeline and app self-update

### 5.1 `android/runtime.lock` (single source of truth for bundled binaries)

It pins:
- Node version + patch-set hash + **GHCR digests** per ABI
- Termux package name / version / arch / sha256 for git, bash, their shared libs, and any toybox gap-fillers
- Reserved `bun` field remains `null` while packaging is deferred; a future qualified bundle would need version + archive sha256 (§9.10)
- npm version (≥ 11.10.0, the first npm that honours `min-release-age`: https://docs.npmjs.com/cli/v11/using-npm/changelog)

Schema 1 and its portable test are committed in `55243cab1`: three ABIs, authenticated Termux repository/package pins and per-ABI pool filenames/SHA256. `926cde326` pins Node and npm (P4.x): Node v24.22.0 by tag, commit and source tarball SHA-256, plus the NDK r30 archive, API 29, full ICU and the patch set (SHA-256 and series). Each ABI names a GHCR repository and tag whose digest, SHA-256 and size stay `null` until `android-runtime.yml` first publishes and its digest PR merges. npm 11.19.1 comes from the Node source. `bun` intentionally stays `null` under the confirmed deferral (P4-T, §§2–3; §9.10).

### 5.2 Node runtime build workflow (new, e.g. `.github/workflows/android-runtime.yml`)

- **Triggers:** `workflow_dispatch`, plus changes to the Node pin or patch files.
- **Build:** upstream Node (pin **v26.12.1**, built without the `Temporal` global) with `./android-configure <NDK> <API> <arch>` (https://github.com/nodejs/node/blob/main/BUILDING.md#android) for arm64, armv7 and x86_64, 16 KB aligned. Node 24.x entered Maintenance LTS on 2026-10-20; 26.x becomes Active LTS on 2026-10-28. The first release ships Node 26, moved to the newest 26.x before its build (§9). Expect hours; **this cost is CI-only, never per user**.
- **Patches:** keep any needed Android patches in `android/runtime/patches/node/`. ST-android (AGPL-3.0, Node submodule + minimal patches) is the reference.
- **Publishing:** push to **GHCR** as an OCI artifact (e.g. `ghcr.io/sillybunnyteam/sillybunny-android-runtime:node-<ver>-<patchhash>-<abi>`, via `oras`), with build-provenance attestation. Then open a PR updating the digests in `runtime.lock`.
- **Termux packages:** `android/runtime/fetch-termux.sh` + `package-termux.py` verify pinned SHA256, extract/patch the Git/Bash/HTTPS ELF closure and emit runtime assets, licenses and per-ABI `runtime-files.json`. Lock refresh authenticates InRelease/index/deb metadata with the pinned Termux key; ordinary builds use the lock, not a fresh index. Clean/offline byte-identical builds pass; toybox gap-fillers await task 2.5 (P4-T, §§3–5).
- **Input mirror (2026-10-24):** every input a release build downloads by SHA-256 pin (the Termux debs, the `sources.lock` URL pins, the build-system listings and their files) is copied into the Node runtime's GHCR package as one OCI artifact per pinned set, tagged `inputs-<12 hex>` from the sorted root digests (`android/runtime/runtime-mirror.py`; `runtime.lock`'s `mirror` object names the package). Builds read each pin by digest with an anonymous token, mirror first and then the origin; release builds pass `--mirror-only`. Never delete `inputs-*` versions: old pins can be built only from them, and the GPL debs keep their corresponding source in the same manifest (§5.3).
- **Verified (P4.x):** `android-runtime.yml` runs only in `SillyBunnyTeam/SillyBunny`, on `staging` pushes that touch the Node pins, the patches, `build-node.sh` or the workflow, and on manual runs. A push builds only while a digest is `null`: three `build-node.sh` jobs (up to 330 minutes each), then `oras` pushes to GHCR, an attestation per ABI and the digest PR (`update-node-digests.py`). A recipe-only change after pinning needs a manual run with `publish: true`. `fetch-node.py` stages `node-out/` from GHCR by digest (or `--local` for a development build), and `build-npm.py` stages `npm-out/`. **Not run yet:** the first run needs Actions allowed to create pull requests; jobs allowed packages, id-token, attestations, contents and pull-requests write; the GHCR package made public after the first publish (fetch-node.py pulls anonymously); and attestations need a public repository or GHEC. PRs opened with `GITHUB_TOKEN` start no `pull_request` checks. Expect the first build on the first `staging` push after this branch merges. Byte-identical rebuilds need the same `NODE_BUILD_DIR`, because `libnode.so` embeds its build directory.
- **Input mirror job (2026-10-24):** the push paths also cover `sources.py` and `runtime-mirror.py`, which choose the pins that the tag hashes. `plan` asks `runtime-mirror.py --plan` whether the set's tag exists; when it does not, the `mirror` job (staging pushes and manual runs with `publish: true`; `packages: write`, no attestation, no PR) stages the set, pushes it with `oras` and checks it anonymously with `--check`, which fails while the package is private. Release `decide` runs `--check` before building. The workflow-level concurrency group makes a mirror run wait behind a running Node build (up to about 6 h), and a newer push cancels a pending run; a release tagged in between fails closed in `decide`. A waiting run publishes when it starts, and re-running a cancelled run recovers without a Node build; a manual run with `publish: true` also works, but it rebuilds and republishes Node.

### 5.3 GPL / license compliance

git (GPL-2.0), bash (GPL-3.0) and any LGPL libraries are redistributed as binaries. Whenever a release ships **new** binaries, attach `SillyBunny-android-sources.tar.zst`. It contains:
- the upstream source tarballs
- the Termux build recipes and patches used
- the Node source + patches

Ship `THIRD_PARTY_NOTICES` inside the APK and show it in Settings.

**Verified (P4.5):** every APK that carries the runtime ships `THIRD_PARTY_NOTICES` and `THIRD_PARTY_NOTICES.json`, generated during the build: the Termux packages (16), Node (1), npm's 144 package roots and the Android libraries (64 in release builds, 65 in debug).
- `notices.py --node-tarball` reads Node's license and npm's tree from the pinned Node source tarball, whose SHA-256 must match `sources.lock`.
- Four npm packages ship no license file. `android/runtime/licenses/npm/` holds the texts used instead, each with its source commit and SHA-256 in `provenance.json`. `@npmcli/agent` has no license file anywhere upstream, so it gets npm's own ISC template text, marked as a substitute.
- The Android library list comes from each artifact's POM license, matched exactly against `android/runtime/licenses/android/licenses.json`. An unlisted license fails the build.
- Release builds fail when a notices input is missing, and when `runtime.lock` pins npm or a packaged Node binary but the staged `npm.json` or `node.json` does not name the pinned source tarball. Debug builds warn.
- Build order: `fetch-termux.sh`, `fetch-node.py`, `build-npm.py`, `build-sources.sh --require-node` (it also caches the Node tarball, which `-Psillybunny.nodeTarball` can override), then Gradle. The notices step needs a POSIX host (Linux, macOS or WSL). Release builds (`android/release/build-release-apks.sh`) run `fetch-termux.sh --mirror-only`, `fetch-node.py`, `build-sources.sh --mirror-only --require-node`, then `build-npm.py --offline`, so the Node source files also come from the input mirror (§5.2).
- The sources archive with Node is 170,482,320 bytes and rebuilds byte-identically.

The Node-only release does not redistribute Bun or require Bun-specific source/notices. A future Bun bundle must also supply WebKit/JSC and dependency-specific notices/source/relink material, not an MIT-only label (P4-T, §6; S2.4, §4).

### 5.4 `android-update.json` (release asset, schema v1)

```json
{
  "schema": 1,
  "versionCode": 1,
  "versionName": "1.0.0",
  "prerelease": false,
  "releaseTag": "v2.0.0",
  "defaultRef": "release",
  "minSdk": 29,
  "signingCertSha256": "AA:BB:...",
  "inputsHash": "<inputs-hash.mjs v2 hash of the §6.1 inputs>",
  "assets": {
    "arm64-v8a":   { "name": "SillyBunny-android-arm64-v8a.apk",   "sha256": "...", "size": 0 },
    "armeabi-v7a": { "name": "SillyBunny-android-armeabi-v7a.apk", "sha256": "...", "size": 0 }
  },
  "runtime": { "node": "x.y.z", "bun": null, "git": "x.y.z", "bash": "x.y", "npm": "x.y.z" }
}
```

`runtime.bun: null` means Bun is not bundled; retain the field for a future qualified runtime (§9.10).

Asset names are **stable across releases**, so `https://github.com/SillyBunnyTeam/SillyBunny/releases/latest/download/SillyBunny-android-arm64-v8a.apk` always works for newcomers.

### 5.5 Update check (in-app, non-blocking)

- **When:** on every app launch (if enabled) and on "Check now". It never delays server start.
- **Channel:** follows the checkout's tracked branch (`git rev-parse --abbrev-ref @{upstream}`):
  - `release` → stable: `GET https://github.com/SillyBunnyTeam/SillyBunny/releases/latest/download/android-update.json` (redirect; not subject to the REST API rate limit; GitHub's "latest" excludes drafts and prereleases).
  - anything else (e.g. `staging`) → prerelease channel: `GET https://api.github.com/repos/SillyBunnyTeam/SillyBunny/releases?per_page=20` (unauthenticated, 60 requests/hour/IP; fine at one check per launch). Fetch the `android-update.json` of each non-draft release and take the highest `versionCode`.
- **Before offering the update:** only offer it if `versionCode` is greater than the installed one **and** `signingCertSha256` equals the installed app's signing cert. This single-fingerprint schema supports the initial single-key case, not legitimate v3/v3.1 rotation or OS-dependent signers. Before using a successor, design/test cryptographically verified candidate-lineage/API-targeted validation; do not accept any installed historical key or claim every mismatch requires uninstall. PackageInstaller remains the final compatibility check (R2, §6).
  - Hash the encoded X.509 certificate bytes, not the APK/public key; normalize manifest hex to bytes. Query `GET_SIGNING_CERTIFICATES` with the API-appropriate overload; single-signer history and the full simultaneous `apkContentsSigners` set differ. Installed history alone cannot authenticate an unseen successor (R2, §6).
- **The prompt:** a native dialog with **Update / Later** (`lorum ipsum`). On Update:
  1. Download the APK for the device ABI.
  2. Verify sha256.
  3. Stop the server.
  4. Install via a user-approved `PackageInstaller` session. Declare `REQUEST_INSTALL_PACKAGES`; if `canRequestPackageInstalls()` is false, open this package's `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES`. Source trust is separate from confirming this install. On API 31+ request `USER_ACTION_REQUIRED`; handle `STATUS_PENDING_USER_ACTION` by presenting `Intent.EXTRA_INTENT`, not assuming commit finishes synchronously (R2, §2).
     - Target 35+ requires a **mutable, explicit** installation-status PendingIntent; guard `FLAG_MUTABLE` at API 31. Keep normal notification intents immutable. Handle verification pending/bypass and failure-aborted outcomes, API 36.1+ `EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON` and optional explanation intent. Leave retrospective update ownership off (it cannot claim an existing install); another installer's enforced ownership can still require user action (R2, §2).
- **Blocked git updates:** if `status/update-blocked.json` exists, show the APK update prompt with "required" wording (`lorum ipsum`).
- **No web UI banner in v1.**
- **HTTPS client:** audit target-37 certificate-transparency defaults, custom CAs and library/server-dependent ECH; platform TLS/NSC does not configure Node/git's separate TLS stacks (R2, §2).
- **Verified (P5.8):** the stable candidate's APK comes from `releases/download/<tag>/<asset>`, where `<tag>` is the release that served the checked manifest (the first redirect of the official `latest` URL) or, without a usable official redirect, the manifest's `releaseTag`, because `latest` can advance between the check and the download. The tracked branch is read from `.git/HEAD` and `.git/config` without running Git; worktree indirection, includes, a detached HEAD or unusual config fall back to `DEFAULT_REF`. On API 29 and base Android 13, `getPackageArchiveInfo` fills `signingInfo` only when `GET_SIGNATURES` is also requested, so the app requests it below API 34; verification still reads only `apkContentsSigners`. Redirects are HTTPS→HTTPS only (debug builds also allow direct loopback HTTP fixtures), JSON is capped at 2 MB, and the APK must match the manifest's size (≤ 300 MB) and SHA-256 before archive verification.

### 5.6 After an APK self-update

Android kills the process during the install. On `ACTION_MY_PACKAGE_REPLACED`, post a notification ("updated, tap to start", `lorum ipsum`) that opens the app. **Tap-to-start is the chosen product policy:** this broadcast is explicitly an FGS background-start exemption, not an Android prohibition on restart. Keep receiver work bounded and use a direct activity PendingIntent, not an activity trampoline. Notification denial can hide the notification; handle the updated state on the next explicit launch. Background-activity-launch opt-ins are separate from the FGS exemption (R2, §2).

---

## 6. Release integration and signing

### 6.1 Versioning rules

- **Independent APK version.** It lives in `android/app-version.properties` (`versionCode`, `versionName`) and is independent of the SillyBunny version (e.g. APK `1.0.0` ships in SB `v2.0.0`).
- **APK inputs** are defined by `android/release/inputs-hash.mjs` (format v2): the committed tree entries of `android/**` (excluding pure docs, `android/runtime.lock` included), `scripts/bootstrap/install.sh` (the APK bundles it for first run and Repair), and the tracked `.gitattributes`, `scripts/.gitattributes` and `scripts/bootstrap/.gitattributes` (they decide the inputs' checkout bytes), plus `defaultRef`. Their hash is `inputsHash`. The rest of the build recipe must stay fixed: release builds vary only `-PdefaultRef`, and any option of the runtime and notices steps that changes APK bytes must come from files under `android/` (P7.2).
- **Unchanged inputs.** If `inputsHash` equals the previous release's manifest `inputsHash` (same channel), CI downloads the previous release's signed APKs and `android-update.json` and **re-attaches them byte-identical**: no rebuild, no versionCode change, no user prompt.
- **Keep earlier release assets.** A re-attached `android-update.json` keeps its original `releaseTag`. The app downloads stable APKs from the release that served the manifest and falls back to `releaseTag` only when it saw no usable official redirect, so still never delete or replace the APK assets of an earlier release.
- **Complete releases only.** A published release must hold every APK its `android-update.json` lists, with the listed size and SHA-256: attach the APKs before the manifest and publish the draft only when it is complete. Never flip a published release's prerelease flag either (an RC promoted in place): the decision refuses that history until the release is fixed (P7.2).
- **Changed inputs.** `versionCode` must be greater than the highest `versionCode` of every earlier release manifest, in either channel and including drafts; otherwise CI fails with a message naming that release.
- **RC → stable rebuilds.** RC and stable builds differ in `defaultRef`, so a stable release after an RC always rebuilds with a bumped `versionCode`, and RC testers then get the stable APK as an update. Expect this for `v2.0.0-rc.1` → `v2.0.0`. Maintainers expect to skip RCs after this first run.
- **No downgrades.** Android won't allow them, so a bad APK is "rolled back" by shipping a higher `versionCode`.
- **min-app-version.** `android/min-app-version` must be ≤ the `versionCode` attached to the same release (CI check).

### 6.2 `release.yml` changes

**Phase 6/7 layout (decided 2026-10-21, §9.9):** `tests/release-workflows.test.js` forbids `environment:` in `release.yml` and requires every `uses:` to be `owner/repo@<40-hex>`. Those tests change deliberately to allow exactly two things: `environment: android-signing` on the one signing job, and the local reusable `.github/workflows/android-smoke.yml`, which bootstrap-smoke, nightly and release all call. Every other assertion stays.

Restructure the single draft job (it currently has a 15-minute timeout) into separate jobs:
1. **`android-apk` job:**
   - Compute `inputsHash` and `defaultRef` (`staging` when the existing step output `steps.tag.outputs.prerelease` is true, `release` otherwise).
   - Re-attach the previous APKs, or build:
     - pull the runtime from GHCR by the digest in `runtime.lock`
     - fetch the Termux packages
     - build `assembleRelease` per ABI (arm64-v8a, armeabi-v7a)
   - Run the Android smoke (§7.1) on the x86_64 test build of the same commit.
   - Sign in the **`android-signing` environment**.
   - Produce the `android-update.json`.
   - Produce the sources archive if the binaries changed.
2. **`draft-release` job** (needs the APK job): add the APKs, the manifest and (if present) the sources archive to the asset dir, so they are included in `SHA256SUMS` and `actions/attest-build-provenance`. Then create the draft as today.

### 6.3 Signing setup

- **Protected environment:** GitHub environment `android-signing` with **required reviewers** (Geechan and/or TheLonelyDevil). Deployment is restricted to tags matching `v*`.
- **Secrets:** `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- **Key generation:** the keystore is generated **offline** by the key holder (Geechan or TheLonelyDevil, to be decided). **Two encrypted offline backups**, one per maintainer.
- **Rotation key:** prepare an APK Signature Scheme v3 authorized lineage while both old/new keys are available, with encrypted backups of keys **and lineage** (https://source.android.com/docs/security/features/apksigning/v3). A spare key alone cannot recover a lost signer. v3.1 normally rotates on API 33+ while retaining old-key signing for older devices; API ≤31 rotation has documented bugs. Keep the initial single-key updater until §5.5 supports verified lineage/OS-specific signers (R2, §6).
- **Workflow protection:** CODEOWNERS on `.github/workflows/**` and `android/**`, so changes to the signing path need maintainer review.
- **Signing checks:** the Gradle build decodes `ANDROID_KEYSTORE_B64` into the ignored `android/.gradle/signing/release.keystore`, which survives `clean`; the signing job must delete it after use and keep `android/.gradle/` out of caches and artifacts (P5.1). ZIP-align before signing, never mutate afterward; use environment password references, reject debuggable production APKs, enable v2/v3 and omit unnecessary v4 `.idsig`. Verify signing for supported API ranges and final ZIP alignment independently of ELF checks. Installed-device update/rotation behavior remains **UNVERIFIED** by R2's host-tool fixture (R2, §6).
- **Same certificate as earlier releases [DECIDED 2026-10-24]:** `release.yml` refuses APKs signed with another certificate than the one every earlier `android-update.json` names, drafts and both channels included. `android-sign` compares right after signing, before it writes and uploads the manifest; `android-reattach` compares before its upload; `draft-release` compares the manifest it attaches with a fresh decision right before `release create`. The first APK release has nothing to compare with and writes its fingerprint to the job summary. Earlier releases that name different certificates fail the decision. A planned key rotation is refused too, until the updater supports a verified lineage (§5.5; Round 5, Q12).

### 6.4 Implications of CI signing (for TheLonelyDevil)

- **Lost key.** Losing the required signer without a usable, already authorized successor blocks compatible updates. Uninstalling **deletes data unless users keep it** (`hasFragileUserData`) or back it up. Offline backups are mandatory; creating a spare key after loss does not authorize it (R2, §6).
- **Leaked key.** If the key leaks *and* an attacker can publish release assets, they can ship an "update" that devices accept. The mitigations are:
  - required reviewers on the environment
  - environment secrets that only release-tag jobs can read
  - CODEOWNERS
  - protected tags
  - attestation and `SHA256SUMS`
  - the app checking `signingCertSha256`
- **Workflow access.** Anyone who can merge workflow changes can in principle exfiltrate secrets. Treat workflow PRs as security-sensitive (SECURITY.md scope, §8).
- **Rotation** requires authorized lineage prepared before key loss and an updater that supports it (§5.5); the current single-fingerprint check would otherwise reject it (R2, §6).

---

## 7. Testing

**Requirement (Round 4 Q3):** the *whole procedure an end user goes through* must be tested automatically in CI, and a team member performs the manual device tests before stable.

### 7.1 Automated Android smoke (CI)

- **Location:** a new job in `.github/workflows/bootstrap-smoke.yml`, alongside the other smoke jobs.
- **When it runs:** only when Android-relevant files change: `android/**`, `start.sh`, `scripts/**`, `src/middleware/launchToken.js` and its hook, `src/android-app-gate.js`, `src/endpoints/server-admin.js`, `package.json`, `package-lock.json`, `bun.lock`, `.npmrc`. Other files are covered by the other smoke jobs. It also runs **nightly** (`nightly.yml`) and as a **required step in `release.yml`** before APKs are attached.
- **Path filtering:** Android change detection must be a script step: `tests/bootstrap-installer.test.js` forbids the literal string `paths:` anywhere in `bootstrap-smoke.yml`.
- **Workflow constraints:** `tests/nightly-workflow.test.js` also requires `owner/repo@<40-hex>` for `uses:` and keeps launcher flags out of the checks-job and unit-test-step environments. Local reusable-workflow calls do not fit the current assertion; reuse/signing layout remains open for Phase 6/7 (§6.2, §9).
- **Environment (R2, §5):** an x86_64 test-only APK (debug signing, fixture URL overrides) on explicit `ubuntu-24.04`; verify `/dev/kvm` access and `emulator -accel-check`, not silent software fallback. Pin `reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d` (v2.38.0). Images: **29/default**, **36/default**, **37.0/google_apis_ps16k**, all x86_64; optional 37.0/google_apis adds 4 KB coverage. Use `api-level: '37.0'`, not integer 37; no API 37/default image was in the checked catalog.
  - Emulator DNS settles late: on API 37, lookups failed for about the first 30–60 s after `sys.boot_completed` and then resolved, for toybox and Node alike. Wait until `dumpsys connectivity` reports DNS addresses, or retry DNS for up to 90 s, before any network step (S2.1, §6).
  - Pin actual Command-line Tools `23.0` and Emulator `37.2.12` via `emulator-build: '16428233'`; upgrade the action's actual `cmdline-tools/latest/bin/avdmanager`, not merely PATH. Recreate stale AVD caches, assert root `.ini` target `android-37.0`, and use `ram-size: '4096M'` or more for API 37. Verify UI/system-service readiness beyond `sys.boot_completed=1`; typical hosted boot times are **UNVERIFIED**, and the action's 600 s timeout is not a boot estimate. Current r6/r7 images clear Google's specific revision-5 GMS fix, not every possible API 37 issue.
- **Fixtures on the runner host,** reachable from the emulator through `adb reverse` at the guest's `127.0.0.1` (P6.1):
  - **Git remote:** a bare repo built from the PR commit, with branches `release` and `staging`, served over http.
  - **Mock LLM:** a mock OpenAI-compatible endpoint returning canned streaming responses.
  - **Fixture extension repo**, with two commits.
  - **Fixture server plugin**, with a lockfile and a tag.
  - **Static server** for a test `android-update.json` and a test APK with `versionCode + 1`, signed with the same test key.
  - **npm:** the real registry (or a verdaccio cache).
- **Fixture networking (R2, §2):** `10.0.2.2` is not guest loopback. Test target-37 LAN permission and each client's debug HTTP policy separately, or route through ADB reverse addressed as guest `127.0.0.1`; HTTPS fixes cleartext policy, not LAN permission. Chromium website-level LNA is a separate policy; pinned current WebView allowances are not a permission bypass or a guarantee for older/vendor providers.
- **Driving the app:** UiAutomator/Espresso for native screens and system dialogs. For the web UI, use Playwright over CDP (debug builds enable WebView debugging; `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`), reusing patterns from `tests/` (Playwright e2e already exists). The test harness gets a handoff code through a debug-only hook.
- **Steps to automate (each is an end-user step):**
  1. Install the APK (`adb install`), launch it, go through the first-run screens (including the metered-network warning path), and complete the clone + `npm ci` + `init`.
  2. The server becomes healthy and the WebView loads the UI.
  3. Configure the mock backend and **send a chat message**; get a streamed reply.
  4. **Git update:** push a new commit to the fixture `release` branch, relaunch, and assert the new HEAD is running.
  5. **min-app-version gate:** push a commit raising `android/min-app-version` above the installed versionCode, relaunch, and assert that the pull was skipped, `update-blocked.json` was written, the app prompts for an APK update, and the server still runs on the old code. Repeat via the Server Tools `/update` endpoint.
  6. **APK self-update:** serve the higher-versionCode test APK, accept the dialog and the system installer (UiAutomator), and assert the new versionCode, the post-update notification, and that data is intact.
  7. **Extension install, update and branch switch** from the fixture repo.
  8. **Server plugin install and update** from the fixture plugin.
  9. **Token gate:** `adb shell curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` returns 403; the WebView gets 200; a handoff code works once and fails on replay; and with `enableUserAccounts: true`, login works behind the gate.
  10. **Crash policy:** kill the node process and assert an auto-restart. Kill it 4 times within 5 minutes and assert the error screen with Restart and Share logs.
  11. **Background survival:** press Home, run `adb shell dumpsys deviceidle force-idle`, wait (shortened in CI, e.g. 10 minutes; manual tests use 30), and assert the server still responds.
  12. **Repair:** corrupt `.git`, run Repair, and assert a fresh checkout, migrated `data/`/`config.yaml`/extensions/plugins, and a kept `SillyBunny.broken-*` folder.
  13. **Node-only runtime:** assert Node/npm is selected, no Bun binary/symlink or runtime-switch UI is shipped, and Bun is absent from the APK PATH on every ABI. Runtime-switch testing is deferred with Bun (§9.10).
  14. **Data safety assertion:** after every step, a checksum of a seeded `data/` fixture (chats, characters, `secrets.json`) is unchanged, except where the step intentionally adds data.
- **JS unit tests (Jest):** the gate module and the token middleware (§3.2, §3.3).
- **Android tests (R2, §1):** JUnit `4.13.2` + Robolectric `4.17`, Android resources enabled and `RobolectricTestRunner`; JDK 21 for API 36/37. Instrumentation uses `AndroidJUnitRunner`, AndroidX Test core/runner/rules `1.7.0`, ext-JUnit `1.3.0`, UiAutomator `2.4.0`; optional Espresso `3.7.0`/BOM-managed Compose UI tests `1.12.1` only when used. Jupiter is not a drop-in Robolectric JUnit-4 replacement. Carry R2's Java-17+ `--add-opens` list into the test JVM only: `java.base/{java.lang,java.util,java.io,java.net,java.security,java.text,jdk.internal.access}`, `java.desktop/java.awt.font`, `jdk.compiler/com.sun.tools.javac.api`, each to `ALL-UNNAMED`.
- **Additional native/WebView gates:** notification denial, explicit Stop versus host/child death, LAN permission denied/granted/revoked and profile boundaries; immediate/0-ms/1-s/60-s revoked exports, large/queued saves, cookies/names/redirects, picker cancellation/hostile URIs, stable-origin storage/locks, clipboard, OpenRouter return, SW restart, dialogs/TTS/fullscreen; provider containment/direct tree-grantee calls, shorter writes and open-writer Repair. These are outstanding runtime cases, not passes from static/host-tool audits (R2, §§2, 4, 7; S2.7b, §§3, 6).

### 7.2 Manual device tests (a team member, before stable)

- **Device matrix:**
  - ≥ 3 real arm64 devices from different makers, **including one with an aggressive battery manager (Samsung or Xiaomi)**
  - Android 10 and the latest Android
  - one armeabi-v7a device (best effort)
- **On each device:** run every step from §7.1 by hand. Also cover:
  - **installing as a newcomer from the GitHub release page**, including the "install unknown apps" permission and, once it applies, Google's advanced flow for unregistered apps
  - 30 minutes of background survival
  - Node-only operation on arm64; real arm64 Bun qualification is a future revisit gate, not a current-release requirement (§9.10)
  - a work profile or Private Space install (path independence)
- **Record the results** in the PR (by a human).

---

## 8. Documentation and copy: guidance for humans (do NOT write the prose)

AGENTS.md forbids LLM-written user-facing prose. The implementing agent must use `lorum ipsum` placeholders and give the maintainers this list of **what to cover**:

- **README.md** (and, via the maintainers' own process, the translated `.github/readme-*.md`; never hand-edit `.github/readme.md`, which is generated by `scripts/sync-readme-mirror.sh`):
  - **The APK as the recommended Android 10+ path**, with the stable download links from §5.4 and which ABI to pick.
  - **First-install steps:** allowing "install unknown apps", the developer-verification advanced flow when applicable (direct GitHub sideloads are outside the current store phase; wider rollout announced for 2027 and beyond, exact dates unspecified), notifications, the battery-optimisation prompt, and the first-run download size and storage needs (R2, §3).
  - **Data:** where it lives, backups (SillyBunny's backup download, file-manager access to `data/`), Repair, and what uninstalling does (the keep-data prompt).
  - **Node-only APK for now:** Bun packaging is deferred; non-APK Bun support is unchanged. Explain the failed qualification and future revisit gates (§9.10).
  - **Termux** stays documented as supported (Android ≤ 9, power users). **While unregistered, Termux stays visible.** Reduce its prominence only after the APK is proven seamless.
- **SECURITY.md:** add to scope:
  - the APK launch-token gate
  - APK update manifest and signature verification
  - the Android runtime pipeline (GHCR artifacts, pinned Termux packages)
  - signing-key handling and workflow-change sensitivity
- **CONTRIBUTING.md:**
  - building `android/` locally (JDK, SDK, NDK versions)
  - running the Android smoke locally
  - the rules for `app-version.properties`, `min-app-version` and `runtime.lock` bumps
  - the source-archive / GPL obligations
- **AGENTS.md:** *brief additions only, under maintainer supervision* (show the diff and ask first):
  - Commands: e.g. `cd android && ./gradlew assembleDebug`, plus the Android smoke invocation
  - Repo Shape: "`android/` has its own Gradle project, not covered by root scripts"
  - Workflow: "bump `android/app-version.properties` when `android/**` or `runtime.lock` change; never raise `android/min-app-version` above the versionCode shipped in the same release"
- **Release notes, changelog summary, Discord copy:** written by humans as usual.
- **In-app copy placeholders** (`lorum ipsum`; list every file and string ID in the PR handoff):
  - first-run screens: welcome, preflight, metered warning, progress, failure
  - the battery-optimisation explanation
  - the foreground-service notification title/text and Stop and Cancel actions
  - the `specialUse` subtype description
  - the update dialog and the "required update" variant
  - the post-update notification
  - the outdated-WebView warning
  - crash error screen texts and the Share-logs warning
  - Bun experimental-warning copy is deferred with the bundle; no Bun setting/warning is needed in this Node-only APK (§9.10)
  - Repair texts and the leftover-folder deletion confirmation
  - all Settings labels
  - the licenses screen title
  - the `android_app_update_required` message in Server Tools (web UI)

---

## 9. Caveats and confirmations (open items owned by maintainers unless marked confirmed)

1. **Developer verification: staying unregistered** (Round 1 Q7). Facts (R2, §3; 2026-10-20 cutoff, validated 2026-10-21; https://developer.android.com/developer-verification/guides):
   - **Enforcement so far:** it started 2026-09-30 in Brazil, Indonesia, Singapore and Thailand for participating stores. Direct GitHub sideloads/self-updates are outside that initial phase, not already blocked by this deadline.
   - **Expansion:** all-app coverage on certified devices is announced for 2027 / "2027 and beyond"; exact worldwide start/completion dates are **UNVERIFIED / unspecified**, not necessarily January 2027.
   - **Where enforced:** advanced flow requires Developer Mode, anti-coaching confirmation, restart/reauthentication, a roughly 24 h wait, biometric/PIN confirmation, then unverified installs for 7 days or indefinitely, with Install Anyway warnings. Developer options need not stay enabled. ADB installation is unchanged, not a command that unlocks the normal installer.
   - **Updates:** an active **7-day grant suffices**; indefinite permission avoids expiry but is not mandatory. Updates are not grandfathered once enforcement applies; the FAQ does not say an installed version stops running. Read this with today's direct-sideload exception (https://developer.android.com/developer-verification/guides/faq).

   This directly affects "seamless for newcomers". **Re-decide before the 2027 global rollout.** The options:
   - full distribution: $25 + ID for one maintainer, or an organization account with a D-U-N-S number
   - open-source registration still requires a verified developer identity, not anonymous unlimited distribution; free limited distribution caps at 20 authorized devices. The platform-re-signed ownership challenge uses the console-provided snippet in `assets/adi-registration.properties` only when applicable, not a generic file created in advance for this self-signed GitHub APK (https://developer.android.com/developer-verification/guides/open-source-app-registration)
   - staying unregistered

   While unregistered, Termux must stay visible in the docs.

   2026-10-24: the user asked first whether the fee is one-time. It is: $25 once per account, with no renewal and no per-app charge, and none for a Play Console account whose identity Google has already verified. The decision is still open (Appendix A, Round 5, Q2).
2. **Who holds the signing key and identity [DECIDED 2026-10-24]:** TheLonelyDevil holds the release signing key and sets up the org's `android-signing` environment and its four secrets (§6.3, §6.4).
3. **Bun [DEFERRED]:** Node-only APK shipping is confirmed as of 2026-10-21 (item 10). S2.4 records Bun 1.4.3 startup, 16 KB JSC and `.npmrc` failures (§10). #30766/#39060 remain open; this spike reproduced `close_range`, not `openat2`/`fchmodat2`. #26415 is a WSL2/x86_64 workload, not Android/ARM battery evidence (S2.4, §4).
4. **Icon [DECIDED 2026-10-24]:** the APK uses the SillyBunny icon already in the repository, the pixel-art bunny that `public/manifest.json` lists (`public/img/icon-*.png`), as an adaptive icon. This replaces Round 3 Q8's placeholder; PR #870's design work can still replace the icon later.
5. **Minimum WebView version [DECIDED 2026-10-24]:** Chromium 111, the version below which the app warns. It matches the frontend's documented browser baseline (Safari 16.4+, released the same month as Chromium 111); a "latest version" minimum would warn users during every WebView rollout. The minimum moves only when the frontend's baseline moves (Round 5, Q4).
6. **Toybox gaps [VERIFIED 2026-10-21]:** none. S2.5 found every command that the APK-mode path calls on API 29, 36 and 37, so nothing extra is bundled (§3.1, task 4.3). OEM toybox builds remain **UNVERIFIED**.
7. **Node release line:** the spike pins v24.22.0; 24.x entered Maintenance LTS on 2026-10-20 (EOL 2028-04-30) and 26.x becomes Active LTS on 2026-10-28 (Maintenance 2027-10-20, EOL 2029-04-30). The three Android patches dry-run apply to v26.12.0; a v26 build needs the full three-ABI requalification. S2.1 recommends v26 if the first release ships after 2026-10-28. **Decided 2026-10-24:** the first release ships Node 26, the newest release line. The branch pins v26.12.1 (2026-10-21) and moves to the newest 26.x before the first release build; the move needs the full three-ABI requalification above.
8. **Missing/invalid min-app-version [DECIDED 2026-10-24]:** APK mode blocks these branches instead of treating a missing file as 0, because they predate the launch-token and update gates. The user kept the block on the lead's recommendation (Round 5, Q5): such commits have no launch-token check, so any other app on the device could open their server on 127.0.0.1 and read chats and API keys, and their `start.sh` does not know the app's bundled runtime.
9. **Phase 6/7 workflow layout [CONFIRMED 2026-10-21]:** change `release.yml` rather than add a separate signing workflow (decided by TheLonelyDevil). It is restructured per §6.2 with `environment: android-signing` on one job, a shared local reusable `android-smoke.yml` serves bootstrap-smoke, nightly and release, and the workflow tests change deliberately to allow exactly those. The other `uses:` assertions, script-step Android change detection and the nightly unit-test environment constraints stay (§6.2, §7.1).
10. **Confirmed deviation (2026-10-21): ship Node only for now; defer the Bun bundle.** Maintainers agreed, relayed by the user on 2026-10-21; task 2.8's Bun escalation is resolved and task 4.4 is **DEFERRED**, not complete. This supersedes Round 1 Q13 / Round 2 Q11 for APKs only; repository non-APK Bun support and Node/Bun server parity stay unchanged. Revisit only after 16 KB JavaScriptCore start-up, unchanged `.npmrc min-release-age=7` and source policies, and real arm64 tests pass. S2.4, §§4/6 retains the evidence and recommends a reproducible patched Termux-based build with explicit copyfile installs rather than assuming an official prebuilt is qualified.
11. **Outbound LAN backends:** the no-LAN-listener decision stays unchanged, but target-37 LAN backend use needs a permission/denial UX policy (§4.2); same-profile loopback does not require that permission (R2, §2). **Decided 2026-10-24:** the local-network permission is optional and never forced. On Android 17 and later, the Welcome screen offers it next to the battery exemption and Settings has the same row; denial keeps everything else working, and once Android stops showing the dialog, the row opens the app's system settings page (Round 5, Q6).
12. **Custom `dataRoot` and the file provider:** the DocumentsProvider always maps the checkout's `data/`. Following a custom, possibly absolute, `dataRoot` from `config.yaml` would need its containment redone; `DataDocumentsProvider.dataRootElsewhere(context)` reports whether it resolves outside `data/` (true, false, or null when unknown or during maintenance) so the app can say so. **Decided 2026-10-24:** the provider keeps exposing only `data/`, and a one-line notice in the Files app (the provider root's summary) and in Settings says so when a custom `dataRoot` is set (Round 5, Q7).
13. **Documentation placeholders [DECIDED 2026-10-24]:** README.md, SECURITY.md and CONTRIBUTING.md carry `TODO(copy)` sections, each with §8's skeleton in a comment. Writing them is mandatory for the maintainers, after this branch. The in-app and workflow `TODO(copy)` texts (task 8.1's list) are also written later, not in this PR (Round 5, Q9 and Q10).
14. **After the merge [DECIDED 2026-10-24]:** TheLonelyDevil opens the `actions/*` pull request into `release` (so that nightly runs the Android smoke) and makes the org's `sillybunny-android-runtime` GHCR package public after its first publish (Round 5, Q25).

## 10. Known risks and unknowns (verify early, in Phase 2)

Report keys: **S2.4** = `s24-bun.md`; **R2** = `r2-android-platform.md` (2026-10-20 cutoff, validated 2026-10-21); **S2.7b** = `s27-downloads-audit.md`; **P4-T** = `p4-termux-runtime.md`; **P3-B** = `p3-B-server-gate.md`; **T3.7** = `t37-touch-ledger.md`; **S2.2** = `s22-termux-git-bash.md`; **S2.2b** = `s22b-api36.md`; **S2.5** = `s25-app-install.md`; **S2.1** = `s21-node-ndk.md`; **P5.2** = `p523-runtime-packaging.md`; **P5.4** = `p54-server-service.md`; **P5.5** = `p55-first-run.md`; **P5.7** = `p57-settings.md`; **P5.8** = `p58-app-updater.md`; **P5.9** = `p59-repair.md`; **P4.x** = `p4x-node-pipeline.md`; **P4.5** = `p45b-notices.md`; **P5.10** = `p510-documents-provider.md`; **P7.2** = `p7-release-tooling.md`; **P7.x** = `p7x-release-workflow.md`; **P6.x** = `p6x-ci-smoke.md`; **P5.int** = `p5int-app-integration.md`; **P6.1** = `p61-smoke-fixtures.md`; **P5.6a** = `p56a-webview-shell.md`; **P5.6b** = `p56b-webview-transfers.md`; **P5.6** = `p56-webview.md`; **P2.6** = `p26-measurements.md`.

- **Exec via symlinks:** task 2.2 is complete: S2.2 real `untrusted_app` tests cover API 29/4 KB; P4-T and S2.2b cover committed-pipeline outputs on API 37/16 KB and API 36/4 KB. Required filtered HTTPS clone/Git operations, symlinks and writable-copy EACCES pass; API 36 adds 19 cloned-repository/39 local checks, repaired shell alias and group stop. API 29 used the earlier spike payload, not a rerun of final outputs; API 33/35 and ARM/OEM execution remain **UNVERIFIED**. `run-as` is not production exec proof (S2.2, §4; P4-T, §5; S2.2b, §§4–6; R2, §2).
- **ELF/page-size checks:** P4-T audits all 51 final Termux ELFs: arm64/x86_64 LOADs ≥ `0x4000`; ARM32 retains `0x1000` and needs rebuilding if ARM32 16 KB support is required. All five S2.4 Bun candidates pass static 16 KB LOAD checks, but tested x86_64 JavaScript still aborts on 16 KB pages. S2.1's Node ELFs for all three ABIs, ARMv7 included, pass 16 KB checks: every LOAD has `p_align 0x4000` with congruent offsets, and each RELRO ends on a 16 KB boundary, because the recipe passes explicit 16 KB linker flags. Task 2.7 is complete; only the ARM32 Termux payload stays at 4 KB. That stays (2026-10-24, Round 5 Q24): Android supports 16 KB pages only on arm64, every 64-bit device installs the 16 KB-ready arm64-v8a APK, and an arm64 kernel runs 32-bit code only with 4 KB pages unless it is built with an expert-only option. ZIP alignment alone proves neither ELF compatibility nor runtime page-size independence (P4-T, §§5–6; S2.4, §4; R2, §§1–2).
- **Bun qualification (retained for a later revisit):** official x64 and baseline 1.4.3 die with SIGSYS on `close_range` before `--version` on API 29/31. All three tested x86_64 builds install on API 37/16 KB but abort during JavaScriptCore initialization; aligned arm64 ELFs were not executed. Termux passes feature probes on 29/31, but only the diagnostic copyfile install starts SillyBunny in the isolated symlinked layout. Successful installs fail the `.npmrc min-release-age=7` control while `ignore-scripts` passes; the pinned-source audit also finds ignored directory/file/git source restrictions. Copyfile does not fix policy or 16 KB failures. Task 2.4's verification is answered negatively; task 4.4 is deferred by confirmed §9.10 (S2.4, §§4, 6).
- **Bun CPU/license limits:** Termux-copyfile child CPU samples are 0.717%/0.467% over one 60 s emulator window on API 29/31, not ARM battery or steady-state estimates. Bun includes JSC/WebKit and other dependency obligations; complete corresponding-source/relink compliance and fake-node/lifecycle-path relocation are not cleared (S2.4, §§4, 6).
- **npm through the APK runtime (S2.5):** `npm ci --omit=dev` installs 675 packages (20,480 files, ~299 MB of content) with every `.npmrc` policy enforced on API 29/36/37. `protobufjs@6.11.4` is the only production package with an install script; `ignore-scripts=true` keeps it suppressed and the server still starts. Git dependencies are refused by `allow-git=none` and could not work anyway: npm clones with `--recurse-submodules`, which needs Git's `git-submodule` shell script, and the runtime deliberately excludes it. npm prints an update notice (11.19.1 → 12.2.0) and its audit reports 54 vulnerabilities in the production tree; neither was acted on. Extracting the npm ZIP took 8.8–9.7 s with a per-file fsync.
- **Termux relocation:** P4-T patches Git/HTTP shell literals and supplies the helper map, templates and CA; follow §§2.2/2.5 exactly. SSH, submodule/GUI/foreign-VCS helpers and writable hooks are not supported by this closure; ARM execution remains **UNVERIFIED** (P4-T, §§3, 6).

- **Node Android build patches (S2.1):** v24.22.0 needs three ABI-scoped patches: V8 GYP trap-handler sources for x64 and arm64 (adapted from upstream PR nodejs/node#65774), and zlib `getauxval` (adapted from ST-android's MIT-licensed patch directory, notice retained). ARMv7 needs only host-toolchain choices: NDK Clang `-m32` host compilers with the `g++ -m32` host linker. The upstream `android-configure` wrapper ignores `configure` failures, so builds must check its success marker. All three patches dry-run apply to v26.12.0 with offsets only; a v26 build is unverified. ARMv7 is build- and ELF-qualified only, and arm64 ran only under x86_64 translation (S2.1, §§3–4, 6).
- **The phantom-process limit defaults to 32 system-wide**, configurable by DeviceConfig, not a per-app entitlement. Foreground importance is not an exemption; excessive-child-CPU enforcement and Android 17 RAM-dependent limits are separate. Keep git and npm work sequential (R2, §2).
- **OEM battery killers** despite the foreground service; the exemption prompt helps but doesn't guarantee survival.
- **Launch token in health probes (P5.4):** probes start only after the server child announces its 127.0.0.1 listener, so an app holding the port before the server binds never receives the token. Residuals: a short race between the child-alive check and the connection; a server that closes its listener without exiting is still probed; and if the announcement line changes, the app waits in Starting until its 30-minute startup timeout (`tests/android-listener-announcement.test.js` catches that). A challenge-response check would remove the first two but needs a server change; it is the maintainers' decision. **Accepted for v1 (2026-10-24, Round 5 Q22):** using a residual needs a malicious app already on the device that wins a sub-second race, each server process gets a new launch token, and a challenge-response would close only the health check, because the WebView sends the cookie to whatever answers on that port.
- **First-run download size and time (P2.6):** on x86_64 emulators over the host's connection, the clone received 80.6–80.7 MB and the first start's `npm ci` 98.5–98.7 MB, and the UI showed 61–86 s after Welcome. On a fresh device the first run also downloads about 2.9 MB that Android charges to the app: Google Play services fetches the emoji font that the app's EmojiCompat asks for, once per device (2026-10-25, Q19). Removing `androidx.emoji2.text.EmojiCompatInitializer` from the merged manifest would skip it, but the user kept the download (2026-10-25). A later start downloads about 157 KB on the prerelease channel (the releases list and `start.sh`'s update check). Mobile networks, ARM devices and `release`/`staging` checkouts were not measured; both downloads grow with the repository history and the dependency tree.
- **Repair migration:** committed `tests/android-bootstrap-scripts.test.js` executes the real installer against temporary Git fixtures: opt-in migration in APK/desktop modes, exact refusal without the flag, unchanged source, migrated config/data/plugins/extensions/secrets/certs, custom relative and reused absolute data roots, and invalid/nested/non-empty-target guards. WSL rerun: 41/41 tests passed. This covers task 2.7's script check, not native Repair/SAF or damaged-metadata recovery (§4.7).
- **WebView exports/capabilities:** S2.7b completes the static downloads audit, not native verification. Immediate-revocation detached anchors require early Blob acquisition; attachment headers also occur on import/preview responses. §4.5/task 5.6 must cover suggested filenames, cookies, 53 file inputs (15 multiple), storage/Web Locks, clipboard, auth/popups, service workers, dialogs and media. Payload bounds, complete interception timing and device behavior remain **UNVERIFIED** (S2.7b, §§3, 6; R2, §4).
- **R2 evidence limits:** dependency metadata/API/source and signing/ZIP fixture checks are not a Gradle integration build, device update/rotation, native-DCL execution, OEM LAN/SAF/provider-race validation or hosted emulator performance proof. Keep those **UNVERIFIED** until their implementation/runtime checks pass (R2, verification).
- **`.npmrc` `allow-git=none` / `allow-file=none`** effects on the server-plugin `npm ci` path. These are already the same on desktop, so just confirm. **Confirmed 2026-10-24 (Round 5, Q23):** both stay.

P4-T component sizes in bytes (component inputs; the release APK sizes of P2.6 follow the table). ZIP estimates are DEFLATE level 9 for native + assets + license inputs, excluding the manifest; the shipping APK also needs Node/npm/app code/notices (P4-T, §4).

| Payload | arm64-v8a | armeabi-v7a | x86_64 (CI only) |
|---|---:|---:|---:|
| Native extracted (17 files/ABI) | 17,427,571 | 12,828,747 | 17,895,603 |
| Native + runtime assets | 17,658,779 | 13,059,955 | 18,126,811 |
| Native + assets + license inputs (93 files) | 18,476,736 | 13,877,912 | 18,944,768 |
| ZIP estimate, same 93 files | 8,670,285 | 7,812,034 | 8,300,699 |

P2.6 release APKs (unsigned, `assembleRelease -PincludeX86_64 -PdefaultRef=release`, all runtime inputs, `81087e54c`). Natives are DEFLATE-compressed so the installer extracts them; release builds do not minify, so the dex is 24 MB.

| Bytes | arm64-v8a | armeabi-v7a | x86_64 (CI only) |
|---|---:|---:|---:|
| APK file | 71,265,976 | 69,510,394 | 71,993,097 |
| Natives extracted (21 files) | 110,319,347 | 100,417,155 | 112,704,659 |
| Natives in the APK | 41,991,531 | 40,235,865 | 42,718,779 |
| `libnode.so` extracted | 92,870,224 | 87,573,196 | 94,787,384 |
| Dex (stored) | 24,008,840 | 24,008,840 | 24,008,840 |
| Assets extracted / in the APK | 7,012,922 / 4,609,912 | 7,012,922 / 4,609,912 | 7,012,922 / 4,609,912 |

---

## Phase 1: Handoff setup [DONE]
- [x] **1.1 Create `feat/android-apk` from `staging`; commit this file as `docs/android-apk-plan.md`**
- [x] 1.2 Re-verify every cited `path:line` fact against current `staging` (v2.0.0 work may have moved things); update this file where needed
- [x] 1.3 Read `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`/`DESIGN.json`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/upstream-sync.md`
- [x] 1.4 Open a **draft** PR to `staging` early (ask the maintainer for the title/body; never write them)

## Phase 2: De-risking spikes (throwaway; results recorded in Notes) [DONE]
- [x] 2.1 Build upstream Node (spike pin v24.22.0; release line open, §9) for arm64 + x86_64 with the NDK (ST-android patches as reference). Confirm `process.platform === 'android'`, `/system/bin/sh` for `shell: true`, ICU/Intl, WASM, worker_threads
- [x] 2.2 Repackage Termux git + bash (+ libs). Confirm exec via symlinks from `filesDir` → `nativeLibraryDir` on API 29, 36 and 37 emulators. Run `git clone --filter=blob:none` over HTTPS, `fetch`, `pull --ff-only`, `stash`, `checkout`, `show`
- [x] 2.3 Prove the npm trampoline: `npm ci --omit=dev` of SillyBunny on the emulator, honouring `.npmrc` (npm ≥ 11.10.0)
- [x] 2.4 Verify that Bun's official Android zip runs on API 29+ (arm64 device or emulator image) and can run `bun install` + the server
- [x] 2.5 Run `install.sh` + `start.sh` from an actual app-launched process with the APK-mode env (prototype flags); verify SELinux identity/resolved executables and list missing toybox commands/Termux path issues. `run-as` is inspection, not production exec proof (R2, §2)
- [x] 2.6 Measure: Node-only APK size per ABI, first-run download (clone + `npm ci`), installed storage footprint, cold-start time; Bun-size comparison deferred with the bundle (§9.10)
- [x] 2.7 Check the 16 KB alignment of every ELF; check `install.sh --migrate-from` on a git checkout; audit how SillyBunny triggers downloads (blob/data URLs)
- [x] 2.8 Write the findings into §10 / Notes, and adjust the plan if anything changes a decision (escalate to the maintainers if it does)

## Phase 3: Base repository changes [DONE]
- [x] 3.1 APK mode in `start.sh`, `scripts/self-update.sh`, `scripts/bootstrap/install.sh`, `scripts/install-prerequisites.sh` (§3.1), with inline comments
- [x] 3.2 `android/min-app-version` + the shell gate in `self-update.sh` + the status file (§3.2)
- [x] 3.3 `src/android-app-gate.js` + hooks in the server-admin `/update` and `/switch-branch` endpoints + the error code (§3.2)
- [x] 3.4 `src/middleware/launchToken.js` + the handoff endpoint + the hook in `src/server-main.js` (§3.3)
- [x] 3.5 Jest unit tests for 3.3 and 3.4; `npm run lint` passes; Node and Bun parity checked
- [x] 3.6 Confirm zero behaviour change without the env vars (run the existing bootstrap smoke)
- [x] 3.7 Add/update `docs/upstream-touch-ledger.md` entries for every modified upstream-origin file, with protecting tests, validation, rollback and owner

## Phase 4: Runtime pipeline [IN PROGRESS]
- [x] 4.1 `android/runtime.lock` format + `android/runtime/patches/` (§5.1)
- [x] 4.2 `.github/workflows/android-runtime.yml`: Node NDK builds per ABI → GHCR (oras) + attestation → digest-update PR (§5.2)
- [x] 4.3 `android/runtime/fetch-termux.sh`: download, verify, extract, ELF-patch git/bash/libs (+ toybox gap-fillers) (§4.9)
- [ ] 4.4 Bun zip fetch + verify (arm64 only). **DEFERRED (2026-10-21):** confirmed Node-only APK decision; revisit gates in §9.10
- [x] 4.5 Sources-archive builder + `THIRD_PARTY_NOTICES` generator (§5.3)

## Phase 5: Android app [DONE]
- [x] 5.1 Gradle project scaffold, manifest, ABI splits, signing configs (debug/test key; release from env), `app-version.properties`, BuildConfig fields, placeholder icon (§4.1–4.2)
- [x] 5.2 Runtime layout installer (symlinks, assets, `installed-runtime.json`) (§2.2)
- [x] 5.3 npm/npx trampoline (NDK C) + Gradle packaging as `libnpm.so`/`libnpx.so` (§4.9)
- [x] 5.4 `ServerService`: env (§2.5), process-group start/stop, log capture and rotation, health probe, restart policy (§4.4)
- [x] 5.5 First-run flow (§4.3)
- [x] 5.6 WebView screen: cookie/handoff, all chooser modes, early Blob/name/cookie-aware streaming downloads, exact-origin bridge/links/auth return, predictive back, persistent storage/locks, clipboard, SW/dialogs/media, version warning and Open in browser (§4.5; S2.7b/R2 cases remain untested natively)
- [x] 5.7 Settings screen (§4.6) + licenses screen
- [x] 5.8 Update checker + PackageInstaller flow + `update-blocked.json` handling + post-update notification (§5.4–5.6)
- [x] 5.9 Repair + leftover-folder management (§4.7)
- [x] 5.10 `DocumentsProvider` for `data/` + `config.yaml` (§4.8)
- [x] 5.11 Android lint clean; every user-facing string is `lorum ipsum` in resources

## Phase 6: CI smoke tests [DONE]
- [x] 6.1 Fixtures: git remote builder, mock LLM, fixture extension, fixture plugin, update-manifest server (§7.1)
- [x] 6.2 Android job in `bootstrap-smoke.yml` with script-step changes detection; API 29 + 36 + 37 x86_64 emulators
- [x] 6.3 Automate steps 1–14 of §7.1 (UiAutomator + Playwright over CDP)
- [x] 6.4 Hook into `nightly.yml`; make it reusable so `release.yml` can call it

## Phase 7: Release integration [DONE]
- [x] 7.1 Split `release.yml` into the `android-apk` + `draft-release` jobs; `defaultRef` from the prerelease flag (§6.2)
- [x] 7.2 `inputsHash` + byte-identical re-attach logic + versionCode and min-app-version CI checks (§6.1)
- [x] 7.3 `android-update.json` generation; APKs, manifest and sources included in `SHA256SUMS` + attestation
- [x] 7.4 `android-signing` environment + CODEOWNERS entries (maintainers create the secrets and the keystore offline; the agent only writes the workflow) (§6.3)
- [x] 7.5 Dry run on a fork or with a test tag (never publish; releases stay drafts)

## Phase 8: Docs guidance and human handoff [IN PROGRESS]
- [x] 8.1 List every `lorum ipsum` location (file + string ID) in a PR comment for the maintainers (§8)
- [x] 8.2 Hand §8's outline to the maintainers for README/SECURITY/CONTRIBUTING. Propose the brief AGENTS.md additions and apply them **only after approval**
- [ ] **8.3 Ask the maintainers to resolve the open caveats in §9 (key holder; registration timing)** ← CURRENT

## Phase 9: RC rollout and stable gate [PENDING]
- [ ] 9.1 Maintainers bump the version to `2.0.0-rc.1` and tag `v2.0.0-rc.1` on `staging` (an agent may bump hardcoded versions only after the target is confirmed, per AGENTS.md)
- [ ] 9.2 Verify that the draft prerelease has the APKs + manifest; maintainers publish it
- [ ] 9.3 A team member runs the manual device matrix (§7.2); fix and iterate
- [ ] 9.4 Stable `v2.0.0`: rebuild with `defaultRef=release` and a bumped versionCode; confirm that RC testers receive the update
- [ ] 9.5 After stable: maintainers decide on reducing Termux visibility (only if seamless, and only while §9.1 permits)

## Notes
- 2026-10-21: Plan created from a grilling session (Appendix A). No code written yet.
- 2026-10-20: `feat/android-apk` is based on `staging` `21b571a1d`; plan committed as `9a12799ad`; draft PR https://github.com/SillyBunnyTeam/SillyBunny/pull/918 targets `staging`.
- 2026-10-20: Task 1.2 re-verified baseline citations/tool inventories and corrected attestation storage, supervisor IPC shutdown, whitelist ranges and Repair validation/copying ranges; task 1.3 governance read completed.
- 2026-10-20: SDK target/compile move to Android 17 / API 37; API 29/36 emulator coverage is retained with API 37 added; Phase 2 device spikes remain unchecked.
- 2026-10-20: Node spike pins v24.22.0; 24.x entered Maintenance LTS today and 26.x becomes Active LTS on 2026-10-28; first-release line choice remains open (§9).
- 2026-10-20: Bun remains experimental/arm64-only; #26415 reports x86_64 idle CPU, not an ARM bug; official Android SIGSYS reports cover `close_range` and `openat2`/`fchmodat2` (§9.3).
- 2026-10-20: npm scripts resolve `sh` on `PATH`; retain `/system/bin` or set `npm_config_script_shell`; expose `bun` only in Bun mode because the in-app updater otherwise selects `bun install` even under Node (§2.5, §3.4).
- 2026-10-20: APK launcher/prerequisite guards landed in `e07841e8f`, bootstrap guards and git-source Repair opt-in in `0fc410941`, minimum file in `3ef41bc6e`, and shell gate in `17c636563`.
- 2026-10-20: Missing/invalid minimums now block with reasons `missing`/`invalid` (needs maintainer confirmation); status includes nullable `required`, `installed`, `reason`, checked `upstream` and `branch`; Server Tools blocks use 409/`android_app_update_required` because 403 messages are hidden (§3.2).
- 2026-10-20: Shell updates pin/check/merge one SHA (`17c636563`); server hooks are implemented but uncommitted, and their pinned-commit follow-up is not reported complete, so task 3.3 stays open (§3.2).
- 2026-10-20: Launch-token middleware `dbae30460` and wiring `2966a6131` add authenticated 204 health, the exact 75-character handoff protocol and launch-cookie preservation during cookie clearing (§3.3).
- 2026-10-20: Repair must pass `--allow-git-source` (`0fc410941`); verified existing copying covers config, relative data root, user plugins, third-party extensions, legacy secrets and certs; absolute data roots are reused (§4.7).
- 2026-10-20: Existing workflow tests constrain signing/reuse (`environment:`, SHA-pinned `uses:`), require script-step Android change detection (no `paths:`), and keep launcher flags out of nightly unit tests; Phase 6/7 layout remains open (§6.2, §7.1, §9).
- 2026-10-20: Governance requires a touch-ledger entry for every modified upstream-origin file; added unchecked task 3.7; no ledger edits made by this plan update.
- 2026-10-20: Phase 3 reports show WSL shell tests 189/189, server-focused tests 88/88, launch-token tests 55/55, root lint and Node/Bun checks passing; full tests lint has 168 pre-existing errors/70 warnings in untouched files; broader Windows regression checks also hit two pre-existing symlink-permission failures.
- 2026-10-20: Task 3.6 remains unchecked pending the draft PR's bootstrap-smoke CI; first unfinished task is 2.1; `updated:` stays 2026-10-21 because the plan's creation date is later than today.
- 2026-10-21: Task 3.3 complete: gate `577a50968` and Server Tools hooks `fd037cbd7`; checked-SHA update merges/runtime-branch checkouts, ordinary checkout fallback unchanged, 409 blocks and stash restoration. P3-B reports 98/98 focused tests, 15 Bun cases and root/scoped lint passing; full tests lint retains its documented baseline failures.
- 2026-10-21: Task 3.6 complete: lead-verified bootstrap smoke run `39470454135` passed all 8 Linux/macOS × Node/Bun × fresh-install jobs on `2c79b06d6`, which contains every Phase 3 shell change. Later pushes rerun it automatically; this is not a later-head or Android-device pass.
- 2026-10-21: Task 3.7 complete in `350ab2c5b`: launcher entry plus existing server-initialization entry cover the upstream-origin files with tests/validation/rollback/owner; fork-owned paths are classified separately. T3.7 reports 77 passed/19 POSIX-only skipped on Windows. Phase 3 is [DONE].
- 2026-10-21: Task 2.4 complete as a negative verification: official x64 `close_range` SIGSYS on API 29/31; all tested x86_64 builds JSC-abort on API 37/16 KB; Termux-copyfile starts only on 29/31 and still ignores `.npmrc min-release-age=7` (S2.4). Maintainer confirmation of Node-only APKs/deferred Bun resolves that task 2.8 escalation (§9.10); 4.4 is deferred, not checked.
- 2026-10-21: Task 2.2 complete: S2.2b (`s22b-api36.md`) validates committed-pipeline outputs in real API 36/4096-byte `untrusted_app` execution: live filtered staging clone, 19 cloned-repository/39 local checks, all native-target links, shell alias and group stop pass. This fills the API 36 leg alongside S2.2/API 29 and P4-T/API 37; API 29's older spike payload was not rerun, and ARM/OEM execution remains unverified.
- 2026-10-21: Task 2.7 remains open for Node ELF checks (S2.1 pending). Termux/Bun ELF audits and the S2.7b downloads audit are complete, with ARM32 4 KB/JSC 16 KB caveats (§10). Committed `tests/android-bootstrap-scripts.test.js` covers git-source `--migrate-from`/`--allow-git-source`; this update reran all 41 cases successfully in WSL, not on-device Repair.
- 2026-10-21: Phase 4 is [IN PROGRESS]: `bf6c8deb4` ignores generated outputs; `52cfed1a5` adds the signed/pinned Termux pipeline; `4dffa53d4` adds integrity tests; `55243cab1` adds lock/schema tests. Task 4.1 stays open for Node build patches; task 4.3 stays open for toybox gap-fillers after 2.5 (P4-T).
- 2026-10-21: P4-T's Phase 5 contract is in §§2.2/2.5: native-only executable targets, 148 tab-mapped Git helper links, template/CA assets, isolated config/attributes/OpenSSL, sanitized shell env and no-profile/no-rc Bash. Git 2.56.0/Bash 5.3.20/CA `1:2026.10.20` are pinned; Node/Bun/npm pins remain null.
- 2026-10-21: R2 corrections applied in their owning sections: SDK `.0`/toolchain and UI/test pins with Kotlin-matrix caveat/fallback, extraction versus ZIP/ELF checks, real-app exec proof, FGS first-run/Stop/notification rules, PackageInstaller callbacks, tap-to-start rationale, target-37 LAN/profile/NSC and developer-verification/signing/provider contracts. Metadata/host checks do not close runtime gates; UNVERIFIED items remain marked.
- 2026-10-21: S2.7b expands §4.5/task 5.6: immediate-revocation exports need early Blob retention; anchor filename and transfer cookies need explicit capture/forwarding; attachment headers may be preview/import. Cover 53 inputs/15 multiple, persistent storage/Web Locks, clipboard/auth/popups/SW/dialogs/media. Audit complete; native transfers/capabilities and Chromium 111 minimum remain unverified.
- 2026-10-21: P4-T per-ABI component/ZIP estimates are in §10, not APK-size claims; task 2.6 remains open. ARM32 retains 4 KB LOAD alignment; ARM/OEM execution and Node/whole-APK 16 KB checks remain pending. First unfinished task stays 2.1; front matter stays phase 2, updated 2026-10-21.
- 2026-10-21: Maintainers confirmed Node-only APKs for now (relayed by user); Bun packaging, selector/switching, size comparison and Bun-specific release copy/sources are deferred. Runtime lock/update manifest keep `bun: null`; non-APK Bun support is unchanged. Revisit only after 16 KB JSC start-up, unchanged `.npmrc min-release-age=7`/source policies and real arm64 tests pass (§9.10; S2.4).
- 2026-10-21: §4.5 explicitly keeps file/universal-file access disabled, including for Blob downloads; chooser URI rejection is a separate control (R2, §4). Earlier Bun-mode notes and Appendix A answers are historical and superseded for APKs by §9.10.
- 2026-10-21: Task 5.1 complete in `cffd1f67c`, `af05a0334`, `0937e8ccc` and `45262ecc2`: checksum-pinned Gradle 9.6.0 wrapper, AGP 9.4.1/Kotlin 2.4.21 project, per-ABI splits (x86_64 only with `-PincludeX86_64`), `app-version.properties` (versionCode 1, versionName 1.0.0), BuildConfig `DEFAULT_REF`/`REPO_URL`/`UPDATE_MANIFEST_URL` with debug-only overrides, environment-only release signing (v2/v3, no v4; unsigned without the variables) and the §4.2 manifest with inert service/provider/receiver stubs. Debug builds use AGP's generated debug key, not a committed test key. Debug/release builds and lint pass (0 errors; 1 warning suggesting a newer Gradle, kept for the pin); the x86_64 debug APK launches on API 37/16 KB without a crash. The launcher label is the product name `SillyBunny`; the only placeholder strings are `scaffold_message` and `server_service_subtype` (`lorum ipsum`, `android/app/src/main/res/values/strings.xml`).
- 2026-10-21: Tasks 2.3 and 2.5 complete (S2.5). On x86_64 emulators at API 37 (16 KB), API 29 and API 36, the real app process ran clone → `npm ci` → `install.sh --no-start` → `start.sh` → authenticated health (204 with the launch cookie, 403 without) → group stop: 61/63 checks each. The two failures are the unavailable Git-dependency positive control (§10). Cold first start including `npm ci` took 60–68 s, warm starts 4.8–5.5 s, and the `install.sh` clone 10–27 s; a versionCode-0 run wrote `update-blocked.json` and still served. Task 4.3 complete: no toybox gap-fillers are needed. Task 2.6 stays open for ARM and production APK sizes and peak storage; the x86_64 download and footprint figures are in §4.3.
- 2026-10-21: Task 5.8 complete in `477797f65` (manifest, signer and download verification), `235bcd62b` (PackageInstaller sessions, explicit mutable per-session callback to the non-exported `InstallStatusReceiver`, consent and cold-launch reconciliation, notifications) and `92a1a975d` (Compose prompt, launch hook, `update-blocked.json` watcher, post-update notice). Lead re-ran it in a private copy: 510 unit tests pass and debug/release builds and lint pass (0 errors; only the pinned-AGP warning). P5.8 reports instrumentation 9/9 on API 37 (16 KB) and API 29, and host-driven replacement passing all 16 channel/case combinations on API 37 and 14 on API 29 (2 skipped: notification-denial cases below API 33). Placeholders: 19 `lorum ipsum` strings in `android/app/src/main/res/values/strings_update.xml` (`update_title` through `update_install_body`). Task 5.4 must replace `NoOpServerController` (through `AppUpdater.serverController`) with an awaited stop and keep tap-to-start; production signing, ARM/OEM installers, API 36.1 developer verification and signing-key rotation remain release/device gates (§5.5, §6.3).
- 2026-10-21: Tasks 2.1 and 2.7 complete (S2.1). Node v24.22.0 builds with NDK r30 for x86_64, arm64-v8a and armeabi-v7a (API 29, full ICU 78.3, static libc++). The stripped executables are 94,787,384 / 92,870,224 / 87,573,196 bytes, about 33–35 MB each DEFLATE-compressed. x86_64 passes 15/15 core checks on API 29 and API 37 (16 KB), and 48/48 in real target-37 app processes. arm64 passes the core and network checks under API 37 translation. The ARMv7 runtime is NOT RUN: no local image has 32-bit userspace. Findings recorded in §4.4, §7.1, §9.7 and §10: no POSIX credential calls, native stderr to logcat tag `nodejs`, and late emulator DNS.
- 2026-10-21: Task 4.5 tooling committed in `41f450622` (the `THIRD_PARTY_NOTICES` generator) and `353fef8e7` (the corresponding-source archive builder, `sources.lock` and tests). The Node-free archive (112,855,912 bytes, 4,000 members) builds byte-identically clean and offline; tamper cases fail closed; 131 Python and 206 Jest tests pass. Task 4.5 stays open until three inputs exist: the Node/npm pins (tasks 4.1/4.2), authentic license texts for four npm dependencies (`@npmcli/agent`, `@sigstore/verify`, `spdx-exceptions`, `spdx-license-ids`; the generator fails closed without them), and the AndroidX library license list from the app build.
- 2026-10-22: Tasks 5.2 and 5.3 complete in `cb2d186f9` (Gradle runtime packaging and the NDK npm/npx trampoline), `2a06897d5` (runtime layout installer), `ae75ce43f` (tests), `8e23d22e8` (the build applies the app's npm.zip rules) and `82d415646` (test fixes). The P5.2 review ran the debug and release gates for all three ABIs (549 unit tests, `zipalign -P 16`, 16 KB-aligned 64-bit natives) and the device suite on API 37 (16 KB) and API 29. First layout took 9.4 s / 2.4 s, the refresh after a reinstall 8.1 s / 4.0 s, and an unchanged launch 0.28 s / 0.06 s. A force-stop during a refresh keeps the previous generation. Debug builds with `-PrequireRuntime` also require the notices (accepted). ARM devices are untested.
- 2026-10-22: Task 5.4 complete in `656b1c413` (session process control and the §2.5 environment), `cd52fc9dd` (ServerManager: health, restarts, logs, notification), `72576040c` and `ed6ab2d9c` (tests) and `b43b4f585` (listener-line test). After the P5.4 review, health probes wait for the server's own listener line (§4.4, §10), and descendants that leave the session are still stopped. The lead re-ran the 657 unit tests and lint on the branch head. The device suite passes 22/22 on API 37 and API 29 with shell stand-ins; the real `start.sh`/Node path on a device is left to the integrated app. Open: a stop during `start.sh`'s git update can leave `.git/index.lock`; the setup notification has no Cancel action; the startup timeout is 30 minutes.
- 2026-10-22: The first-run flow for task 5.5 is committed in `520758690` (resumable controller), `d36744f07` (screens), `47d91555a` and `59a832c1a` (tests). The flow covers storage and metered-network checks, the notification and battery prompts, and `install.sh` as a setup job with logs, cancel and Retry. After the P5.5 review, Retry never touches the checkout while the server or a setup job runs, and a clone killed before git wrote its index counts as partial, not installed (§2.4). The lead re-ran 763 unit tests and lint on the branch head; the device tests pass on API 37 and API 29. Task 5.5 stays open until `MainActivity` runs it with the bundled `install.sh` and a real clone. `REQUIRED_FREE_BYTES` (1,448,171,520 B, a 50% margin over the S2.5 footprint) stays UNVERIFIED until task 2.6.
- 2026-10-22: Task 5.7 complete in `e244162d5` (Settings, Logs and Licenses screens), `7c3f65164` and `2d3353848` (tests). Settings shows the server state with Stop and Start, Open in browser, the git auto-update and app-updater switches with Check now, the bundled runtime versions and the battery exemption. Logs follows the live log and shares a 4 MiB snapshot through the FileProvider after a warning; Licenses lists the bundled `THIRD_PARTY_NOTICES`. After the P5.7 review, a second confirm before the next frame cannot start a second share, and `SettingsDependencies.forActivity` must be created once per host. `eeb8947c7` declares the Core KTX 1.19.1 and Lifecycle 2.11.0 pins (Settings' Lifecycle APIs had resolved transitively at 2.9.4), and `cf8ddb124` skips the no-runtime asset tests in builds that package the runtime. The lead re-ran 848 unit tests and lint on the branch head, also with the runtime inputs staged; the device suite passes 7/7 on API 37 (16 KB) and API 29. The Compose UI unit tests run on SDK 29 and 36 only (Compose's espresso-core 3.5.0 fails on 37), and below API 34 the share test proves the provider's grant handling, not the share intent's own grant. Placeholders: 66 `lorum ipsum` strings in `android/app/src/main/res/values/strings_settings.xml` (`settings_title` through `settings_licenses_unknown_license`). `MainActivity` wiring is left to the integration (task 5.5).
- 2026-10-22: Task 5.10 complete in `a28d320a3` (provider), `96ff05353` and `eda2c7268` (tests). The provider exposes only `data/` and `config.yaml` under a synthetic root, resolves paths without following symlinks and checks every opened descriptor against the resolved entry. IDs carry a root token, the inode and an xattr marker, so they survive restarts and boots that renumber `/data`. Repair's persisted maintenance fence revokes every issued ID and starts a new generation, so file-manager grants must be made again after Repair (§8 copy). After the P5.10 review, rename and delete touch only issued IDs (1,000 files: 20–69 ms and 4 notifications on API 37 and 29), and observers debounce per directory (one save into a listed 500-file folder: 4 notifications). On API 29 an empty private proxy descriptor keeps the AppFuse bridge mounted: Android 10's last-close lock inversion otherwise wedged `system_server` until a reboot. The lead re-ran 888 unit tests and lint on the branch head; the device suite passes 29/29 on API 37 (16 KB) and API 29. A scratch DocumentsUI client outside the repository passed the tree (80/80), persisted (70/70) and narrow-grant (29/29) picker checks on both. Open: the first install must call `notifyRootsChanged`, Repair (task 5.9) must fence with `beginMaintenance`/`endMaintenance`, unlisted folders get no live updates, and a custom `dataRoot` is not followed (§9.12). Placeholders: the `lorum ipsum` exception messages in `DataDocumentsProvider.kt` and `documents/*.kt`; no string resources.
- 2026-10-22: The release tooling for tasks 7.2 and 7.3 is committed in `c6e079de4` (`inputs-hash.mjs`), `5b178848f` (`update-manifest.mjs`, and `manifest-rules.mjs`, a port of the app's manifest parser), `e38b8db03` (`release-decision.mjs`) and `314d43b31` (tests). After the P7.2 reviews, `inputsHash` v2 also covers `install.sh` and the `.gitattributes` files (§6.1). The decision refuses to re-attach while `runtime.lock` leaves Node or npm unpinned (`--allow-unpinned-runtime` only builds). Generation checks each APK's bundled `runtime-manifest.json` against the manifest, which refuses `-PincludeX86_64` builds. The lead re-ran the 72 release-tooling, workflow and lock tests and lint; P7.2 also ran real apksigner/aapt2 37.0.0 on test-signed APKs in WSL and on Windows. Both tasks stay open until `release.yml` runs the scripts (track p7x). The scripts' messages are plain English: they are maintainer diagnostics, not app copy. Open for maintainers: changes to `android/release/**`, Android tests or `min-app-version` also force a rebuild and a versionCode bump. An x86_64-primary device running the ARM APK under translation got `INVALID_MANIFEST` from the update check, because the app picked `Build.SUPPORTED_ABIS[0]`; `7b54d607f` fixed it. Root lint does not cover `android/release/*.mjs` yet. Once Node and npm are pinned, the Gradle build must check `node.json` and `npm.json` against `runtime.lock` (lead, after task 4.1).
- 2026-10-22: Task 6.1 complete in `d8b02c02a` (fixture servers), `8b3af2664` (repository, manifest and seed-data builders), `417389a38` (launcher) and `63e755dc4` (tests). `tests/android-smoke/` holds a read-only git smart-HTTP remote, an OpenAI-compatible mock LLM (JSON and SSE), a static update server, builders for the SillyBunny remote, a fixture extension and a fixture server plugin, an `android-update.json`/`releases.json` generator under the app's rules, and a data-seed checksum helper. The launcher binds random ports (never 4444), prints one JSON line with the `adb reverse` arguments, and stops when stdin closes. After the P6.1 review, malformed request targets get a 400 instead of crashing the launcher, the tests always clean up, and a half-built or mismatched reused scratch is refused. The lead re-ran the 110 tests on Windows (108 passed, 2 platform skips) and lint; P6.1 also ran them in WSL. Open for task 6.3: step 8 cannot use the server-plugin apply-release endpoint against the http fixture, because it accepts only https and ssh URLs without a port, so step 8 clones the plugin into `plugins/` and relies on the startup update. A default build clones `staging`, so the update server needs `--base-url` to publish `releases.json`. `tests/android-smoke/update-manifest.js` duplicates the parser port that `android/release/manifest-rules.mjs` already provides. Placeholders: the `lorum ipsum` response bodies, help and error texts, commit messages, and seed names and messages listed in P6.1.
- 2026-10-22: The browser handoff now answers `200` with a minimal page that moves to `/` by meta refresh (`c008eb38f`). P5.6 measured in Chrome 145 on API 37 that the `302` landed on the gate's 403: Chrome does not send the `SameSite=Strict` cookie on the redirect of a navigation that another app started, and a reload does not help. The page's same-origin navigation carries the cookie. P5.6 also measured that after Open in browser, Chrome holds the launch token as a `127.0.0.1` cookie and sends it to every `127.0.0.1` port, so a page that any app opens on another loopback port receives it. Lead decision: the integration track first measures a per-install `http://<label>.localhost:<port>` web origin (a random 128-bit label; Chromium resolves `*.localhost` to loopback itself, and the server's host check already allows it). A host-only cookie on that origin never reaches other ports, in the WebView or in the browser. If the measurements hold, it replaces the in-app loopback proxy; otherwise the proxy is built as planned and Open in browser keeps a recorded exposure.
- 2026-10-22: The file chooser and downloads for task 5.6 are committed in `0f80633c1` (chooser), `6cdcc39ec` (downloads and page exports), `41581ddd2` and `8821c3f9e` (tests). The chooser serves the SAF open, multiple-open and save modes, plus the API 37 folder and read-write modes; each request completes exactly once and a pending one survives activity recreation. Page exports (Blob and `data:` URLs) go through a document-start capture script and an exact-origin `addWebMessageListener` bridge with ordered, acknowledged and bounded chunks. HTTP downloads use an app-owned GET that checks the cookie and every redirect hop, and only with evidence that the download was a GET. Every save goes to a document the user creates or chooses to replace: a replaced document is emptied only once the new export is complete and fits, and a document the picker created is removed before its stream closes when the save fails, which avoids an `android.process.media` crash on API 37 (P5.6b). Without the bridge (WebView 74), exports offer Open in browser. The lead re-ran the debug and release gates (998 unit tests, lint 0 errors); P5.6b ran 49 device tests on API 37 and API 29 (23 bridge-only tests skipped on 29). The first gate run lost 36 documents tests to inotify exhaustion: Robolectric's FileObserver shadow never closes its WatchService, and parallel Gradle runs share the 128-instance limit, so `868f41b7c` closes it when an observer stops. Task 5.6 stays open until track p56int wires the shell to these implementations.
- 2026-10-22: The updater audit fixes are committed in `1daca2724` (archive signers), `da0e48819` (stable downloads and the prerelease check), `e28df3c21` (install sessions, blocked updates and the server restore) and `c904ea1fd` (device tests). Below API 34 the archive check also requests `GET_SIGNATURES`, because base Android 13 collects certificates only then. An approved session that the platform finishes before its final status arrives ends with the platform's result, not ABORTED. Android 11's restart after the install-source grant changes keeps the verified download. A met `newer` requirement in `update-blocked.json` no longer asks for an update (missing and invalid ones stay blocking). A prerelease manifest that failed to download above the installed version reports a network error, not up to date. Launch reconciliation abandons owned sessions that no install tracks, and session queries run off the main thread. Stable APKs come from the release that served the manifest (§5.5, §6.1). `ServerController.resumeAfterAbandonedUpdate()` restores a server that an update stopped; it can run while no activity is visible, so task 5.4's implementation (track p5int) defers a foreground start to the next visible activity. `7b54d607f` (lead) picks the update APK in `Build.SUPPORTED_ABIS` order, so an x86_64 device that runs the ARM APK under translation finds its update. The lead re-ran the debug and release gates (1074 unit tests, lint 0 errors); P5.8 ran the new session tests 3/3 and the update UI tests 9/9 on API 29, 31 and 37. Not run: API 30 and API 33 (no images; AOSP sources back those fixes). Open: an install that is still waiting 60 s after its prompt, unanswered or approved but queued behind other installs, is abandoned as ABORTED and the user must retry.
- 2026-10-22: The WebView shell for task 5.6 is committed in `dbcfa5627` (Open in browser), `fc2b271dd` (shell), `eafd11fa7` and `5f1680b9f` (tests). One WebView survives recreation and rotation without a reload and loads `/` only after the launch cookie is set. The exact origin stays in the app, other http(s) links go to the browser, and other loopback ports, `intent:` links and script-opened popups are blocked. The shell recovers from renderer death, handles dialogs, fullscreen and Back, and warns below WebView 111. The lead re-ran the debug and release gates (1076 unit tests, lint 0 errors); P5.6a ran its 18 device tests on API 37 (WebView 145, Chrome 145) and API 29 (WebView 74). Two cookie leaks stay open for track p56int (the `*.localhost` origin, or a loopback proxy). After Open in browser, the browser holds the launch token as a `127.0.0.1` cookie and sends it to every loopback port, so any app can collect it with one `ACTION_VIEW`. WebView's subresource redirect hops and WebSockets carry the cookie to other loopback ports too. The clipboard and `speechSynthesis` gaps (§4.5) ship as known limitations with the frontend unchanged. Task 5.6 stays open until track p56int wires the shell.
- 2026-10-22: Repair and leftover-folder management for task 5.9 are committed in `e6712d22c` (Repair), `dfda23fa6` (screens), `a700ee6bc` and `c427f3595` (tests). Repair stops the server, puts the documents provider in maintenance, moves the checkout aside and reinstalls with `--migrate-from` and `--allow-git-source`; it never deletes. Its record survives process death, and the next launch resumes Repair instead of starting the server. Leftover folders are listed, measured and deleted only after a confirmation that names the folder, without following links. The lead re-ran the debug and release gates (1247 unit tests, lint 0 errors); P5.9 ran its device tests 9/9 on API 37 and API 29. Open: when a failure leaves a checkout in place, the provider serves it again, and writes made through it before the next Retry move with it into a kept folder. An unreadable Repair record blocks Repair and protects every leftover. Task 5.9 stays open until track p5int wires Repair into the launch flow and Settings with the real server host.
- 2026-10-22: Tasks 4.1 and 4.2 complete in `20bf69b7f` (the three Node patches, their series and the ST-android license), `926cde326` (Node and npm pins), `277e8b208` (`build-node.sh`, `fetch-node.py`, `build-npm.py`, `update-node-digests.py` and their tests) and `f059fd4d7` (`android-runtime.yml`). The local x86_64 build from the pinned inputs took 6,585 s and its ELF audit matches S2.1; p523's Gradle prepare task accepted the staged `node-out/` and `npm-out/`, and `npm.zip` is byte-identical to S2.5's. The lead re-ran the Python suites (pipeline, Termux packaging and sources), the 286 lock, workflow and release-tooling tests, lint and the debug and release gates. The workflow has never run; see §5.2 for the settings it needs. A `runtime.lock` change makes the staged Termux outputs stale (`runtime-files.json` records the lock's SHA-256), so re-run `android/runtime/fetch-termux.sh` after every lock change, including each digest PR. Workflow, job and step names, the bot's commit message and the scripts' error codes are maintainer text in plain English; the digest PR's title and body and the manual-run input description are `lorum ipsum`. Release notices stay blocked until track p45b supplements four npm licenses in `notices.py`.
- 2026-10-22: Task 4.5 complete in `9399ce714` (license texts), `21fb56123` (`notices.py` and `sources.py`, with tests) and `11daa0dcd` (the Gradle notices tasks and the runtime pin check). The lead re-ran the debug and release gates with staged inputs (1247 unit tests), the runtime Python suites and the APK notices check. Node attribution is required only once `runtime.lock` pins a packaged Node binary. Before the first GHCR publish the only arm Node builds are S2.1's spike builds, and the release decision refuses an unpinned Node anyway.
- 2026-10-22: `9396c1f6b` adds `android/app/lint.xml`, which ignores lint's two newer-version checks (AndroidGradlePluginVersion and GradleDependency), because versions are pinned on purpose. Android lint now reports 0 errors and 0 warnings in debug and release. Task 5.11 stays open for the final placeholder pass.
- 2026-10-22: Task 5.6 complete in `23991f19a` (the per-install web origin and the localhost line in the network security config), `532016691` (file transfers scoped to that origin), `2b08e0cc6` (the web screen on that origin with the real chooser and downloads) and `494991e0c` (a real-frontend smoke test). The lead re-ran the debug and release gates (1281 unit tests, lint 0 errors). P5.6 ran the shell suite (21 tests) and the transfer suite (49) on API 37 and API 29 on wiped boots, and the real-frontend smoke on API 37: character, chat and backup exports, a file-input import and the OpenRouter return. WebView 74 cannot parse the frontend, so on API 29 the smoke checks only the page load and the version warning. The review found one coverage gap: the device test for a form POST from another port now proves only that such a frame is refused, so the never-replay rule rests on the Robolectric test `appOriginDownloadsNeedGetEvidenceToo` until the device test loads that frame through a redirect. `MainActivity` wiring is task 5.5.
- 2026-10-23: Stage A of tasks 6.2-6.4 is committed in `e11f0ebf9` (a debug-only hook provider), `141355a84` (the UiAutomator side), `c881205be` (the 14-step runner, `tests/android-smoke/run-smoke.js`) and `166b3bb68` (`android-smoke.yml`, called by bootstrap-smoke for Android-relevant pull requests, by nightly and by release). The smoke reports `skipped` with a notice while `runtime.lock` leaves Node unpinned. After the P6.x reviews, step 6 needs the posted post-update notification (id 5801 on `app_updates`), and the Android change list includes the smoke's own test-package inputs. The lead added a `ref` input, so nightly tests the staging SHA that its gate resolved (the event commit of a scheduled run is the default branch's tip), and nightly's report now counts the Android result. Stage B (track p6x) runs the 14 steps on devices after `MainActivity` is wired (task 5.5). Scheduled workflows run from the default branch, so the nightly changes take effect only after they reach `release`.
- 2026-10-23: Tasks 7.1, 7.3 and 7.4 complete, and task 7.2's checks now run in the release workflow: `6c5028398` (the build recipe, signing, the staged-runtime check and the manifest attach, under `android/release/`), `117fc4f86` (`release.yml`: decide, android-build, android-smoke, android-sign, android-reattach and draft-release) and `4653f2943` (CODEOWNERS for `android/**`). Only `android-sign` uses the `android-signing` environment and sees the four signing secrets; the maintainers create that environment, its secrets and the keystore (§6.3). An unpinned `runtime.lock` skips the APKs with a notice while no release has `android-update.json`, and fails before drafting after that. After the P7.x review, the unsigned APKs and the sources archive are kept for 30 days, as long as the signing approval can wait, and the draft job makes the release decision again right before drafting, so two tags that wait for approval cannot draft the same versionCode. The lead re-ran the release, workflow and smoke suites in WSL (642 tests), lint, actionlint and the debug and release gates (1281 unit tests). Open: the signing certificate is not compared with the previous release's; a re-run of draft-release creates a second draft; never publish a draft whose manifest attach failed. Task 7.5 (the fork dry run) is next.
- 2026-10-23: Tasks 5.5 and 5.9 complete in `1bdb51c49` (`install.sh` as a runtime asset), `e9c9e9980` (`ServerManager`), `0fadc94a4` (the build's repository URL for `install.sh`), `44e768f52` (the launch flow in `MainActivity`) and `255b3e22c` (the device run). Every launch follows §2.4: the updater hook, `RuntimeLayout.ensure` (its error screen starts nothing), an unfinished Repair, the first run while no finished checkout exists, then a server start from the visible activity, with a screen for every `ServerState`, a launch cookie per server session and a native bar (Settings, Open in browser). `ServerManager` lays out the runtime itself, so a `START_STICKY` recreation without `MainActivity` works. After a failed or declined APK install it restores a server that `stopForUpdate()` stopped, at the next visible activity when none is visible, and it removes a stale `.git/index.lock` when no run or setup job of the app is alive. First run and Repair pass `--repo BuildConfig.REPO_URL` to `install.sh`; in release builds that is the official URL, `install.sh`'s default. The real-runtime device run (first run, relaunch, Stop and Start, a killed node, Repair, seeded data unchanged, the bar and the keyboard at phone and large sizes) passed on API 37 (16 KB pages) and API 29 against a fixture remote. The API 29 factory image's WebView (74) cannot run the frontend, so there the evidence is the page load with the launch cookie and the version warning. After the P5.int review, showing the first run marks notifications as asked, so a Repair opened from it does not ask again. The lead re-ran the debug and release gates (1335 unit tests, lint 0 errors and 0 warnings).
- 2026-10-23: Task 2.6 measured the integrated app (P2.6, `81087e54c`), and `ae118bac4` applies the results. Unsigned release APKs: arm64-v8a 71.3 MB, armeabi-v7a 69.5 MB, x86_64 72.0 MB; natives extract to 110.3/100.4/112.7 MB (`libnode.so` 92.9/87.6/94.8 MB), and the unminified dex is 24 MB. On x86_64 emulators (API 37 with 16 KB pages, API 29), cloning `feat/android-apk` from GitHub and installing from the npm registry, the clone received 80.6–80.7 MB and `npm ci` 98.5–98.7 MB, and the UI showed 61–86 s after Welcome. The app's data directory peaked at its final size, 868–894 MB by `du` (735–761 MB by `df`); natives add 113 MB. `REQUIRED_FREE_BYTES` is now the measured peak plus 50%, 1,341,351,936 B, which replaces the UNVERIFIED value in the task 5.5 entry of 2026-10-22. The real `StatFs` check shows the storage error 16 MiB below the threshold and starts the install 16 MiB above it on both images. The metered-network estimate now uses the measured downloads (clone 81 MB, 179–189 MB in total). Start-up of the debug build (median of 5): API 37 cold 9.6 s to the loaded page and 19.7 s until the frontend has booted, warm 1.5 s and 12.2 s; API 29 cold 6.4 s and warm 0.54 s to the loaded page (WebView 74 cannot run the frontend). ARM devices are NOT RUN (sizes only); the Bun comparison stays deferred (§9.10). Release builds do not minify; R8 would shrink the dex, but it needs keep rules and a device re-run, which is the maintainers' decision. With these findings in §4.3, §10 and Notes, task 2.8 and Phase 2 are complete. The lead re-ran the debug and release gates (1335 unit tests, lint 0 errors and 0 warnings).
- 2026-10-23: Tasks 6.2–6.4 complete. Stage B of P6.x ran the 14 steps of §7.1 against the integrated app: `7eb787f57` (the debug hook can kill an app process), `00b2d1bef` (the UiAutomator side: step 1 ends at the running server, and scrolling and permission taps hold on CI's 320x640 screen), `0a2ea1783` (the workflow installs Chromium) and `d6064ea90` (the runner). All 14 steps pass on fresh installs on API 37 (16 KB pages), API 36 and API 29 with CI's 10-minute idle, in 16–21 min per image locally; after the review, API 37 and API 29 passed all 14 again and API 36 passed steps 1–3, 9 and 14. Stage B fixed what the three images exposed: WebView 74 (API 29) cannot run the frontend, so the web steps drive it in a host Chromium and the WebView checks use the page's own DevTools socket; Playwright attaches to WebView 133 (API 36) without its default browser settings; system error dialogs after boot are dismissed; and step 10 kills node through the debug hook, because `run-as` on API 29 cannot. A crash of the app during a step now fails that step (`app-crash`), from the device's crash log; an abort or a segmentation fault of the app's Node writes no crash dump, so this check cannot see one. Recorded errors leave out the per-install origin label, but a failed run's `logcat.txt` artifact still has it. Open for the maintainers: the android-36 default image's WebView 133 can abort the app right after the frontend's restart cache-clear reloads (its "dangling raw_ptr" check is fatal), so CI's API 36 job can fail with `app-crash`; an API 36 image with a newer WebView, or a change to `public/scripts/sillybunny-restart-cache-clear.js`, would avoid it. The smoke reports `skipped` until `runtime.lock` pins Node, so its first real CI run follows the first published runtime. The lead re-ran the debug and release gates (1335 unit tests, lint 0 errors and 0 warnings), the smoke, workflow and release suites in WSL (333 tests), ESLint and actionlint.
- 2026-10-23: Task 5.11 complete. AGENTS.md has asked for `TODO(copy)` since 2026-10-22, so `7540742c0` (the app), `56a01695a` (the runtime pipeline), `d68dd5786` (the bootstrap and self-update scripts), `fa8c9d6a2` (the server's Android gate) and `1780c402f` (the smoke) replace `lorum ipsum` with it on every line this branch added; lines that staging already had keep `lorum ipsum`. All 276 string resources other than `app_name` are placeholders, and the handoff page's link also has `data-sb-copy-placeholder="true"`. Two test values whose exact text matters became plain values instead: the mock LLM reply, which must stream as several chunks, and a manifest URL that must stay invalid. `152c8ba25` merged staging first. The lead's gate on the result: 1335 unit tests, Android lint with no issues in debug and release, the runtime pipeline's Python tests (234), root and tests ESLint, and the full Jest suite, whose 13 five-second timeouts in 7 suites that the change does not touch pass on a re-run. All 14 smoke steps passed again on API 37 (16 KB pages) with the converted text. `ed9468991` records the Android guards in `LESSONS.md`.
- 2026-10-23: Open follow-ups for the maintainers, forwarded by the track reviews and not applied: after this branch merges, `nightly.yml` and the workflows it calls need an `actions/*` pull request into `release`, because scheduled runs use the default branch's copy (AGENTS.md); release minification (R8 needs keep rules and a device re-run); `androidx.webkit` 1.17.1 to 1.18.0, and explicit lifecycle, coroutines and Espresso dependency declarations; a debug-only `-PdebugDefaultRef`, so measurement builds need no patched ref; `AppDeviceUi.allowPermission` in the end-to-end tests taps once and can hit the dropped tap on API 33+ (`SmokeUi` taps until the dialog closes); an abort or segmentation fault of the app's Node leaves no crash dump; a failed smoke run's `logcat.txt` keeps the per-install origin label; one API 37 first run received 2.9 MB before the clone that P2.6 could not attribute; and with the Welcome prompt never answered, Quick Image Gen offered its "legacy browser-only settings" import after several boots on one origin (`public/scripts/extensions/quick-image-gen/index.js`).
- 2026-10-24: Tasks 8.1 and 8.2 complete. The task 8.1 PR comment (https://github.com/SillyBunnyTeam/SillyBunny/pull/918#issuecomment-6343458221) lists every `TODO(copy)` placeholder at `f514ac58e`: 276 string IDs in 9 files, 157 lines in 31 files of app code, scripts and workflows, and 127 lines in 24 files of tests and smoke fixtures; a later change to those lines needs the comment regenerated. For task 8.2 the user approved the AGENTS.md smoke command, committed in `ab315813c`; §8's outline for README, SECURITY and CONTRIBUTING stays in this plan for the maintainers. Task 8.3 is on hold at the user's request.
- 2026-10-24: The user decided to keep our own copy of the pinned Termux packages, because Termux's pool keeps only the newest version of each package and the fork's release dry run failed on a removed `ca-certificates` deb. `2d6c55978` refreshed this branch's pins first (`ca-certificates` `1:2026.10.20-1`). The copy is the input mirror (§5.2, §5.3): `46788240f` (the `mirror` object in `runtime.lock`), `5611d0904` (the reader in `sources.py`, `package-termux.py` and `fetch-node.py`), `346ec4940` (`runtime-mirror.py`), `4ca7927b8` (the `mirror` job) and `b2f7555a9` (`decide`'s check and the mirror-only release recipe). It copies the sources too, not only the debs: publishing GPL debs publicly needs their corresponding source in the same place, and several source archives are generated on demand by their hosts. The set at `2d6c55978` has 629 blobs and 210,702,287 bytes (tag `inputs-d15b0b5435d0`). The track's reviews found that release builds still fetched the four Node source files from their origins (the recipe now runs `build-sources.sh` before `build-npm.py --offline`), and that an unreachable token endpoint cost a full curl retry cycle per pin (a failed token request is now cached for the process). The lead fixed a token answer that a retried 429 or 503 corrupted: curl appends the retried answer on stdout, so it now goes to a file, which curl empties before each retry. The lead re-ran the runtime Python suites (164, 32, 16 and 73 tests), seven Jest suites (444 tests), actionlint, a real-curl retry test against a local stand-in registry, and anonymous reads of the fork's package. On the fork, GHCR accepted the 629-layer manifest: the `mirror` job of run 40043059972 staged the set in 42 s and pushed it in 2 min 17 s, and the anonymous `--check` passed in the job and again from WSL. In WSL, a fresh clone of the fork's dry-run branch then ran the release recipe's three mirror-only input steps (`fetch-termux.sh`, `build-sources.sh --require-node`, then `build-npm.py --offline`) in 3 min 20 s: its empty caches received the set's 210,702,287 bytes (44 debs and 586 source files) anonymously from the mirror, and nothing came from the origins. Open: a release run that builds from the mirror (the fork's next release candidate); the org package must be public before `--check` passes; the package description annotation is `TODO(copy)`.
- 2026-10-24: The user answered the 25 questions still open before this PR can close. Appendix A, Round 5 records them, and §9 and §10 carry the decisions. Only developer verification stays open (§9.1). Seven tracks implement the rest: Node 26 with the 2.9 MB trace (Q3, Q19), the launcher icon (Q8), the signing-certificate check (Q12), webkit 1.18.0 with explicit dependencies, `-PdebugDefaultRef` and `allowPermission` (Q14 to Q16), crash records and the setup notification's Cancel (Q17, Q21), the local-network permission and the `dataRoot` notice (Q6, Q7), and Quick Image Gen's legacy-settings offer (Q20).
- 2026-10-24: The release workflow refuses APKs signed with a different certificate (Q12, §6.3), which closes the 2026-10-23 entry's open certificate item: `b46e848da` (the release decision names the certificate that every earlier `android-update.json` shares, and a check mode compares one with it), `5f85730b6` (`release.yml` compares in `android-sign` before the manifest and its upload, in `android-reattach` before its upload, and in `draft-release` against a fresh decision before `release create`) and `2ac6596d4` (tests). Each of the track's 13 mutations of the check made tests fail. The review's one finding was that no test stopped a check step from setting `continue-on-error`; the lead added that assertion and confirmed that it fails when one does. The lead re-ran the four release and workflow suites in WSL (164 tests) and lint. Four new `TODO(copy)` texts in `release.yml` need the task 8.1 PR comment regenerated. Open: a draft is invisible to other runs' decisions until its `android-update.json` is attached, so in that window another tag's run can still draft with another certificate (versionCode has the same window); `--exclude-tag` hides the current tag's own earlier drafts, so a full re-run after a key change can draft a second release of that tag, which later releases then refuse; nothing pins the expected certificate, so the first APK release sets it, and deleting every `android-update.json` resets it; `draft-release` compares the APKs' own signer with the manifest only when the runner has apksigner (`--verify-tools auto`).
- 2026-10-25: Quick Image Gen no longer asks to import legacy browser-only settings on every boot (Q20): `c6c3cc9a5` (the fix) and `407779f15` (tests). While the Welcome prompt stays unanswered, the host skips every settings save, so Quick Image Gen never confirmed its first sync id, and from the second boot on its own caches looked like legacy data. Before it writes its caches, it now records an unconfirmed claim on the id, bound to the server user; a later boot reuses the id without the question only while the server has no sync id, and the claim is removed once a host settings save has stored the id. The review's major finding, that the claim outlived the session whose save stored the id, is fixed. The track reproduced the bug and checked the fix in headless Chromium against a private server; the new suite's 17 tests catch all 18 mutations. The lead re-ran the four Quick Image Gen suites (64 tests) and lint. Open: if a save stores the id but its readback fails, or a host emits no `SETTINGS_UPDATED`, another server on the same origin with the same user handle can adopt this browser's Quick Image Gen caches and id without asking, and the two servers then share the gallery and prompt history in this browser. Upstream Quick Image Gen (platberlitz/sillytavern-image-gen) has the same defect.
- 2026-10-25: The launcher and notification icons are the pixel-art bunny from `public/img` (Q8): `6f2ff89b7` (the adaptive icon: a vector foreground with one path per color at 2 dp per cell, the light muzzle color `#FFF9F2` as background, and a monochrome layer for themed icons) and `2eccba198` (the server and update notifications' small icons). The track recovered the art's 24 x 30 cell grid from `icon-256x256.png`, and the 256 px file reproduces exactly. The review's one finding: the outline color painted under every cell drew dark seams between light colors (95 to 137 pixels in an API 37 drawer screenshot). The lead now paints the body color under every cell, then the light colors, then the dark ones. Against an ideal render at 112 cell sizes and offsets, the reviewed order had 43,776 pixels more than 16 luminance levels too dark; the new order has none too dark and 2,284 too light. On the API 37 launcher the icon now shows 0 dark seam pixels and 1 light one. The lead re-ran the Gradle debug gate (1,335 unit tests, lint clean). Open: the API 37 image never draws the server notification's small icon (the shade row shows the app icon); cell edges fall on half pixels at hdpi; the `MonochromeLauncherIcon` lint check stayed silent on a copy without `<monochrome>`, so only the compiled APK and a themed screenshot verify that layer.
- 2026-10-25: Android 17's local-network permission and the `dataRoot` notice are in (Q6, Q7): `e422b1b6c` (the manifest permission and the optional Welcome item), `520ed39f2` (the Files app summary) and `4eb112aa5` (the Settings row and the Maintenance notice). On API 37 and later only a tap on the item or the row asks; Continue never asks, and no answer blocks the install. The app stores the last denial, so once Android stops showing the dialog, the item says so and the row opens the app's system settings page, also after process death. On the API 37 emulator, a host at 10.0.2.2 timed out from the app process and from a child process before the grant and answered both after it, and loopback worked before the grant, so the Node server needs the permission only for a backend on the LAN. The summary and the notice show when `config.yaml`'s `dataRoot` resolves outside `data/`, resolved the way the server does; YAML that the reader cannot read exactly gives no notice. The track's device runs passed on API 37 and API 29, process death during the request included. Of the review's three minor findings, one refuted the report's claim that API 37 publishes `USE_LOOPBACK_INTERFACE` (the android-37.0 SDK and the `Manifest.permission` reference do not list it), so §4.2 stays as written; the other two are open below. The lead re-ran the Gradle debug gate over these commits alone (1,377 unit tests, lint clean). Twelve new `TODO(copy)` strings in `strings_ux.xml` need the task 8.1 PR comment regenerated. Open: after the server's own settings change `dataRoot`, the Files app can keep the old summary, because the provider notices a direct write of `config.yaml` only while a client watches its root folder, and DocumentsUI caches roots across app processes; the first-run controller reads and writes the stored answer (a small preferences file) on the main thread, against its rule that blocking work runs on the IO dispatcher; a SIGKILL while the dialog is in front loses that answer, which then costs one tap that shows nothing; one of 8 runs of the API 29 device class, right after boot, ended when the system timed out waiting for the documents provider, and the other 7 passed; real OEM builds are not checked.
- 2026-10-25: `androidx.webkit` is 1.18.0, the build declares every library that the app imports, debug builds take `-PdebugDefaultRef`, and the end-to-end tests' `allowPermission` taps until the dialog closes (Q14 to Q16): `e8e6901ec` (the version catalog and the build script) and `4ab1640b8` (the end-to-end test helpers). The 23 libraries that the app's sources and tests imported but got only through other libraries are declared at the versions the build already resolved, so the four runtime classpaths are unchanged except for WebKit; no source imports Espresso, so it stays undeclared. `-PdebugDefaultRef=<branch>` sets only the debug build's default ref; every build that sets it checks the name with the rules of `git check-ref-format --branch` (the same verdicts as git 2.43.0 and 2.54.0 on 3,106 names), and release builds ignore it. `allowPermission` taps again while the dialog stays, for at most 10 s, and returns false if it stays open. `AppDeviceTest` now also waits for the notification answer before it taps Battery and Continue, which fixes an API 37 run where a slow permission window took those taps; it passed 7 of 7 on API 37 and on API 29. The review found no blocker; its one plan finding, the WebKit 1.17.1 pins in §4.1 and §4.5, is fixed here. The lead re-ran the Gradle debug gate over these commits (1,377 unit tests, lint clean). Open: `RepairDeviceTest` expects Repair to show `staging`, so device-test APKs must keep the default ref; the crash track's new `CrashDeviceTest` still waits for the notification permission the old way.
- 2026-10-25: The APK's Node is v26.12.1 with npm 11.20.0 (Q3), the newest 26.x on 2026-10-25: `492c5bb3d`. The lock tooling wrote both locks, the tarball's signature verified with the pinned keyring, and the three Android patches apply to v26.12.1 with no fuzz (only their hunk headers changed). Node 26's configure builds Temporal when it finds cargo and rustc, as on GitHub's runners, but for the build host instead of Android, so `build-node.sh` hides both and the configure check requires Temporal off: unlike official Node 26, the APK's Node has no `Temporal` global, and nothing in the server or its dependencies uses one. The track built x86_64 (every ELF and 16 KB check passed; `libnode.so` grew 5.2 %), ran the full server test suite under Node 26 and under 24.22.0 with the same results (5,223 passed, 3 skipped), started the server under Node 26, and passed all 14 smoke steps on API 37, 36 and 29 with Node 26.12.1 on the device. Q19 is answered: the 2.9 MB is Google Play services' one-time download of the emoji font that the app's EmojiCompat asks for, charged to the app (§10). The review found no blocker. The lead re-ran the Gradle debug gate (1,377 unit tests, lint clean), the four runtime Python suites (73, 164, 32 and 16 tests) and the seven lock and workflow Jest suites (455 tests), and `update-node-digests.py --reset` left both locks unchanged. Open: the ARM builds with their ELF and 16 KB checks, the digest pins and an input mirror set for the new pins wait for the fork's CI build; the local x86_64 build took 10,445 s against 6,585 s for 24.22.0 (not like for like), and each ABI's CI job has 330 minutes; on API 37 with real origins, `AppDeviceTest#firstRunReachesTheUi` did not show the UI within the track's 900 s stop (the test allows 40 minutes), and that run is not triaged; whether to keep the emoji font download is a product decision.
- 2026-10-25: Crash records and the setup notification's Cancel are in (Q17, Q21): `ba2e32682` (the records and Share logs), `5d2203739` (the server manager and the notification), `3a341bcd2` (first run and Repair), `de4320b38` (the device test) and `071477a6b` (the local-network answer off the main thread). Each server launch asks Node for a compact fatal-error report, without the environment or the network interfaces. An exit that no stop asked for, with a status other than 0, leaves one record in `filesDir/crash/records`: the status and signal, the uptime, the last 200 lines of the server log and of Node's logcat output, and the report (1 MiB at most), with the launch token redacted. The newest five stay, pruned by sequence number, not by the clock. Share logs puts them first, newest first, in up to half of its 4 MiB; the Files app and the FileProvider cannot reach them. While a setup job runs, its notification has a Cancel action that works like the in-app Cancel, and a late or repeated tap does nothing. The review's major finding (a service device test did not expect the new `NODE_OPTIONS`) and its three minor ones (Settings' share test failed while records existed, pruning by the clock, a KDoc) are fixed; the lead applied the Settings test change, which the track could not edit. `CrashDeviceTest` waits for the notification answer as `AppDeviceTest` does, which closes the appfix entry's open item. The lead also made the controller changes that the track proposed: the first run and Repair now end a notification Cancel as cancelled (the first run showed the install error), and the first-run controller reads and writes the local-network answer on the IO dispatcher, in call order, which closes the ux entry's main-thread item. The track's device runs passed on API 37 (11 of 11) and API 29 (9 of 9) with Node 24.22.0; SIGSEGV and SIGABRT on `node server.js` left records that name the signal (exit 139 and 134). On the lead's tree with Node 26.12.1 (x86_64) on API 37, the service suite (22 tests), the denied-notification check, the notification Cancel (also after Welcome's notification prompt), the in-app Cancel (three runs), the first run from the git fixture (82 to 87 s), the SIGSEGV, SIGABRT and child crashes (records with exit 139, 134 and 1, first in Share logs), the documents provider check, Settings' share test and the report proofs passed, and so did LocalNetworkDeviceTest (3), SettingsInstrumentedTest (7), FirstRunDeviceTest (9) and FirstRunSystemDialogsTest (7). Two test faults came up there and are fixed in `CrashDeviceTest`: a tap on the in-app Cancel right after Continue could miss while the Installing screen laid out, so it taps again until the confirmation shows, and it scrolls Settings to Share logs itself (see the open items). The lead re-ran the Gradle debug gate (1412 unit tests, lint clean) and compiled each commit on its own. The Cancel label is a new `TODO(copy)` in `strings_crash.xml`. Open: a crash of the server child alone leaves a record with status 1, because the supervisor exits 1 without naming the child's signal (`src/server-supervisor.js` could log it); a crash while a stop or restart is in flight counts as requested and leaves no record; within one run, every Node process that inherits `NODE_OPTIONS` (extension workers, npm) can add a report of about 10 KB per fatal error until the next launch, record or clean exit deletes them; if the clock moves back more than 2 s during a run, that run's record names no report; `AppDeviceUi.find` turns back after every swipe on a Compose list, because Compose sends no accessibility events while UiAutomation is the only listener, so it reaches nothing more than one swipe away.
- 2026-10-25: Two of the Node 26 entry's open items are closed. The user kept the emoji font download (§10). The API 37 first run with real origins that did not reach the UI had cloned `staging`, which does not have this branch's launch-token gate yet: its server never answers the app's health check (`/__sillybunny/health` with 204), so the app waits out its 30-minute startup limit, longer than the track's 900 s stop. Until this branch merges, a first run against the real origins needs `-PdebugDefaultRef=feat/android-apk`.
- 2026-10-25: Task 7.5 complete: the release dry run on the fork (`TheLonelyDevil9/SillyBunny`) built, tested, signed and drafted `v0.0.1-rc.2`, and published nothing. The dry-run branch was this branch plus fork-only edits: the workflows' repository guards, branch names and GHCR image point at the fork (the digest PR job stays org-only), the input mirror points at the fork's package, and the version is `0.0.1-rc.2`. Four earlier runs of `v0.0.1-rc.1` (2026-10-23, Node 24.22.0) failed or were cancelled; the last passed every job before signing. The fork's `android-runtime.yml` run 40151582805 published the input mirror set for the Node 26 pins (`inputs-79469301a8fb`: 629 files, 215,665,984 bytes) and built arm64-v8a (1 h 48 min) and x86_64 (2 h 48 min), but armeabi-v7a failed after 5 minutes, so no runtime was published: the 32-bit host link of `node_js2c` had undefined `__atomic_load` and `__atomic_store`. Node 26's simdutf in V8 makes 8-byte atomic accesses, and i386 aligns 64-bit types to 4 bytes, so Clang calls libatomic for them; upstream Node ships no 32-bit ARM Linux build of 26.x. `3ab0feb1d` links the armeabi-v7a host tools with `-latomic`. A WSL reproduction with v26.12.1's own simdutf failed the same way and linked and ran with the fix, and `test-node-pipeline.py` passed (73 tests); the patch set, and so the runtime tags, did not change. Run 40163009804 then built all three ABIs (x86_64 1 h 46 min, armeabi-v7a 2 h 20 min, arm64-v8a 2 h 50 min), each passing `fetch-node.py --audit` (16 KB LOAD alignment and RELRO ends), and published `node-26.12.1-06a14ab3ed10-{arm64-v8a,armeabi-v7a,x86_64}`, which read back anonymously. With those digests pinned on the dry-run branch, its runtime run 40173485753 built nothing. Release run 40173520897 for the lightweight tag `v0.0.1-rc.2` passed every job: the decision (versionCode 1, the first APK release, so no earlier certificate and nothing to re-attach) with its mirror check; the APK build (5 min), whose mirror-only inputs took all 44 Termux debs from the mirror; the smoke on API 29, on API 36 and on API 37.0 with 16 KB pages (17–18 min each); signing, after the user set the four secrets of a throwaway key in the fork's `android-signing` environment and approved the deployment; and the draft. The lead's 43 checks on the draft all passed: one draft prerelease and nothing published; the run's artifacts; `release.yml` attestations for all eight assets; `SHA256SUMS` lists and verifies every other asset; `android-update.json` passes the app's rules with these APKs and names `v0.0.1-rc.2`, `staging`, the prerelease flag, the throwaway certificate and each APK's size and SHA-256; and each APK verifies with v2 (API 24–27) and v3 signatures and no v1, v3.1 or v4, has one signer (the throwaway certificate), passes `zipalign -c -P 16 4`, is not debuggable, and has the package name and native code for its own ABI only. The signed APKs are 72,574,204 bytes (arm64-v8a) and 70,776,102 bytes (armeabi-v7a); the sources archive is 175,447,010 bytes (4,009 members). On the fork this closes the input mirror entry's open release-candidate build (2026-10-24) and the Node 26 entry's open ARM builds, digest pins and mirror set. The lead then deleted the fork's dry-run tags, draft, branch and signing environment, and the local throwaway key; the fork's GHCR package stays until the user deletes it (that needs the `delete:packages` scope). Not exercised: re-attach and the comparison with an earlier release's certificate (this was the first APK release), the digest PR job, and the ARM APKs on a device (the smoke runs x86_64). Open after this branch merges: the org's first `staging` push builds and publishes the org's runtime and input mirror and opens the digest PR, and the org package must be public before anonymous pulls and `--check` pass (§5.2, §9.14); the org's `android-signing` environment and its four secrets (§9.2).

---

## Appendix A: Full decision log (questions, options, recommendation, final answer)

Historical answers are retained below. The 2026-10-21 confirmed Node-only APK/Bun-deferral decision (§9.10) supersedes Round 1 Q13 and Round 2 Q11; other-install Bun support stays unchanged.

### Round 0: Initial scoping (after the viability assessment)

The viability finding: feasible. SillyBunny's dependencies are pure JS/WASM (no `.node`/`.so` files and no `binding.gyp` in `node_modules`). There are 15+ community projects that ship SillyTavern in an APK. The real cost is Android-side maintenance and distribution.

| # | Question | Answer |
|---|---|---|
| 0.1 | Approach: a SillyBunny-owned app or a collaboration with ST-android? | **SillyBunny-owned application.** |
| 0.2 | Device scope? | **Android 10+.** Legacy devices use Termux, which is not being dropped. |
| 0.3 | Extensions and server plugins in v1? | **Yes, they must work in the first version.** |
| 0.4 | Updates? | **The app should update itself.** A dedicated APK update check is likely needed, since git installs update automatically on startup via scripts. Must be as seamless as the git launchers. |
| 0.5 | Distribution / identity? | **GitHub Releases only**, alongside the regular launcher. Geechan or TheLonelyDevil holds the developer identity and signing key. |
| 0.6 | Termux → APK migration in scope? | **No.** It's for newcomers and people willing to switch. |
| 0.7 | Plan format? | A handoff file any agent can pick up without prior context, containing all questions and answers. |

### Round 1

| # | Question | Options | Recommended | **Final answer** |
|---|---|---|---|---|
| 1 | Update architecture | A runtime host + git installer; B monolithic snapshot APK; C hybrid snapshot + git | A | **A.** A very consistent workflow, with every install method unified and no special-case code. It's a natural fit coming from Termux, enough that Termux can be soft-deprecated. |
| 2 | targetSdk strategy | A modern (36) + W^X workarounds; B legacy 28 | A | **A.** Not breaking with future Android versions is critical. |
| 3 | Git implementation | A bundle the real git; B extend isomorphic-git | A | **A**, for the consistent workflow. Happy to make its source available. |
| 4 | Code location | A `android/` in the main repo; B separate repo | A | **A.** It's a first-party official install method. New releases ship the APK alongside the desktop installer files. |
| 5 | Package / display name | `io.github.sillybunnyteam.sillybunny` or an owned domain | io.github… | **`io.github.sillybunnyteam.sillybunny`**; display name **SillyBunny**. |
| 6 | Signing custody | A CI signing in a protected environment; B local manual signing | A | **A.** Note the implications for TheLonelyDevil in the plan (§6.4). |
| 7 | Developer verification | A individual; B organization; C unregistered | A or B | **Stay unregistered until further notice**; recorded as a caveat needing confirmation (§9). |
| 8 | Localhost security | A launch-token gate; B forced account login; C accept the risk | A | **A.** Nothing the user has to think about. It must be compatible with account logins when they're used. |
| 9 | UI surface | A WebView only; B external browser; C WebView + Open in browser | C | **C.** |
| 10 | ABIs | arm64 / x86_64 / armv7 | arm64 + x86_64 | **arm64-v8a primary; armeabi-v7a as fallback.** (x86_64 is later used only for CI; see Round 2 Q12.) |
| 11 | Server lifetime | A foreground service with Stop; B tied to the activity | A | **A.** |
| 12 | Native UI scope | Minimal vs rich | Minimal | **Minimal.** The phone UI design is handled in the program itself. |
| 13 | Runtime | Node only vs Node + Bun | Node only | **Original: Node + Bun, user-selectable; Node is the default recommendation** because of the Bun bugs. **Superseded 2026-10-21: Node-only APK for now; Bun deferred (§9.10).** |
| 14 | Data safety | allowBackup=false, hasFragileUserData, DocumentsProvider, SB backup | All four | **All four.** |

### Round 2

| # | Question | Options | Recommended | **Final answer** |
|---|---|---|---|---|
| 1 | What "soft deprecate Termux" means | Docs only vs launcher warnings | Docs only | **Docs only.** Existing Termux users keep using it; its visibility is slowly reduced in favour of the APK, *provided the APK is seamless*. **If the app stays unregistered, Termux must always stay visible.** |
| 2 | Source of Node/git/bash | A repackage Termux; B rebuild via termux-packages under our package name; C build Node from upstream with the NDK | C for Node, A for git/bash | **C for Node** (the user asked whether "hours" meant CI or per user: it's **CI-only build time** when the pins change, so C is acceptable; per-user builds would have meant A). **A for git and bash.** |
| 3 | `npm` by name | A native trampoline; B generalise `src/npm-launcher.js` | A | **A.** |
| 4 | Launcher logic | A reuse `install.sh`/`start.sh` via the bundled bash in APK mode; B Kotlin rewrite | A | **A.** |
| 5 | Data/config location | A inside the checkout; B outside via `--dataRoot`/`--configPath` | A | **A.** |
| 6 | Runtime compatibility gate | A min-app-version gate; B release discipline only | A | **A.** "We can't trust the users to follow strict discipline." |
| 7 | APK versioning / publishing | Independent versionCode, stable asset names, `android-update.json`, byte-identical re-attach, channel follows the branch | As described | **As described; recorded in the plan** (§5.4, §6.1). |
| 8 | Update check UX | On every launch, non-blocking, `releases/latest/download/android-update.json`, native dialog, toggle + "Check now", no web banner in v1 | As described | **As described; recorded in the plan** (§5.5). |
| 9 | First-run network | A warn on metered + show size, continue; B Wi-Fi only; C no warning | A | **A.** |
| 10 | LAN access | A not in v1; B opt-in with forced auth | A | **A.** Keeping it local is the better scope. |
| 11 | How Bun is offered | arm64-only bundle, Experimental label + battery warning, switching triggers reinstall | As described | **Original: as described, until Bun fixes the bug upstream. Superseded 2026-10-21: Node-only APK for now; Bun deferred (§9.10).** |
| 12 | Testing / CI | A x86_64 test-only emulator APK + manual real-device checklist; B manual only; C arm64 emulators | A | **A, added to the CI workflow alongside the other smoke tests.** |
| 13 | First-run branch | A always clone the default branch, switching via Server Tools; B native picker | A | **A.** (Later refined: RC builds default to `staging`; see Round 4 Q2.) |

### Round 3

| # | Question | Options | Recommended | **Final answer** |
|---|---|---|---|---|
| 1 | Where CI-built Node binaries persist | A GHCR OCI artifact pinned by digest; B Actions cache; C dedicated release tag | A | **A.** Automated GHCR fits the project's direction. |
| 2 | When the Android smoke runs | A path-filtered PRs + nightly + required before release attach; B every PR; C tags only | A | **A.** Other files are implicitly covered by the other smoke jobs. |
| 3 | Crash policy | Auto-restart with backoff, ≤ 3 in 5 minutes, then error screen + Share logs | As described | **As described, as long as user data can't get deleted easily.** Restart and recovery must never touch user data. |
| 4 | Battery-optimisation exemption | A offer on first run + in Settings; B don't ask | A | **A.** |
| 5 | DocumentsProvider scope | A `data/` + `config.yaml`; B whole checkout; C `data/` only | A | **A.** |
| 6 | Outdated WebView | A warn + Open in browser + update link; B block | A | **A.** |
| 7 | After an APK self-update | A "updated, tap to start" notification via MY_PACKAGE_REPLACED; B nothing | A | **A**, as the most elegant solution. |
| 8 | App icon | A reuse `public/img/logo.svg`; B dedicated icon | A | **Placeholder for now.** The logo will change in a future design plan as part of **PR #870**. |
| 9 | Governance docs | A brief AGENTS.md additions, humans write the rest; B none | A | **Humans write the docs; the model gives guidance on what to write** (§8). This is left to whoever implements the plan. **Brief additions are authorised under supervision.** |
| 10 | PR strategy | A one cohesive PR; B split | A | **A.** One PR for the new Android release model. |
| 11 | Rollout | A RC first, then stable minor; B straight to stable | A | **RC first: `v2.0.0-rc.1`** (the user wrote "v2.0.0_RC1", corrected to the format `release.yml` accepts and the user agreed). It's mostly for testing; if the workflow is confirmed working on the first run, RCs likely won't be used in future. **v2.0.0** is the release that overhauls the installation strategy (moving away from ZIP installs, automating via GHCR and CI), so the APK ships as part of v2.0.0. |

### Round 4

| # | Question | Options | Recommended | **Final answer** |
|---|---|---|---|---|
| 1 | Broken-install recovery | A native Repair (move aside, re-clone, `--migrate-from`, keep the old folder); B none | A | **A.** Repair as a recovery path is essential. |
| 2 | Which branch RC builds clone | A build-time default (`staging` for prerelease, `release` for stable); B testers switch by hand | A | **A.** |
| 3 | Stable acceptance gate | The device matrix + full procedure checklist | As described | **Approved, with an addition:** the *whole procedure an end user must go through* has to be **tested automatically**, with **manual tests performed by a team member** (§7). |
| 4 | Handoff file location | A write to `~/.opencode/plan/`, and the implementer commits it to `feat/android-apk` as `docs/android-apk-plan.md`; B local only | A | **A.** It must be understandable by another maintainer's agent without prior context, and include all questions and answers. |

### Round 5 (2026-10-24: the questions still open before this PR can close)

"As recommended" marks an answer where the user asked for the lead's recommendation, or gave a different first answer, and then confirmed the recommendation.

| # | Question | Options | Recommended | **Final answer** |
|---|---|---|---|---|
| 1 | Who holds the release signing key and sets up the org's `android-signing` environment and its four secrets? | Geechan; TheLonelyDevil | — | **TheLonelyDevil.** |
| 2 | Register with Google's developer verification before its 2027 rollout, or stay unregistered and keep Termux visible? | Full distribution ($25 and ID for one maintainer, or an organization account with a D-U-N-S number); stay unregistered | Nothing forces a choice for the first release | **Open.** The user asked whether the fee is one-time first; it is (§9.1). |
| 3 | Does the first release ship Node 24.22.0, or Node 26 with a full three-ABI rebuild and retest? | 24.22.0; 26 | — | **Node 26**, the newest release ("whatever the latest version of Node is"). |
| 4 | Is WebView 111 the minimum supported version? | 111; the newest version | 111 | **As recommended.** The user's first answer was the newest version (§9.5). |
| 5 | Should a missing or invalid `android/min-app-version` keep blocking updates instead of counting as 0? | Block; count as 0 | Block | **Keep the block**, after the lead gave the context (§9.8). |
| 6 | How should the app ask for Android 17's local-network permission, and what happens on denial? | — | Optional item on Welcome and a Settings row, Android 17+ only; denial keeps everything else working | **As recommended** (§9.11). |
| 7 | Should the file provider follow a custom `dataRoot`, or keep exposing only `data/` and tell the user? | Follow it; keep `data/` and tell | Keep `data/`, with a notice in Files and Settings | **As recommended** (§9.12). |
| 8 | Does the first APK ship the placeholder icon or wait for PR #870's icon? | Placeholder; wait | — | **Neither: the SillyBunny icon already in the repository** (§9.4). |
| 9 | Who writes the text for the `TODO(copy)` placeholders, and does it land in this PR? | — | — | **Later; the placeholders stay `TODO(copy)`.** |
| 10 | Who writes the README, SECURITY.md and CONTRIBUTING.md sections that §8 outlines, and must they land before the merge? | — | — | **Placeholders with a skeleton in this PR; the maintainers must write them later** (§9.13). |
| 11 | One PR (#918), or split? | One; split | — | **One PR.** Merging is the maintainers' call; the APK is governed at a scale similar to PR #870. |
| 12 | Should the release workflow refuse to sign with a certificate that differs from earlier releases'? | Refuse; allow | — | **Yes**, "whatever is needed for security reasons". |
| 13 | Release minification (R8) before the first release, or ship unminified? | R8 now; unminified | Unminified; R8 in a follow-up PR | **As recommended.** Node is most of the APK, and the CI smoke tests debug builds, so it would not catch R8 breakage. |
| 14 | Upgrade `androidx.webkit` 1.17.1 to 1.18.0 and declare lifecycle, coroutines and Espresso explicitly? | Yes; no | Yes | **Yes.** |
| 15 | Add a debug-only `-PdebugDefaultRef`? | Yes; no | Yes | **Yes.** |
| 16 | Fix `AppDeviceUi.allowPermission`, which taps once and can miss the dialog on API 33+? | Yes; no | — | **Yes.** |
| 17 | Keep a crash dump when the app's Node aborts or crashes? | Yes; no | — | **Yes**, for troubleshooting. |
| 18 | Remove the per-install origin label from failed smoke runs' `logcat.txt`? | Remove; leave | Leave: it comes from a throwaway CI emulator, and Share logs already leaves it out | **As recommended.** |
| 19 | Trace the 2.9 MB that one API 37 first run downloaded before the clone? | Trace before the release; leave | Trace it during the Node 26 first runs; do not block on it | **As recommended.** The trace found the emoji font (§10). The lead proposed removing `EmojiCompatInitializer`; the user kept the download (2026-10-25). |
| 20 | Fix Quick Image Gen's "legacy browser-only settings" offer after several boots without an answered Welcome prompt? | Yes; no | — | **Yes.** |
| 21 | Add a Cancel action to the setup notification? | Yes; no | Yes | **As recommended.** |
| 22 | Add a challenge-response to the server health check, or accept its remaining races? | Challenge-response; accept | Accept for v1 and document | **As recommended** (§10). |
| 23 | Keep `.npmrc`'s `allow-git=none` and `allow-file=none` for server plugins' `npm ci` in the app? | Keep; relax | — | **Keep**, "whatever is secure". |
| 24 | Support 16 KB pages in the armeabi-v7a APK? | Rebuild Termux's ARM32 payload; leave it | Leave it: no 16 KB device runs that APK | **As recommended** (§10). The user favored 16 KB support; the APK that 16 KB devices install is 16 KB-ready. |
| 25 | After the merge, who opens the `actions/*` PR into `release`, and who makes the org's GHCR package public? | — | — | **TheLonelyDevil, both** (§9.14). |

---

## Appendix B: Sources and established facts

The research was done in a prior OpenCode session whose transcripts aren't shared, so primary sources are cited directly. "Verified" means the source was fetched and checked on 2026-10-21. Everything else comes from research summaries and should be re-checked.

### B.1 Codebase facts (`staging` `21b571a1d`, before this branch's changes)

- **Dependencies:** the citation audit found no `gypfile` or OS-restricted packages in `package-lock.json`; it could not rerun the earlier `node_modules` native-addon scan. `sillytavern-transformers` 2.14.6 uses `onnxruntime-web` (WASM).
- **Self-update:** `scripts/self-update.sh` does fetch + `pull --ff-only` on the upstream, needs a clean worktree, and treats the update as optional (exit 0 on skip). `start.sh` runs helpers via `bash <script>` (`start.sh:186-196`) and loops on exit 75 (`start.sh:349-375`).
- **Installer:** `scripts/bootstrap/install.sh` clones with `git clone --filter=blob:none --branch "$ref"` (line 380), defaults to `release`, and supports `--dir`/`--ref`/`--repo`/`--migrate-from`/`--use-bun`/`--use-node`/`--no-start` (usage 39-60, parsing 79-123).
- **Release workflow** (`.github/workflows/release.yml`):
  - tags `vX.Y.Z` (stable, `--latest`, must be on `release`) and `vX.Y.Z-rc.N` (`--prerelease`, on `staging` or `release`)
  - the tag must equal `package.json` version
  - releases are drafts
  - assets = `scripts/bootstrap/*.{sh,ps1,cmd}` + `SHA256SUMS`; provenance is stored by GitHub's attestation service, not uploaded as an asset
  - the job has a 15-minute timeout
- **Bootstrap smoke** (`.github/workflows/bootstrap-smoke.yml`): runs on PRs to `staging` and `release`, with a POSIX matrix (ubuntu/macos) and a Windows job.
- **GitHub API:** no runtime query of the Releases API anywhere in `src/` or `public/`.
- **Git use:** extensions clone via `src/git/client.js` (system git, or isomorphic-git, which is Node-only). Extension update/branch/version checks use `simple-git` (system git).
  - The plugin loader auto-update needs system git (`src/plugin-loader.js:359-421`).
  - The plugin release updater needs git + npm + the supervisor (`src/server-plugin-manager.js:688-711, 713-864`).
- **Server admin** (`src/endpoints/server-admin.js`): `/update` (fetch + ff-merge + dependency install + restart, lines 1044-1141), `/switch-branch` (1177-1260), and a host-update restart that requests 77 when `reloadSupervisor` and `SILLYBUNNY_LAUNCHER=1` (392-416). `getInstallCommand` prefers `bun install` when `bun` is on `PATH`, otherwise `npm ci --omit=dev` (552-631).
- **Supervisor** (`src/server-supervisor.js`): exit codes 75/76/77; spawns `argv[0]`.
- **Network defaults** (`default/config.yaml`): `listen: false`, port 4444, whitelist including `127.0.0.1`/`::1`, `172.16.0.0/12` and `192.168.0.0/16`, `basicAuthMode: false` (applied only when listening, `src/server-main.js:200-202`), accounts disabled, so the default user is admin. CSRF on.
- **Paths:** `--dataRoot` and `--configPath` are supported in standalone mode (`src/command-line.js`). Config-to-env mapping is `SILLYTAVERN_<KEY>` (`src/util.js:36-42, 92-113`).
- **Android:** the server already branches on `process.platform === 'android'` (`src/server-main.js:637`, `src/endpoints/characters.js:43`).
- **`.npmrc`:** `ignore-scripts=true`, `min-release-age=7`, `allow-directory=none`, `allow-file=none`, `allow-git=none`. Both `package-lock.json` and `bun.lock` exist.
- **External commands used by the scripts:**
  - `start.sh`: `dirname`, `tr`, `uname`, `git`, `bash`, `node`/`bun`, `npm`/`bun`; `mkdir` is Termux-only. No standalone `date` or `diff`.
  - `self-update.sh`: `dirname`, `git`; the APK gate adds `mkdir`, `mv`, `rm` (§3.1).
  - `install.sh`: `cat`, `grep`, `ls`, `git`, `bash`, `mkdir`, `cp`, `dirname`, `basename`, `head`, `sed`, `tr`, `uname`; git bootstrap can also call `sudo`, `pkg`, `xcode-select`, `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, `apk`. No `tail` command; the three `curl` hits are comments.
  - `install-prerequisites.sh`: `uname`, `bun`, `git`, `node`, `npm`, `sudo`, package managers, `curl`, `wget`, `grun`, `grep`, `mkdir`, `mv`, `cat`, `chmod`, `xcode-select`, `shasum`/`sha256sum`/`openssl` with `awk`, `dirname`, `mktemp`, `rm`, `tar`, `bash`; no `find` (script skipped in APK mode).
- **WebSockets:** no WebSocket upgrade handler in `src/`.
- **Icons:** existing assets in `public/img/` (`logo.svg`, `icon-*.png`, `apple-icon-*.png`), but they're placeholders only (PR #870).

### B.2 External facts

- **nodejs-mobile:** latest release v18.20.4 (Node 18.20.4), with Android armeabi-v7a/arm64-v8a/x86_64. **Verified:** https://github.com/nodejs-mobile/nodejs-mobile/releases. Limitations (no child_process, one instance per process, no restart): https://nodejs-mobile.github.io/docs/api/differences
- **Capacitor-NodeJS:** bundles nodejs-mobile 18.20.4 and is not recommended for new projects: https://github.com/hampoelz/Capacitor-NodeJS
- **Bun:** first-party Android builds since v1.3.14 (2026-05-13). **Verified:** https://bun.com/blog/bun-v1.3.14. Release assets: https://github.com/oven-sh/bun/releases. Idle-CPU report on x86_64, not ARM-specific: https://github.com/oven-sh/bun/issues/26415. Open Android SIGSYS reports: `close_range` on Android 11/12 (https://github.com/oven-sh/bun/issues/30766), `openat2`/`fchmodat2` in `bun install` (https://github.com/oven-sh/bun/issues/39060).
- **Node on Android:** builds via `android-configure`, but Android is not a supported platform: https://github.com/nodejs/node/blob/main/BUILDING.md#android. Upstream v24.22.0 uses `/system/bin/sh` for `shell: true`: https://github.com/nodejs/node/blob/v24.22.0/lib/child_process.js.
- **Node release lines (2026-10-20):** 24.x entered Maintenance LTS today; 26.x becomes Active LTS on 2026-10-28. Spike pin v24.22.0; release-line decision remains open (§9): https://github.com/nodejs/Release/blob/main/schedule.json.
- **Android platform rules:**
  - latest stable SDK: Android 17 / API 37 as of 2026-10-20
  - W^X: from targetSdk 29, apps can't `execve` from writable app data: https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission
  - ABIs and native-lib extraction: https://developer.android.com/ndk/guides/abis
  - 16 KB pages: https://developer.android.com/guide/practices/page-sizes
  - Foreground-service types: https://developer.android.com/develop/background-work/services/fgs/service-types
  - Foreground-service timeouts (affect `dataSync`, not `specialUse`): https://developer.android.com/develop/background-work/services/fgs/timeout
  - Phantom-process limit 32 (Android 12): https://android.googlesource.com/platform/frameworks/base/+/android-12.0.0_r1/services/core/java/com/android/server/am/ActivityManagerConstants.java
- **WebView:** file chooser: https://developer.android.com/reference/android/webkit/WebChromeClient ; download listener: https://developer.android.com/reference/android/webkit/WebView#setDownloadListener(android.webkit.DownloadListener)
- **Storage:** app-specific storage is wiped on uninstall: https://developer.android.com/training/data-storage/app-specific ; `hasFragileUserData`: https://developer.android.com/guide/topics/manifest/application-element
- **Installing updates:** PackageInstaller: https://developer.android.com/reference/android/content/pm/PackageInstaller ; `REQUEST_INSTALL_PACKAGES`: https://developer.android.com/reference/android/Manifest.permission#REQUEST_INSTALL_PACKAGES ; signing / v3 rotation: https://source.android.com/docs/security/features/apksigning/v3
- **Developer verification** (verified):
  - overview and timeline: https://developer.android.com/developer-verification/guides
  - open-source registration (`adi-registration.properties`): https://developer.android.com/developer-verification/guides/open-source-app-registration
  - FAQ / advanced flow: https://developer.android.com/developer-verification/guides/faq
  - F-Droid's opposition: https://f-droid.org/2026/02/24/open-letter-opposing-developer-verification.html
- **GitHub Releases:** assets up to 2 GiB each: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- **npm:** `min-release-age` added in npm 11.10.0: https://docs.npmjs.com/cli/v11/using-npm/changelog. Scripts use `sh` from `PATH` on non-Windows (or `npm_config_script_shell`), not a fixed `/bin/sh`: https://github.com/npm/promise-spawn/blob/main/lib/index.js.
- **git:** GPL-2.0: https://git-scm.com/about ; `GIT_EXEC_PATH`: https://git-scm.com/docs/git

### B.3 Prior art (architectures to borrow from; check licenses before copying code)

- **ST-android** (AGPL-3.0; Node from source as a submodule with minimal patches; arm64; no Termux; "extensions not properly supported"; the first build takes 2–3 h). **Verified:** https://github.com/Sanitised/ST-android
- **TavernDroid** (Termux Node/git as `lib*.so`, symlinks for `GIT_EXEC_PATH`, ELF patching, foreground service, WebView):
  - https://github.com/S0ul-Sh3ll/TavernDroid
  - `docs/ARCHITECTURE.md`, `tools/prepare.sh`, `tools/elfpatch.py`, `runtime/android-preload.cjs`, `app/src/main/java/io/github/taverndroid/ServerController.kt`, `Installer.kt`
- **VSCodroid** (Termux Node as `libnode.so`, git helpers in `jniLibs`, `linker64` trampoline, tested on API 33/36):
  - https://github.com/rmyndharis/VSCodroid
  - `scripts/download-termux-tools.sh`, `scripts/exec-trampoline.c`, `scripts/termux-exec.patch`
- **RodneyCw1/SillyTavern-Android** (embedded Node 22; an updater that checks the manifest, hash, signing cert and versionCode): https://github.com/RodneyCw1/SillyTavern-Android (`android/app/src/main/java/io/sillytavern/standalone/AppUpdater.kt`, `UpdatePolicy.kt`)
- **ST-Ctrl** (Node 24 via JNI; isomorphic-git extensions): https://github.com/wancDDY/ST-Ctrl
- **Upstream SillyTavern's position:** Termux only; an app request was closed as wontfix: https://github.com/SillyTavern/SillyTavern/issues/1137 ; the nodejs-mobile prototype PR: https://github.com/SillyTavern/SillyTavern/pull/5706
