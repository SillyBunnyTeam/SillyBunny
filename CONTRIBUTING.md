# SillyBunny Contribution Guide

## Project Etiquette

BEFORE submitting a pull request, keep the following project goals and best practices in mind:

#### Project Goals

The following goals summarize `PRODUCT.md` and `README.md`; `PRODUCT.md` is authoritative for product direction.

1) **Simple by default; powerful when needed.** Directly inspired by KDE Plasma's main driving philosophy, SillyBunny is aimed to be simple to understand and intuitive to use by default, with most of the complex settings hidden away from the default workspace. Sane defaults are implemented while all the extra complexity is hidden behind UI elements. Our graphical shell best embodies this philosophy.
2) **A focus on roleplay and storytelling.** SillyBunny has a more opinionated purpose compared to upstream SillyTavern. Our goals align closely with the creative writing scene for models, and the general direction of the fork is aimed for that use case. We facilitate this with pre-bundled tutorials/add-ons/presets designed to get you started with LLM creative writing in fun ways.
3) **Modernised features.** We aim to implement new features that can greatly take advantage of modern models and their strong, agentic capabilities. Currently, this includes full support for In-Chat pre, sidecar, and post gen agents that complement the main generation. Models work best on smaller individual tasks, and this is best shown through in-chat agents and their capabilities. We've also implemented a conversational "instant messenger' mode that accompanies the roleplay mode, and plan on introducing more of these modes in the future.
4) **Better performance & UX.** Base SillyTavern relies on node.js for its runtime environment. While robust, this is not ideal for performance. We've switched to a Bun runtime to increase general performance and startup times, while optimising for lower power devices like smartphones. Mobile development gets as much attention as desktop development in this fork, so the program remains easy to use regardless of your platform of choice.
5) **Compatibility**. We remain as closely backwards compatible with upstream SillyTavern as possible. This facilitates easy synchronizing with upstream. We aim to not remove any pre-existing features, unless replacing with a direct alternative. The backend is already very solid, so primary work is done in the frontend space. In addition, we aim to make all our new features compatible with models of all sizes, not just the frontier, SOTA ones. Simplicity is key.

#### Best Code Practices

- SillyBunny is a derivative fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern), not a replacement. Sustainability to upstream is critical: keep SillyBunny's general code compatibility as close to upstream as possible.
- Backwards compatibility with SillyTavern is a key design goal of the project. A user should be able to open SillyBunny, import their pre-existing SillyTavern settings, and feel right at home with SillyTavern's pre-existing featureset.
- Follow KISS (keep it simple, stupid). A solution to a problem should not have any excess overreach. Use small, focused PRs to address bug fixes. A new feature or design decision should be delegated to one larger PR for easier tracking and development.
- Changes to upstream should be self-contained in their own files where possible. With the exception of UI modifications, try to minimise actual changes to base SillyTavern code.
- If modifying base SillyTavern files, leave clear inline comments indicating where and why SillyBunny code diverges from upstream. This aids maintainers during future upstream merge conflict resolutions.
- Reuse existing metadata/state formats where possible instead of inventing new persistent structures.
- While Bun is the default runtime, Node.js backwards compatibility is required. Do not use Bun-exclusive APIs (such as Bun.file() or Bun.serve()) unless a standard Node.js fallback is included. Test all structural changes in both runtime environments.
- Keep fork-specific feature additions and upstream synchronization merges in separate pull requests. Mixing upstream code updates with SillyBunny feature logic complicates the review process.
- Make sure new features work elegantly with parity on both mobile and desktop environments. UI changes should not break the other platform - this is very important!

#### Correct target branch

Always create pull requests using the `staging` branch; 99% of contributions should go there. This way, we can ensure stability before a proper release version.

You can still send a pull request for `main` in the following scenarios:

- Updating documentation.
- Updating GitHub Actions.
- Hotfixing a critical bug. (Note: Hotfixes merged into release must also be backported to staging to prevent regression in the next update)

**Maintainers: Self-merges are allowed for the following PR prefixes: `fix`, `chore`, `docs`, within reason. `feat` and `sync` require review from another maintainer. Never commit directly to the `staging` or `main` repositories unless they're `doc` changes.**

#### PR Structure

When submitting a PR, follow this template:
- Write a paragraph denoting what the PR wants to achieve.
- Write a paragraph denoting how the PR achieves its goal.
- Include steps that designate how to use the feature, so it's easier for us to test.

Pull requests should use the following [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/#summary) PR prefixes before the title:
- `fix` - a direct bug fix.
- `chore` - a simple maintenance change.
- `feat` - a new feature implementation.
- `sync` - synchronizing with upstream.
- `docs` - new documentation or modifications to documentation.

All PRs must have their descriptions *manually* written, without AI assistance. Any PR that has an LLM genned description will be asked to change to a manual description, or be closed. This is to ensure the following:
1) Better describes the actual intention behind a PR, instead of having a model interpret it, leaving less room for error.
2) Reduces model verbosity that clutters up PR tracking and introduces completely unnecessary information.
3) Makes it easier to backtrack on a PR and pinpoint exactly what causes a regression.
4) Ensures PRs and their code are understood by submitters, regardless of AI assistance.

Project maintainers will test and can change your code before merging. To keep our workflow smooth, please ensure the following:
- The "Allow edits from maintainers" option is checked.
- Avoid force-pushing your branch once the PR is out of draft state.
- Do not self-merge any PR into the upstream repository. It must be reviewed by at least one other contributor. Direct end user debugging to the correct PR branch instead of staging, before merging.
#### Release and hotfix hygiene

If you're helping ship a SillyBunny release, keep the release copy in sync with the code:

- Normal releases should bump every SillyBunny version reference that is user-facing or otherwise hardcoded, including the package version, the visible UI version strings, and the Horde fallback client string.
- Update the root `README.md` changelog, replacing the existing changelog with the most recent, then sync `.github/readme.md` by running `bash scripts/sync-readme-mirror.sh`. The GitHub README is a mirror, so do not edit it by hand.
- Hotfixes are an exception: skip the version bump, README updates, changelog pass, and Discord post. Just include a short bulleted list of exactly what was hotfixed.

Include a Discord-friendly update summary for non-hotfix releases so the changes can be freely posted without rewriting notes from scratch, using the following formatting template:
```
**SillyBunny version XXX has released**
(quick summary of changes)

**Detailed Changelog**
(technical details but still human readable)

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run git pull.
- Docker: run git pull, then sudo docker compose up -d --build (the --build is required to rebuild the local image).
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
```
#### Upstream sync

When a new, stable upstream SillyTavern version releases:

- Follow the upstream sync runbook in `docs/upstream-sync.md` before preparing a sync PR.
- Prioritize synchronizing to `staging` over new features and bug fixes.
- Check for code compatibility with the new version release.
- Remove and migrate any SillyBunny features or patches if they have been properly implemented upstream.
- Resolve merge conflicts carefully, ensuring that upstream changes do not overwrite SillyBunny's custom UI modifications, Bun-specific optimizations, or additional features.
- Verify that any new upstream UI elements (such as new settings, menus, or buttons) integrate correctly into the fork's modified DOM structure.
- Review the upstream changelog to identify any newly added dependencies or modifications to metadata/state formats.
- Test the synchronized code in both Bun and Node.js environments to confirm that runtime parity is maintained.
- Complete the synchronization as a standalone pull request before applying fixes to current bug chores in separate, subsequent updates.

---

## Setting up the dev environment

1. Required software: git and Bun for normal local development. Node.js and npm are also required when testing Node.js compatibility or matching CI behavior.
2. An IDE or editor of your choice. Visual Studio Code is a safe default.
3. You can also use GitHub Codespaces which sets up everything for you.

Native Termux contributors should use `bash start-termux-node.sh` for Node.js + npm unless specifically testing Bun behavior; use `bash start-termux-bun.sh` when checking Bun-specific behavior.

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

---

> [!WARNING]
> ### AI Disclaimer (Vibe Coding)
> LLMs are used liberally in this project to implement changes to the code. You are more than welcome to submit a PR with AI-assistance, as long as it aligns with the contribution guidelines and you understand and can explain the code being submitted in your own words.
