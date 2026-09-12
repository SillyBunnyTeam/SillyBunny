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

The historical anchor records upstream `SillyTavern/SillyTavern` `release` at commit
`51ad27fb86d39a3daca3adaa970375c9670c12df` as already ported into SillyBunny.
This is an ancestry reference, not the current synchronization target. Current
upstream synchronization targets `SillyTavern/SillyTavern` `staging`.
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
When reviewing an ancestry-anchor PR before it merges, substitute `HEAD` for
`origin/staging`.

```sh
git fetch origin
git fetch https://github.com/SillyTavern/SillyTavern.git \
  refs/heads/release:refs/remotes/upstream/release \
  refs/heads/staging:refs/remotes/upstream/staging

expected_historical_release_anchor=51ad27fb86d39a3daca3adaa970375c9670c12df
actual_historical_release_anchor="$(git merge-base origin/staging refs/remotes/upstream/release)"
test "$actual_historical_release_anchor" = "$expected_historical_release_anchor"
git merge-tree --quiet origin/staging refs/remotes/upstream/staging
```

Passing state for the historical upstream `release` anchor is the expected merge
base. For the active upstream `staging` target, a zero exit status means the
merge is clean; a nonzero status means conflicts need review. List conflicts
with:

```sh
git merge-tree --name-only origin/staging refs/remotes/upstream/staging
```

Conflicts must be confined to expected upstream-origin files and already
protected by `docs/upstream-touch-ledger.md` entries and tests.

For an upstream sync PR, review the complete `upstream/staging` change set:

```sh
git merge-tree --name-only origin/staging refs/remotes/upstream/staging
```

Use the output to identify fork-sensitive files and confirm that each divergence
is protected by the touch ledger and tests. Do not mix upstream staging sync
changes into unrelated feature or refactor PRs.
