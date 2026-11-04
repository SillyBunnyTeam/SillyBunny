# SillyBunny Contribution Guide

> [!NOTE]
> ### AI Disclaimer (Vibe Coding)
> LLMs are liberally used in this project to implement changes to the codebase. You are more than welcome to submit a PR with AI-assistance, as long as it aligns with the following contribution guidelines and you understand the implications of the code being submitted in your own words.

## Project Etiquette

Thanks for wanting to contribute to SillyBunny! We are more than happy to accept PR submissions. Before submitting a pull request, please keep the following project goals and best practices in mind:

#### Project Goals

The following goals summarise `PRODUCT.md` and `README.md`; `PRODUCT.md` is authoritative for SillyBunny's direction. `DESIGN.md` details the graphical user interface's direction.

1) **Simple by default; powerful when needed.** Directly inspired by KDE Plasma's main driving philosophy, SillyBunny is aimed to be simple to understand and intuitive to use by default, with most of the complex settings hidden away from the default workspace. Sane defaults are implemented while all the extra complexity is hidden behind the shell. Our graphical shell best embodies this philosophy.
2) **A focus on roleplay and storytelling.** SillyBunny has a more opinionated purpose compared to upstream SillyTavern. Our goals align closely with the creative writing scene for models, and the general direction of the fork is aimed for that use case. We facilitate this with pre-bundled tutorials/add-ons/presets designed to get you started with LLM creative writing in fun ways.
3) **Modernised features.** We aim to implement new features that can greatly take advantage of modern models and their strong, agentic capabilities while leveraging upstream SillyTavern's ecosystem. If it's an idea that helps people interact with models in creative and interesting ways, it can be considered.
4) **Better performance & UX.** SillyBunny uses a Bun runtime to increase general performance and startup times, while optimising for lower power devices like smartphones. Node.js is supported as a compatibility fallback. The user experience is heavily centred on maintaining focus on the main chat window while tucking away settings until they're actually required. Mobile development gets equal attention to desktop development, so the program remains easy to use regardless of your platform of choice.
5) **Compatibility**. We remain as closely backwards compatible with upstream SillyTavern as possible. This facilitates easy synchronising with upstream. We aim to not remove any pre-existing features, unless replacing with a direct alternative. The backend is already very solid, so primary work is done in the frontend space. In addition, we aim to make all our new features compatible with models of all sizes, not just the frontier, SOTA ones.

#### Best Code Practices

- SillyBunny is a successive fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern). Sustainability to upstream is critical: keep SillyBunny's general code compatibility as close to upstream as possible.
- Backwards compatibility with SillyTavern is a key design goal of the project. A user should be able to open SillyBunny, import their pre-existing SillyTavern settings, and feel right at home with SillyTavern's pre-existing featureset.
- A solution to a problem should not have any excess overreach. Use small, focused PRs to address bug fixes. A new feature or design decision should be delegated to one larger PR for easier tracking and development.
- Prefer reusable logic that other files can easily import, whenever that logic applies in multiple locations. Reuse existing metadata/state formats where possible instead of inventing new persistent structures.
- SillyBunny exclusive changes should be self-contained in their own files where possible. With the exception of UI modifications, try to minimise actual changes to base SillyTavern code unless it is completely necessary.
- Code comments should be explicit and direct in ASD-STE100 Simplified Technical English - verbose comments are difficult to read and are heavily discouraged. Comments are only necessary to help explain the *why* of complex logic in isolation that the code cannot explain alone. Comments should not reference other parts of the code. Match the existing comment style of the file you're working on.
- When modifying base SillyTavern files, leave clear inline comments indicating where and why SillyBunny code diverges from upstream. This aids maintainers during future upstream merge conflict resolutions. Start these comments with `SillyBunny:` (`// SillyBunny: <why>` in JavaScript, `/* SillyBunny: <why> */` in CSS, `<!-- SillyBunny: <why> -->` in HTML), and add or update the file's entry in `docs/upstream-touch-ledger.md`.
- While Bun is the default runtime, Node.js backwards compatibility is required. Do not use Bun-exclusive APIs (such as Bun.file() or Bun.serve()) unless a standard Node.js fallback is included. Test all structural changes in both runtime environments.
- Make sure new features work elegantly with parity on both mobile and desktop environments. SillyBunny must support Chromium, Gecko, and WebKit browsers: Safari and iOS Safari 16.4 or later, plus the current and previous releases of Chromium and Firefox. UI changes should not break the other platform - this is very important!

#### Correct target branch

Always create pull requests using the `staging` branch; 99% of contributions should go there. This way, we can ensure stability before a proper release version.

You can still send a pull request for `release` in the following scenarios, from a branch in this repository:
- Preparing a release (`release/vX.Y.Z`, opened by the Prepare Release workflow).
- Hotfixing a critical bug (`hotfix/<name>`). (Note: Hotfixes merged into release must also be backported to staging to prevent regression in the next update)
- Rolling back a release (`rollback/vX.Y.Z`).
- Changing GitHub Actions only (`actions/<name>`, limited to `.github/`, `tests/` and the release scripts).

Documentation goes to `staging` like everything else.

**Maintainers: Never commit directly to the `staging` or `release` branches; every change goes through a PR. Do not merge your own PR. Another maintainer must review it, except for `docs` and `chore` PRs, which code owners may merge without a second review. Hotfixes are on a per-case basis, and can be merged as an exception to favour speed over thoroughness by maintainers/code owners.**

#### Release Cadence

We prefer release synchronisations in short, frequent updates vs. long commit lists. This is to ensure that `staging` does not drift too far from `release` and to give people a frequent update target without relying on the `staging` branch. The `staging` branch should not accumulate a large backlog before synchronisation. As a guideline, aim for roughly one stable release a month so features have time to bake; this is not a commitment. Nightly CI opens a `release-reminder` issue when the latest stable release is over six weeks old and `staging` has unreleased commits.

Major releases (vX.0.0) are reserved for complete program redesigns or overhauls. In practice, this should only happen in very special circumstances.

Minor releases (vX.Y.0) are reserved for significant feature updates, improvements, or a large group of individual changes.

Patch releases (vX.Y.Z) are reserved for smaller bug fixes, performance improvements, and polish that do not introduce any significant new features.

Critical hotfixes may be released from `release` with a patch version bump, with the fix backported to `staging`.

#### PR Structure

When submitting a PR, follow this template:
- Write a paragraph denoting what the PR wants to achieve.
- Write a paragraph denoting how the PR achieves its goal.
- Include steps that designate how to use the feature, so it's easier for us to test.
- Include before and after screenshots for both desktop and mobile when making changes to the user interface.

Pull requests should use the following [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/#summary) PR prefixes before the title, with an optional scope such as `fix(ui):`:
- `fix` - a direct bug fix.
- `hotfix` - a critical fix that must ship from `release` ahead of the next release. Hotfixes are on a per-case basis, and can be merged as an exception to favour speed over thoroughness by maintainers/code owners.
- `chore` - a simple maintenance change.
- `feat` - a new feature implementation.
- `sync` - synchronising with upstream.
- `docs` - new documentation or modifications to documentation.
- `refactor` - a code change that neither fixes a bug nor adds a feature.
- `perf` - a code change that improves performance.
- `test` - new tests or corrections to existing tests.
- `ci` - changes to CI configuration and workflows, such as GitHub Actions.
- `build` - changes to the build system or dependencies.
- `style` - code formatting changes that do not change behaviour, such as whitespace or semicolons. Use `fix` or `feat` for CSS and UI changes.
- `revert` - reverts an earlier change.

Commits follow Conventional Commits as well: `type(scope): summary`, using any type the specification allows (for example `refactor`, `perf`, `test`, `ci`, `build`, `revert`). Mark breaking changes with `!` after the type or scope, or with a `BREAKING CHANGE:` footer. Upstream SillyTavern commits brought in by a sync are exempt.

Name branches `<type>/<short-slug>` with the same types (for example `fix/group-rename`). Pull requests into `release` must come from `release/vX.Y.Z`, `hotfix/<name>`, `rollback/vX.Y.Z` or `actions/<name>` branches in this repository.

All PRs must have their descriptions *manually* written, without AI assistance. Any PR that has an LLM genned description will be asked to change to a manual description, or be closed. This is to ensure the following:
1) Better describes the actual intention behind a PR, instead of having a model interpret it, leaving less room for error.
2) Reduces model verbosity that clutters up PR tracking and introduces completely unnecessary information.
3) Makes it easier to backtrack on a PR and pinpoint exactly what causes a regression.
4) Ensures PRs and their code are understood by submitters, regardless of AI assistance.

Project maintainers will test and can change your code before merging. To keep our workflow smooth, please ensure the following:
- The "Allow edits from maintainers" option is checked.
- Avoid force-pushing your branch once the PR is out of draft state.
- Do not merge your own PR. Another maintainer must review it. Direct end user debugging to the correct PR branch instead of staging, before merging.

#### Before opening a PR

Run the checks that CI runs, plus the ones that apply to your change:

- `npm run lint` in the repository root. If you changed `tests/`, also run `npm run lint` inside `tests/`.
- `npm run test:unit` inside `tests/` (run `npm ci` there first).
- `npm run check:frontend-budgets` if you changed anything in `public/`.
- For backend, startup, or structural changes, boot with both `bun run start` and `npm run start:node`.
- For UI changes, run the affected end-to-end spec against a running server (`npm run test:e2e -- <spec>` inside `tests/`), check desktop and mobile widths, and take before and after screenshots.
- If you changed an existing bundled in-chat agent template, run `npm run agents:bump-template-versions`.
- If you changed an upstream SillyTavern file, mark the divergence with a `SillyBunny:` comment and update `docs/upstream-touch-ledger.md`.
- Never commit `data/default-user/` or `dist/`.

#### Release and hotfix hygiene

If you're helping ship a SillyBunny release, keep the release copy in sync with the code:

- Update the root `README.md` changelog, replacing the existing changelog with the most recent, then sync `.github/readme.md` by running `bash scripts/sync-readme-mirror.sh`. The GitHub README is a mirror, so do not edit it by hand.
- Hotfixes are an exception: bump only the patch version, and skip the README updates and changelog pass. Just include a short bulleted list of exactly what was hotfixed in the release notes.
- Every release, hotfixes included, needs a human-written update summary alongside the full list of merged PRs. The draft release's generated notes list the merged PRs; add the summary before publishing.

#### Release process

1. A maintainer runs the **Prepare Release** workflow with the version (`X.Y.Z`). It opens a `release/vX.Y.Z` pull request into `release` that bumps every version reference (`npm run version:bump`) and records merged PRs in `changelog.md`. `npm run version:check` verifies that every version copy agrees.
2. On that branch, a human writes the README changelog and the changelog summary, then runs `bash scripts/sync-readme-mirror.sh`.
3. Merge with a merge commit. Never squash release, back-merge or upstream sync pull requests.
4. Tag `vX.Y.Z` on `release` and push only that tag (`git push origin vX.Y.Z`). Never use `git push --tags`, which also pushes upstream SillyTavern tags. Tags cannot be moved or deleted once pushed.
5. The tag creates a draft GitHub release with generated notes that list the merged PRs. Add the human-written update summary, then publish.
6. Publishing opens a `sync: merge vX.Y.Z back into staging` pull request with the next minor `-dev` bump. Merge it with a merge commit.

**Hotfixes:** branch `hotfix/<name>` from `release`, bump the patch version, and follow steps 3–6.

**Release candidates:** bump `staging` in a `chore:` pull request (`npm run version:bump -- X.Y.Z-rc.N`), then tag `vX.Y.Z-rc.N` on `staging` or `release`. The draft is marked as a prerelease. Never reuse an RC number.

**Android APK:** the APK has its own version in `android/app-version.properties`, independent of SillyBunny's. Bump `versionCode` whenever an APK input changes (listed in `android/release/inputs-hash.mjs`). Android cannot install a lower `versionCode`, so a bad APK is replaced by shipping a higher one. `android/min-app-version` must never exceed the `versionCode` shipped in the same release.

#### Upstream sync

When upstream SillyTavern publishes a new release tag:

- Follow the upstream sync runbook in `docs/upstream-sync.md` before preparing a sync PR.
- Prioritise synchronising to `staging` over new features and bug fixes.
- Check for code compatibility with the latest upstream release tag.
- Remove and migrate any SillyBunny features or patches if they have been properly implemented upstream.
- Resolve merge conflicts carefully, ensuring that upstream changes do not overwrite SillyBunny's custom UI modifications, Bun-specific optimisations, or additional features.
- Verify that any new upstream UI elements (such as new settings, menus, or buttons) integrate correctly into the fork's modified DOM structure.
- Review the upstream changelog to identify any newly added dependencies or modifications to metadata/state formats.
- Test the synchronised code in both Bun and Node.js environments to confirm that runtime parity is maintained.
- Complete the synchronisation as a standalone pull request; mixing upstream code updates with SillyBunny feature logic complicates the review process. Apply any follow-up fixes in separate, subsequent pull requests.

---

## Setting up the dev environment

1. Required software: git and Bun (≥ 1.3.14) for normal local development. Node.js (≥ 20) and npm are also required when testing Node.js compatibility or matching CI behaviour.
2. An IDE or editor of your choice. Visual Studio Code is a safe default.
3. A Chromium, Gecko (Firefox), and WebKit browser for compatibility checks.
4. For the Android app in `android/`: JDK 21, plus the Android SDK and NDK versions pinned in `android/app/build.gradle.kts`. The Gradle wrapper is committed, so run `./gradlew` from `android/`.

Native Termux contributors should use `bash start-termux-node.sh` for Node.js + npm unless specifically testing Bun behaviour; use `bash start-termux-bun.sh` when checking Bun-specific behaviour.

## Getting the code ready

1. Register a GitHub account.
2. Fork this repository under your account.
3. Clone the fork onto your machine.
4. Open the cloned repository in the code editor.
5. Create a git branch (recommended), review the [git book](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control) if you haven't.
6. Make your changes and test them locally.
7. Commit the changes and push the branch to the remote repo.
8. Go to GitHub, and open a pull request, targeting the appropriate upstream branch.

### License

This program is licensed as free software under the [AGPL 3.0](https://www.gnu.org/licenses/agpl-3.0.html). This implies NO warranty, and due diligence to maintain adherence to the copyleft structure of the license. Any derivatives or modifications of this program must be released under the same license.
