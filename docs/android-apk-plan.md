---
status: in-progress
phase: 2
updated: 2026-10-21
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
│   ├── libnode.so       Node.js (spike: v24.22.0; release line open, §9; built from upstream source with the NDK)
│   ├── libgit.so        git (repackaged pinned Termux package)
│   ├── libgit-remote-http.so (and any other helpers git execs by name)
│   ├── libbash.so       bash (repackaged pinned Termux package)
│   ├── libnpm.so        native trampoline → libnode.so <npm-cli.js> "$@"
│   ├── libnpx.so        native trampoline → libnode.so <npx-cli.js> "$@"
│   └── lib*.so          shared libs needed by git/bash (openssl, curl, zlib, nghttp2, pcre2, iconv, ...; inspect ELF DT_NEEDED)
└── assets/
    ├── runtime/npm/     npm package (JS), version >= 11.10.0 (needed for .npmrc min-release-age)
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
- **Stopping:** send SIGTERM to the whole process group (or to the supervisor PID). The supervisor sends the child the IPC message `sillybunny:shutdown`, with a 5 s SIGKILL fallback (`src/server-supervisor.js:177-211`). Verify the mechanism in Phase 2 (toybox `setsid` / `Os.kill(-pgid)`).

### 2.4 Startup sequence (every launch)

1. Make sure the runtime layout matches the installed APK (refresh the symlinks and assets if `installed-runtime.json` differs).
2. Kick off the APK update check in parallel (non-blocking, §5.5).
3. If `SillyBunny/` is missing → run the first-run flow (§4.3).
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
| `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` | fixed local identity so `git stash` works (`autoStashBeforePull`, `src/endpoints/server-admin.js:1062-1078`) |
| `SILLYBUNNY_ANDROID_NPM_CLI`, `SILLYBUNNY_ANDROID_NPX_CLI` | paths used by the npm/npx trampolines |

Invoke bundled Bash with `--noprofile --norc` for both launchers. Preserve deliberate app-owned Git configuration/identity; P4-T's hook/global-config/automatic-maintenance disabling was test isolation, not the production contract (P4-T, §6).

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

  Anything missing gets bundled from Termux (e.g. `busybox` or `coreutils`) and added to `runtime/bin`.

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
  - **Response:** sets the cookie, then `302` to `/`.
  - **No token in the URL:** the long-lived token itself must never appear in a URL.
- **WebView:** set the cookie via the asynchronous `CookieManager.setCookie("http://127.0.0.1:<port>", ..., callback)` on the UI/Looper thread and require success before loading, or use the handoff URL. `flush()` persists cookies; it is not the async completion barrier. Cookies are not port-isolated; §4.5 must review other-localhost-port exposure, not claim navigation callbacks contain every cookie (R2, §4).
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
  - **UI pins:** Compose BOM `2026.09.00` (Material3 `1.4.0`, UI/runtime `1.12.1`), Activity Compose `1.13.0`, Core KTX `1.19.1`, Lifecycle runtime-compose/viewmodel-compose `2.11.0`, WebKit `1.17.1`. Leave BOM-managed library versions unset and import the BOM for instrumentation dependencies too when used. DocumentFile `1.1.0` is optional, not a DocumentsProvider requirement. R2 verified metadata/POM availability, not transitive resolution or the exact BOM announcement day.
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
   - free storage check (threshold measured in task 2.6)
   - network check; on a metered or mobile connection, show a warning with the **measured** estimated download size (clone + `npm ci`) and let the user continue
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
- **Stopping:** SIGTERM to the process group (verify the mechanism), then SIGKILL after a timeout. This matches the supervisor's 5 s force-kill (`src/server-supervisor.js:31`).
- **Health check:** poll `GET /__sillybunny/health` with the launch-token cookie until it returns 204.
- **Platform limits:** the six-hour/24-hour timeouts for `dataSync`/`mediaProcessing` do not apply to `specialUse`; this is not an uptime/Doze/OEM-survival guarantee. Android 16 job quotas still affect WorkManager/JobScheduler/DownloadManager, not a documented timer on ProcessBuilder children (R2, §2).

### 4.5 WebView screen

- **Loading:** load `http://127.0.0.1:<port>/` (port from `config.yaml` / default 4444; read it via config or use a fixed env override, decided in the Phase 2 spike) with the launch-token cookie set first.
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
- **Cookie containment:** navigation callbacks exclude some POSTs/app loads/subresources and resource redirect destinations. Review those plus external-browser handoff and other localhost ports; `HttpOnly`/`SameSite=Strict` do not supply port isolation, and browser-held cookies are outside app navigation controls (R2, §4).
- **Back button:** exit a fullscreen custom view first, then use AndroidX/Compose BackHandler/PredictiveBackHandler only while WebView has history, otherwise normal back-to-home (server keeps running); no legacy key interception (R2, §2; S2.7b, §3).
- **"Open in browser":** a menu or toolbar action. The app computes the handoff code itself (§3.3) and opens `http://127.0.0.1:<port>/__sillybunny/handoff?c=...` in a browser in the same profile; Android 17 blocks cross-profile loopback by default (R2, §2).
- **Clipboard:** test text copy/read and PNG ClipboardItem writes, including async/command-driven gesture failures. Some existing helpers fall back only when the API is absent, not after rejection; generic media permission does not grant clipboard access (S2.7b, §3).
- **Service workers/dialogs:** test `/sw.js` registration/cache and cookie-preserving restart/clear flows without blanket storage purges (TTS model caches and QIG gallery differ). Preserve JS alert/confirm/prompt/beforeunload results; unload is not a reliable Android shutdown signal (S2.7b, §3).
- **Media:** test asynchronous TTS/audio, speechSynthesis, AudioWorklet/worker/WASM, audio focus/gesture setting and background audio; provide custom-view fullscreen/Back callbacks. Grant only explicitly allowed, requested resources from the trusted origin after Android permission; no shipped camera/microphone requirement was found. Foreground server service alone does not keep suspended WebView reminder timers running. Target-37 background-audio capability must be tested after a qualifying user start (S2.7b, §3; R2, §2).
- **Minimum WebView version:** if the WebView major version is below the minimum, show a **warning, not a block** (`lorum ipsum`), with "Open in browser" and a link to update Android System WebView.
  - **How to set the minimum:** audit the frontend's newest CSS/JS features against the project baseline (AGENTS.md: Safari/WebKit 16.4+).
  - **Starting proposal:** Chromium 111 remains **UNVERIFIED**. Read nullable provider `PackageInfo.versionName` via `getCurrentWebViewPackage`, parse defensively and keep unknown/malformed as unknown; not UA/versionCode or a hardcoded package. Reduced-UA rollout/target gate is **UNVERIFIED**. WebKit `1.17.1` fits minSdk 29, but provider features still need gates; explicitly enforce debug policy even though recent WebViews auto-enable it for debuggable apps (R2, §§2, 4).

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
- **npm/npx trampolines:** a tiny C program built with the NDK. It works out its name from `argv[0]` and runs `execv(nativeLibraryDir/libnode.so, [node, $SILLYBUNNY_ANDROID_NPM_CLI|NPX_CLI, argv[1:]...])`. It is packaged as `libnpm.so` / `libnpx.so` (an executable named like a library, so it needs a small Gradle copy step; AGP only auto-packages CMake library targets).
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

Schema 1 and its portable test are committed in `55243cab1`: three ABIs, authenticated Termux repository/package pins and per-ABI pool filenames/SHA256; `node`, `bun` and `npm` are currently `null`. Node patches and populated Node/npm pins are still pending; `bun` intentionally stays `null` under the confirmed deferral (P4-T, §§2–3; §9.10).

### 5.2 Node runtime build workflow (new, e.g. `.github/workflows/android-runtime.yml`)

- **Triggers:** `workflow_dispatch`, plus changes to the Node pin or patch files.
- **Build:** upstream Node (spike pin **v24.22.0**) with `./android-configure <NDK> <API> <arch>` (https://github.com/nodejs/node/blob/main/BUILDING.md#android) for arm64, armv7 and x86_64, 16 KB aligned. Node 24.x entered Maintenance LTS on 2026-10-20; 26.x becomes Active LTS on 2026-10-28. Re-decide the line before the first release build (§9). Expect hours; **this cost is CI-only, never per user**.
- **Patches:** keep any needed Android patches in `android/runtime/patches/node/`. ST-android (AGPL-3.0, Node submodule + minimal patches) is the reference.
- **Publishing:** push to **GHCR** as an OCI artifact (e.g. `ghcr.io/sillybunnyteam/sillybunny-android-runtime:node-<ver>-<patchhash>-<abi>`, via `oras`), with build-provenance attestation. Then open a PR updating the digests in `runtime.lock`.
- **Termux packages:** `android/runtime/fetch-termux.sh` + `package-termux.py` verify pinned SHA256, extract/patch the Git/Bash/HTTPS ELF closure and emit runtime assets, licenses and per-ABI `runtime-files.json`. Lock refresh authenticates InRelease/index/deb metadata with the pinned Termux key; ordinary builds use the lock, not a fresh index. Clean/offline byte-identical builds pass; toybox gap-fillers await task 2.5 (P4-T, §§3–5).

### 5.3 GPL / license compliance

git (GPL-2.0), bash (GPL-3.0) and any LGPL libraries are redistributed as binaries. Whenever a release ships **new** binaries, attach `SillyBunny-android-sources.tar.zst`. It contains:
- the upstream source tarballs
- the Termux build recipes and patches used
- the Node source + patches

Ship `THIRD_PARTY_NOTICES` inside the APK and show it in Settings.

P4-T extracts 58 license/copyright inputs, but those do not complete corresponding-source/notices compliance; task 4.5 remains open. The Node-only release does not redistribute Bun or require Bun-specific source/notices. A future Bun bundle must also supply WebKit/JSC and dependency-specific notices/source/relink material, not an MIT-only label (P4-T, §6; S2.4, §4).

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
  "inputsHash": "<sha256 of android/** + runtime.lock + defaultRef>",
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

### 5.6 After an APK self-update

Android kills the process during the install. On `ACTION_MY_PACKAGE_REPLACED`, post a notification ("updated, tap to start", `lorum ipsum`) that opens the app. **Tap-to-start is the chosen product policy:** this broadcast is explicitly an FGS background-start exemption, not an Android prohibition on restart. Keep receiver work bounded and use a direct activity PendingIntent, not an activity trampoline. Notification denial can hide the notification; handle the updated state on the next explicit launch. Background-activity-launch opt-ins are separate from the FGS exemption (R2, §2).

---

## 6. Release integration and signing

### 6.1 Versioning rules

- **Independent APK version.** It lives in `android/app-version.properties` (`versionCode`, `versionName`) and is independent of the SillyBunny version (e.g. APK `1.0.0` ships in SB `v2.0.0`).
- **APK inputs** = `android/**` (excluding pure docs) + `android/runtime.lock` + `defaultRef`. Their hash is `inputsHash`.
- **Unchanged inputs.** If `inputsHash` equals the previous release's manifest `inputsHash` (same channel), CI downloads the previous release's signed APKs and `android-update.json` and **re-attaches them byte-identical**: no rebuild, no versionCode change, no user prompt.
- **Changed inputs.** `versionCode` must be greater than the previous manifest's `versionCode`; otherwise CI fails with a clear message.
- **RC → stable rebuilds.** RC and stable builds differ in `defaultRef`, so a stable release after an RC always rebuilds with a bumped `versionCode`, and RC testers then get the stable APK as an update. Expect this for `v2.0.0-rc.1` → `v2.0.0`. Maintainers expect to skip RCs after this first run.
- **No downgrades.** Android won't allow them, so a bad APK is "rolled back" by shipping a higher `versionCode`.
- **min-app-version.** `android/min-app-version` must be ≤ the `versionCode` attached to the same release (CI check).

### 6.2 `release.yml` changes

**Open Phase 6/7 constraint:** `tests/release-workflows.test.js` forbids `environment:` in `release.yml` and requires every `uses:` to be `owner/repo@<40-hex>`. Signing therefore needs a separate workflow or a deliberate, reviewed test change; do not choose the layout until this is resolved (§9).

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
  - Pin actual Command-line Tools `23.0` and Emulator `37.2.12` via `emulator-build: '16428233'`; upgrade the action's actual `cmdline-tools/latest/bin/avdmanager`, not merely PATH. Recreate stale AVD caches, assert root `.ini` target `android-37.0`, and use `ram-size: '4096M'` or more for API 37. Verify UI/system-service readiness beyond `sys.boot_completed=1`; typical hosted boot times are **UNVERIFIED**, and the action's 600 s timeout is not a boot estimate. Current r6/r7 images clear Google's specific revision-5 GMS fix, not every possible API 37 issue.
- **Fixtures on the runner host,** reachable from the emulator at `10.0.2.2`:
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
  - the foreground-service notification title/text and Stop action
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
2. **Who holds the signing key and identity:** Geechan or TheLonelyDevil (not yet decided). TheLonelyDevil should read §6.4.
3. **Bun [DEFERRED]:** Node-only APK shipping is confirmed as of 2026-10-21 (item 10). S2.4 records Bun 1.4.3 startup, 16 KB JSC and `.npmrc` failures (§10). #30766/#39060 remain open; this spike reproduced `close_range`, not `openat2`/`fchmodat2`. #26415 is a WSL2/x86_64 workload, not Android/ARM battery evidence (S2.4, §4).
4. **Icon:** placeholder until the design work in PR #870.
5. **Minimum WebView version:** to be determined by audit (proposal: Chromium 111).
6. **Toybox gaps:** the list of commands that need bundling depends on the Phase 2 verification.
7. **Node release line:** the spike pins v24.22.0; 24.x entered Maintenance LTS on 2026-10-20 and 26.x becomes Active LTS on 2026-10-28. Re-decide before the first release build.
8. **Missing/invalid min-app-version:** APK mode blocks these branches instead of treating a missing file as 0, because they predate the launch-token and update gates. **Needs maintainer confirmation.**
9. **Phase 6/7 workflow layout:** resolve signing in a separate workflow versus a deliberate, reviewed test change; preserve the current `uses:` assertions, script-step Android change detection and nightly unit-test environment constraints until reviewed (§6.2, §7.1).
10. **Confirmed deviation (2026-10-21): ship Node only for now; defer the Bun bundle.** Maintainers agreed, relayed by the user on 2026-10-21; task 2.8's Bun escalation is resolved and task 4.4 is **DEFERRED**, not complete. This supersedes Round 1 Q13 / Round 2 Q11 for APKs only; repository non-APK Bun support and Node/Bun server parity stay unchanged. Revisit only after 16 KB JavaScriptCore start-up, unchanged `.npmrc min-release-age=7` and source policies, and real arm64 tests pass. S2.4, §§4/6 retains the evidence and recommends a reproducible patched Termux-based build with explicit copyfile installs rather than assuming an official prebuilt is qualified.
11. **Outbound LAN backends:** the no-LAN-listener decision stays unchanged, but target-37 LAN backend use needs a permission/denial UX policy (§4.2); same-profile loopback does not require that permission (R2, §2).

## 10. Known risks and unknowns (verify early, in Phase 2)

Report keys: **S2.4** = `s24-bun.md`; **R2** = `r2-android-platform.md` (2026-10-20 cutoff, validated 2026-10-21); **S2.7b** = `s27-downloads-audit.md`; **P4-T** = `p4-termux-runtime.md`; **P3-B** = `p3-B-server-gate.md`; **T3.7** = `t37-touch-ledger.md`; **S2.2** = `s22-termux-git-bash.md`; **S2.2b** = `s22b-api36.md`.

- **Exec via symlinks:** task 2.2 is complete: S2.2 real `untrusted_app` tests cover API 29/4 KB; P4-T and S2.2b cover committed-pipeline outputs on API 37/16 KB and API 36/4 KB. Required filtered HTTPS clone/Git operations, symlinks and writable-copy EACCES pass; API 36 adds 19 cloned-repository/39 local checks, repaired shell alias and group stop. API 29 used the earlier spike payload, not a rerun of final outputs; API 33/35 and ARM/OEM execution remain **UNVERIFIED**. `run-as` is not production exec proof (S2.2, §4; P4-T, §5; S2.2b, §§4–6; R2, §2).
- **ELF/page-size checks:** P4-T audits all 51 final Termux ELFs: arm64/x86_64 LOADs ≥ `0x4000`; ARM32 retains `0x1000` and needs rebuilding if ARM32 16 KB support is required. All five S2.4 Bun candidates pass static 16 KB LOAD checks, but tested x86_64 JavaScript still aborts on 16 KB pages. Node ELFs await S2.1; task 2.7 stays open. ZIP alignment alone proves neither ELF compatibility nor runtime page-size independence (P4-T, §§5–6; S2.4, §4; R2, §§1–2).
- **Bun qualification (retained for a later revisit):** official x64 and baseline 1.4.3 die with SIGSYS on `close_range` before `--version` on API 29/31. All three tested x86_64 builds install on API 37/16 KB but abort during JavaScriptCore initialization; aligned arm64 ELFs were not executed. Termux passes feature probes on 29/31, but only the diagnostic copyfile install starts SillyBunny in the isolated symlinked layout. Successful installs fail the `.npmrc min-release-age=7` control while `ignore-scripts` passes; the pinned-source audit also finds ignored directory/file/git source restrictions. Copyfile does not fix policy or 16 KB failures. Task 2.4's verification is answered negatively; task 4.4 is deferred by confirmed §9.10 (S2.4, §§4, 6).
- **Bun CPU/license limits:** Termux-copyfile child CPU samples are 0.717%/0.467% over one 60 s emulator window on API 29/31, not ARM battery or steady-state estimates. Bun includes JSC/WebKit and other dependency obligations; complete corresponding-source/relink compliance and fake-node/lifecycle-path relocation are not cleared (S2.4, §§4, 6).
- **Termux relocation:** P4-T patches Git/HTTP shell literals and supplies the helper map, templates and CA; follow §§2.2/2.5 exactly. SSH, submodule/GUI/foreign-VCS helpers and writable hooks are not supported by this closure; ARM execution remains **UNVERIFIED** (P4-T, §§3, 6).

- **Node Android build patches.** Use ST-android's patch set as the reference, and check its license compatibility (AGPL-3.0, same as SillyBunny).
- **The phantom-process limit defaults to 32 system-wide**, configurable by DeviceConfig, not a per-app entitlement. Foreground importance is not an exemption; excessive-child-CPU enforcement and Android 17 RAM-dependent limits are separate. Keep git and npm work sequential (R2, §2).
- **OEM battery killers** despite the foreground service; the exemption prompt helps but doesn't guarantee survival.
- **First-run download size and time** on mobile; measure it (task 2.6).
- **Repair migration:** committed `tests/android-bootstrap-scripts.test.js` executes the real installer against temporary Git fixtures: opt-in migration in APK/desktop modes, exact refusal without the flag, unchanged source, migrated config/data/plugins/extensions/secrets/certs, custom relative and reused absolute data roots, and invalid/nested/non-empty-target guards. WSL rerun: 41/41 tests passed. This covers task 2.7's script check, not native Repair/SAF or damaged-metadata recovery (§4.7).
- **WebView exports/capabilities:** S2.7b completes the static downloads audit, not native verification. Immediate-revocation detached anchors require early Blob acquisition; attachment headers also occur on import/preview responses. §4.5/task 5.6 must cover suggested filenames, cookies, 53 file inputs (15 multiple), storage/Web Locks, clipboard, auth/popups, service workers, dialogs and media. Payload bounds, complete interception timing and device behavior remain **UNVERIFIED** (S2.7b, §§3, 6; R2, §4).
- **R2 evidence limits:** dependency metadata/API/source and signing/ZIP fixture checks are not a Gradle integration build, device update/rotation, native-DCL execution, OEM LAN/SAF/provider-race validation or hosted emulator performance proof. Keep those **UNVERIFIED** until their implementation/runtime checks pass (R2, verification).
- **`.npmrc` `allow-git=none` / `allow-file=none`** effects on the server-plugin `npm ci` path. These are already the same on desktop, so just confirm.

P4-T component sizes in bytes (not complete APK/first-run measurements; task 2.6 remains open). ZIP estimates are DEFLATE level 9 for native + assets + license inputs, excluding the manifest; the shipping APK also needs Node/npm/app code/notices (P4-T, §4).

| Payload | arm64-v8a | armeabi-v7a | x86_64 (CI only) |
|---|---:|---:|---:|
| Native extracted (17 files/ABI) | 17,427,571 | 12,828,747 | 17,895,603 |
| Native + runtime assets | 17,658,779 | 13,059,955 | 18,126,811 |
| Native + assets + license inputs (93 files) | 18,476,736 | 13,877,912 | 18,944,768 |
| ZIP estimate, same 93 files | 8,670,285 | 7,812,034 | 8,300,699 |

---

## Phase 1: Handoff setup [DONE]
- [x] **1.1 Create `feat/android-apk` from `staging`; commit this file as `docs/android-apk-plan.md`**
- [x] 1.2 Re-verify every cited `path:line` fact against current `staging` (v2.0.0 work may have moved things); update this file where needed
- [x] 1.3 Read `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`/`DESIGN.json`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/upstream-sync.md`
- [x] 1.4 Open a **draft** PR to `staging` early (ask the maintainer for the title/body; never write them)

## Phase 2: De-risking spikes (throwaway; results recorded in Notes) [IN PROGRESS]
- [ ] **2.1 Build upstream Node (spike pin v24.22.0; release line open, §9) for arm64 + x86_64 with the NDK (ST-android patches as reference). Confirm `process.platform === 'android'`, `/system/bin/sh` for `shell: true`, ICU/Intl, WASM, worker_threads** ← CURRENT
- [x] 2.2 Repackage Termux git + bash (+ libs). Confirm exec via symlinks from `filesDir` → `nativeLibraryDir` on API 29, 36 and 37 emulators. Run `git clone --filter=blob:none` over HTTPS, `fetch`, `pull --ff-only`, `stash`, `checkout`, `show`
- [ ] 2.3 Prove the npm trampoline: `npm ci --omit=dev` of SillyBunny on the emulator, honouring `.npmrc` (npm ≥ 11.10.0)
- [x] 2.4 Verify that Bun's official Android zip runs on API 29+ (arm64 device or emulator image) and can run `bun install` + the server
- [ ] 2.5 Run `install.sh` + `start.sh` from an actual app-launched process with the APK-mode env (prototype flags); verify SELinux identity/resolved executables and list missing toybox commands/Termux path issues. `run-as` is inspection, not production exec proof (R2, §2)
- [ ] 2.6 Measure: Node-only APK size per ABI, first-run download (clone + `npm ci`), installed storage footprint, cold-start time; Bun-size comparison deferred with the bundle (§9.10)
- [ ] 2.7 Check the 16 KB alignment of every ELF; check `install.sh --migrate-from` on a git checkout; audit how SillyBunny triggers downloads (blob/data URLs)
- [ ] 2.8 Write the findings into §10 / Notes, and adjust the plan if anything changes a decision (escalate to the maintainers if it does)

## Phase 3: Base repository changes [DONE]
- [x] 3.1 APK mode in `start.sh`, `scripts/self-update.sh`, `scripts/bootstrap/install.sh`, `scripts/install-prerequisites.sh` (§3.1), with inline comments
- [x] 3.2 `android/min-app-version` + the shell gate in `self-update.sh` + the status file (§3.2)
- [x] 3.3 `src/android-app-gate.js` + hooks in the server-admin `/update` and `/switch-branch` endpoints + the error code (§3.2)
- [x] 3.4 `src/middleware/launchToken.js` + the handoff endpoint + the hook in `src/server-main.js` (§3.3)
- [x] 3.5 Jest unit tests for 3.3 and 3.4; `npm run lint` passes; Node and Bun parity checked
- [x] 3.6 Confirm zero behaviour change without the env vars (run the existing bootstrap smoke)
- [x] 3.7 Add/update `docs/upstream-touch-ledger.md` entries for every modified upstream-origin file, with protecting tests, validation, rollback and owner

## Phase 4: Runtime pipeline [IN PROGRESS]
- [ ] 4.1 `android/runtime.lock` format + `android/runtime/patches/` (§5.1)
- [ ] 4.2 `.github/workflows/android-runtime.yml`: Node NDK builds per ABI → GHCR (oras) + attestation → digest-update PR (§5.2)
- [ ] 4.3 `android/runtime/fetch-termux.sh`: download, verify, extract, ELF-patch git/bash/libs (+ toybox gap-fillers) (§4.9)
- [ ] 4.4 Bun zip fetch + verify (arm64 only). **DEFERRED (2026-10-21):** confirmed Node-only APK decision; revisit gates in §9.10
- [ ] 4.5 Sources-archive builder + `THIRD_PARTY_NOTICES` generator (§5.3)

## Phase 5: Android app [IN PROGRESS]
- [x] 5.1 Gradle project scaffold, manifest, ABI splits, signing configs (debug/test key; release from env), `app-version.properties`, BuildConfig fields, placeholder icon (§4.1–4.2)
- [ ] 5.2 Runtime layout installer (symlinks, assets, `installed-runtime.json`) (§2.2)
- [ ] 5.3 npm/npx trampoline (NDK C) + Gradle packaging as `libnpm.so`/`libnpx.so` (§4.9)
- [ ] 5.4 `ServerService`: env (§2.5), process-group start/stop, log capture and rotation, health probe, restart policy (§4.4)
- [ ] 5.5 First-run flow (§4.3)
- [ ] 5.6 WebView screen: cookie/handoff, all chooser modes, early Blob/name/cookie-aware streaming downloads, exact-origin bridge/links/auth return, predictive back, persistent storage/locks, clipboard, SW/dialogs/media, version warning and Open in browser (§4.5; S2.7b/R2 cases remain untested natively)
- [ ] 5.7 Settings screen (§4.6) + licenses screen
- [ ] 5.8 Update checker + PackageInstaller flow + `update-blocked.json` handling + post-update notification (§5.4–5.6)
- [ ] 5.9 Repair + leftover-folder management (§4.7)
- [ ] 5.10 `DocumentsProvider` for `data/` + `config.yaml` (§4.8)
- [ ] 5.11 Android lint clean; every user-facing string is `lorum ipsum` in resources

## Phase 6: CI smoke tests [PENDING]
- [ ] 6.1 Fixtures: git remote builder, mock LLM, fixture extension, fixture plugin, update-manifest server (§7.1)
- [ ] 6.2 Android job in `bootstrap-smoke.yml` with script-step changes detection; API 29 + 36 + 37 x86_64 emulators
- [ ] 6.3 Automate steps 1–14 of §7.1 (UiAutomator + Playwright over CDP)
- [ ] 6.4 Hook into `nightly.yml`; make it reusable so `release.yml` can call it

## Phase 7: Release integration [PENDING]
- [ ] 7.1 Split `release.yml` into the `android-apk` + `draft-release` jobs; `defaultRef` from the prerelease flag (§6.2)
- [ ] 7.2 `inputsHash` + byte-identical re-attach logic + versionCode and min-app-version CI checks (§6.1)
- [ ] 7.3 `android-update.json` generation; APKs, manifest and sources included in `SHA256SUMS` + attestation
- [ ] 7.4 `android-signing` environment + CODEOWNERS entries (maintainers create the secrets and the keystore offline; the agent only writes the workflow) (§6.3)
- [ ] 7.5 Dry run on a fork or with a test tag (never publish; releases stay drafts)

## Phase 8: Docs guidance and human handoff [PENDING]
- [ ] 8.1 List every `lorum ipsum` location (file + string ID) in a PR comment for the maintainers (§8)
- [ ] 8.2 Hand §8's outline to the maintainers for README/SECURITY/CONTRIBUTING. Propose the brief AGENTS.md additions and apply them **only after approval**
- [ ] 8.3 Ask the maintainers to resolve the open caveats in §9 (key holder; registration timing)

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
