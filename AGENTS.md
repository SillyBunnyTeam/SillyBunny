# AGENTS.md

Never ignore, delete or rename `AGENTS.md` or the `CLAUDE.md` symlink that points to it.

## Required reading

Read the docs below in full before you start; they change more often than this file. If this file disagrees with a linked doc, the linked doc wins: follow it and report the mismatch to the user.

| When | Read | What it is |
|---|---|---|
| Always | `CONTRIBUTING.md` | Contributing workflow guidance, project priorities, and code styling, design, and etiquette. |
| Always | `PRODUCT.md` | The design direction and featureset for the program, both user-facing and used by agents for a primer on SillyBunny's philosophy. |
| Any UI, CSS, markup or copy-placement change | `DESIGN.md`, `DESIGN.json` | The design direction for SillyBunny's user interface and user experience, and a companion reference for UI parameters. |
| Server routes, file or path handling, updater or launchers, secrets, extensions, sanitisation, remote requests | `SECURITY.md` | Security best practices for user safety. |
| Fixing bugs in known hotspots, or any non-trivial change | `lessons.md` | Dynamically edited. |
| Install, launcher or update flows, or anything else README covers | `README.md` | Primary user-facing documentation for the project description, installation procedure, credits, and so on. |
| Upstream SillyTavern sync | `docs/upstream-sync.md` | Documentation for sync behaviour. |
| Editing an upstream-origin file | `docs/upstream-touch-ledger.md` | |
| Build, cache or generated-asset changes | `docs/frontend-build.md` | |
| Release, RC, hotfix, tagging or CI workflow work | `CONTRIBUTING.md` § Release process | |

## Hard rules

- Target `staging`. Only `release/vX.Y.Z`, `hotfix/<name>`, `rollback/vX.Y.Z` and `actions/<name>` branches from this repository may target `release`; CI enforces this. → CONTRIBUTING § Correct target branch
- Never commit directly to `staging` or `release`, and never merge your own PR. → CONTRIBUTING § Correct target branch
- Keep compatibility with upstream SillyTavern data, settings, characters, chats, presets and extensions unless the task explicitly changes it. → CONTRIBUTING § Best Code Practices
- Preserve existing IDs, metadata keys, state formats, migration paths and bundled-template update flows; reuse existing formats instead of adding persistent schemas. → CONTRIBUTING § Best Code Practices
- Put SillyBunny behaviour in self-contained files. When an upstream-origin file must change, mark each divergence with `// SillyBunny: <why>` (`/* SillyBunny: <why> */` in CSS, `<!-- SillyBunny: <why> -->` in HTML) and add or update its entry in `docs/upstream-touch-ledger.md`. Fill in File, Area, Target seam, Adapter shape, Protecting tests, Validation and Last reviewed; leave Divergence reason, Rollback path and Owner as `TODO(copy)`. → CONTRIBUTING § Best Code Practices
- Bun is the primary runtime, but Node.js parity is required: no Bun-only API without a Node.js fallback. → CONTRIBUTING § Best Code Practices
- New UI and features must work on desktop and mobile. Baseline: Safari/iOS 16.4+, plus current and previous Chromium and Firefox. Pair `backdrop-filter` and `user-select` with `-webkit-` companions; `line-clamp`, `text-size-adjust` and `text-stroke` are `-webkit-` only. Never remove existing companions; tests assert some of them. → CONTRIBUTING § Best Code Practices
- Upstream syncs are standalone `sync:` PRs, never mixed with feature or fix work. → CONTRIBUTING § Upstream sync, `docs/upstream-sync.md`
- Never loosen `.npmrc` (`ignore-scripts`, `min-release-age`, `allow-*=none`) to make an install pass.
- ZIP installs are unsupported from v2.0.0; installs are git checkouts (via the bootstrap installer) or Docker. Never add ZIP code paths.
- Never hand-edit version strings (use `npm run version:bump`), the merged-PR ledger in `changelog.md`, or `.github/readme.md` (run `bash scripts/sync-readme-mirror.sh` after a human edits `README.md`).
- Release work: hotfixes bump the patch version; merge release, back-merge and sync PRs with a merge commit, never a squash; never rewrite `release`, because git installs update fast-forward only; push one tag at a time, never `git push --tags`; workflow changes also need an `actions/*` PR into `release`, because scheduled and `pull_request_target` workflows run from the default branch's copy. → CONTRIBUTING § Release process
- The Android APK has its own version in `android/app-version.properties`. Bump `versionCode` when any APK input changes (listed in `android/release/inputs-hash.mjs`). Never set `android/min-app-version` above the `versionCode` shipped in the same release. → CONTRIBUTING § Release process

## Commands

- Install: `npm ci` in the root and `npm ci --prefix tests`. `.npmrc` disables install scripts on purpose.
- Start: `bun run start`; force Node.js with `npm run start:node`. Launchers: `./start.sh`, `./start-bun.sh`, `./start-node.sh`.
- Lint: `npm run lint` (autofix: `npm run lint:fix`). `tests/` has its own `npm run lint`.
- Unit tests, from `tests/`: `npm run test:unit -- <file>` for one file, `npm run test:unit` for all.
- E2E tests need a running server; Playwright does not start one. Run `npm run init`, start the server (`bun server.js --browserLaunchEnabled=false`), then from `tests/` run `npm run test:e2e -- <spec>`. The base URL is `SILLYBUNNY_TEST_BASE_URL`, default `http://127.0.0.1:4444`.
- Frontend: `npm run check:frontend-budgets`; `npm run build:frontend` writes the gitignored `dist/frontend/`.
- Versions: `npm run version:bump -- X.Y.Z`; check with `npm run version:check`.
- After editing an existing in-chat agent template: `npm run agents:bump-template-versions`.
- Android debug build: `cd android && ./gradlew assembleDebug` (needs JDK 21).

## Repo map

- `server.js` supervises restarts, then imports `src/server-main.js`; keep its startup-order-sensitive imports intact.
- `public/` is browser code, `src/` is server code, `scripts/` holds maintenance scripts; launchers live in the root. JavaScript is ESM (`"type": "module"`).
- `tests/` is a separate npm package: Jest unit tests and Playwright e2e specs.
- `src/electron/` has its own package and is not covered by root scripts.
- `android/` is a separate Gradle project with a committed wrapper; root npm scripts and ESLint do not cover it.
- `scripts/bootstrap/` installers run before the repository exists, so they must stay self-contained; they ship as release assets.
- Root lint ignores vendored and generated code, including `public/lib/**`, `public/scripts/extensions/quick-image-gen/**`, `public/scripts/extensions/third-party/**`, `data/**`, `cache/**` and `backups/**`; do not reformat them unless the task targets them.
- `default/` contains bundled presets, agents, templates, characters and install-time defaults. Change it deliberately and verify fresh installs and existing users. Bundled in-chat agent templates live in `public/scripts/extensions/in-chat-agents/templates/`.
- Never commit `data/default-user/**` (CI fails) or `dist/`.

## Before you finish

Run what applies, then report what you verified and what you did not. → CONTRIBUTING § Before opening a PR

1. `npm run lint`; if you changed `tests/`, also `npm run lint` in `tests/`.
2. In `tests/`: the focused unit test, then the full `npm run test:unit`.
3. Changed `public/`: `npm run check:frontend-budgets`.
4. Backend, startup or structural change: boot with both `bun run start` and `npm run start:node`.
5. UI change: run the affected e2e spec against a running server, check desktop and mobile widths, and take before and after screenshots for the PR.
6. Changed an existing in-chat agent template: `npm run agents:bump-template-versions`.
7. Changed an upstream-origin file: `SillyBunny:` marker and ledger entry.
8. Nothing from `data/default-user/**` or `dist/` is staged.
9. List every placeholder you added, with its file and location.
10. Fixed a bug, or the user corrected a mistake that could recur: update `lessons.md` (see § Copy and docs).

## Commits, branches and PRs

- Branches: `<type>/<short-slug>`, using the PR title types (for example `fix/group-rename`).
- Commits: Conventional Commits, `type(scope): summary`, with an imperative, lowercase summary. Any type the spec allows; mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- PR titles: `fix`, `chore`, `feat`, `sync`, `docs` or `hotfix`, with an optional `(scope)`; CI rejects other types.
- You may prepare branches, commits and a ready-to-open PR link. The user writes every PR title and body, without AI assistance.

## Copy and docs

- Never write documentation, changelogs, release notes, PR titles or bodies, marketing copy or other prose that represents the project; ask the user for it.
- When code needs text the user has not supplied, use the placeholder `TODO(copy)`; in markup, also add `data-sb-copy-placeholder="true"`. Report every location.
- `lorum ipsum` marks older placeholders. Leave them for maintainers, never add new ones, and list any you find in your report.
- Comments follow CONTRIBUTING § Best Code Practices. Never use comments as hidden documentation drafts.
- Every root `*.md` file except `lessons.md`, plus `DESIGN.json` and `docs/**`, is human-written, including this file. Only make mechanical edits there (paths, command names, links, versions) when asked, unless a contributor explicitly authorises or supplies the wording.
- Keep `lessons.md` current. Add each new fix, guard or test to its area's section, and add a section for a new recurring bug class. Remove or correct entries the code no longer supports. Use the file's existing format, and record only facts you verified in code, tests or git history, citing files, tests, PRs or commits.
