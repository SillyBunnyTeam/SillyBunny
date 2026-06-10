# Upstream Sync Runbook

SillyBunny keeps fork-specific feature work separate from upstream synchronization work.
Use this runbook when checking or preparing an upstream SillyTavern sync.

## Upstream Ancestry Anchor

SillyBunny's public history was re-rooted before the SillyTavern 1.18 migration,
so older SillyBunny commits do not share Git ancestry with upstream even though the
1.18 code was manually ported.

The branch that anchors upstream ancestry must be merged with a normal merge
commit. Do not squash or rebase that PR: either option drops the upstream parent
and restores the unrelated-history failure.

The anchor records upstream `SillyTavern/SillyTavern` `release` at commit
`51ad27fb86d39a3daca3adaa970375c9670c12df` as already ported into SillyBunny.
The anchor merge must not import upstream runtime or application-code changes.
Any same-PR documentation changes should be explicit and reviewable in the file
diff.

## Refresh Upstream Refs

```sh
git fetch https://github.com/SillyTavern/SillyTavern.git \
  refs/heads/release:refs/remotes/upstream/release \
  refs/heads/staging:refs/remotes/upstream/staging
```

## Phase-Gate Drill

Run this before starting a new refactor phase and before an actual upstream sync.

```sh
git fetch origin
git fetch https://github.com/SillyTavern/SillyTavern.git \
  refs/heads/release:refs/remotes/upstream/release \
  refs/heads/staging:refs/remotes/upstream/staging

git merge-base origin/staging refs/remotes/upstream/release
git merge-tree --quiet origin/staging refs/remotes/upstream/release
```

Passing state for the current upstream `release` is a valid merge base and a
zero exit code from `merge-tree --quiet`. If conflicts appear, list them with:

```sh
git merge-tree --name-only origin/staging refs/remotes/upstream/release
```

Conflicts must be confined to expected upstream-origin files and already
protected by `docs/upstream-touch-ledger.md` entries and tests.

For upcoming upstream work, also preview `upstream/staging`:

```sh
git merge-tree --name-only origin/staging refs/remotes/upstream/staging
```

Treat the output as an early warning list only. Do not mix upstream staging sync
changes into unrelated feature or refactor PRs.
