# AGENTS.md

> [!WARNING]
> IMPORTANT: this file should never be added to .gitignore. This is to synchronise Opencode workflow between all maintainers.

## Reference Documentation

Reading the following documentation is mandatory before you begin any work. No work can be started until all documentation is acknowledged.
- AGENTS.md - you are here.
- CONTRIBUTING.md - contributing workflow guidance, project priorities, and code styling, design, and etiquette.
- DESIGN.md - the design direction for SillyBunny's user interface and user experience. Any changes that involve the UI must be consulted here.
- DESIGN.json - a companion reference for UI parameters.
- PRODUCT.md - reference documentation for SillyBunny's purpose and overall structure.
- README.md - user-facing documentation that explains the project and its goals.
- SECURITY.md - security best practices for user safety.

## Commands

- Install behavior is intentionally constrained by `.npmrc`: `ignore-scripts=true` and `min-release-age=7`. Do not remove these to make installs pass.
- Start the app with `bun run start`; force Node with `npm run start:node`. Launcher equivalents are `./start.sh`, `./start-bun.sh`, and `./start-node.sh` on Linux/WSL.
- Root lint: `npm run lint`; autofix: `npm run lint:fix`.
- Build generated frontend assets with `npm run build:frontend`; check frontend budgets with `npm run check:frontend-budgets`.
- Tests live in a separate package under `tests/`: run `npm install` there first, then use `npm test`, `npm run test:unit`, or `npm run test:e2e` from `tests/`.
- Focus a Jest test from `tests/` with `npm run test:unit -- path/to/file.test.js`; Playwright e2e uses `SILLYBUNNY_TEST_BASE_URL` or defaults to `http://127.0.0.1:4444`.

## Repo Shape

- Main server entrypoint is `server.js`, which supervises restarts and then imports `src/server-main.js`; keep startup-order-sensitive imports near the top intact.
- Browser-side app code is under `public/`; server-side code is under `src/`; runtime launchers and maintenance scripts are in the repo root and `scripts/`.
- `src/electron/` has its own minimal Electron package and is not covered by the root scripts.
- Root lint intentionally ignores vendored/generated areas including `public/lib/**`, `public/scripts/extensions/quick-image-gen/**`, `public/scripts/extensions/third-party/**`, `data/**`, `cache/**`, and `backups/**`; avoid reformatting those unless the task targets them.
- `default/` contains bundled presets, agents, templates, characters, and install-time defaults; change it deliberately and verify migrations or reset behavior for existing users.

## Documentation And Copy

- Do not write documentation, changelogs, release notes, PR titles/bodies, marketing copy, or other prose that represents the project to users; ask the end user to provide it. PR descriptions must be manually written without AI assistance; you may prepare branches, commits, and a ready-to-open PR link, but ask the end user to provide the PR title/body before submission.
- If implementation requires text before the user has supplied final wording, use the exact placeholder `lorum ipsum` and clearly report every file/location that needs human replacement.
- Code comments are allowed only when they explain non-obvious implementation details; do not use comments as hidden documentation drafts.
- Keep agent-facing docs terse, specific, and actionable; link to existing docs instead of duplicating long explanations.
- AGENTS.md, CONTRIBUTING.md, README.md, PRODUCT.md, and SECURITY.md may not be overwritten by LLM wording unless explicitly authorized by a contributor.

## Style Gotchas

- JavaScript is ESM (`"type": "module"`) and ESLint enforces 4-space indentation, single quotes, semicolons, and trailing commas in multiline literals.
- Reuse existing metadata/state formats instead of adding new persistent schemas when compatibility can be preserved.
- Keep fork-specific feature PRs and upstream synchronization PRs separate even if conflicts are discovered while working.
