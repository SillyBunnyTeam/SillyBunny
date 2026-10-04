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
`51ad27fb86d39a3daca3adaa970375c9670c12df` (tag `1.18.0`) as already ported into SillyBunny.
This is an ancestry reference, not the current synchronization target.

The ST staging parity sync (#843) later moved the merge base with upstream to
`c0a417b240c640037bab69529aa1e0c466c69397`, an ST `staging` commit contained in
`1.19.0`. The next tag sync should merge the target tag with a merge commit so
the merge base becomes the tag itself.

## Sync Target

SillyBunny syncs from the latest upstream SillyTavern release tag, not upstream
`staging`. `staging` currently sits on the #843 parity base above (between ST
`1.18.0` and `1.19.0`); the next sync target is ST `1.19.0`
(`7e8663cd9c184a550b37238218bdd32c6efc68e9`). After each tag sync, record the
new base here. When a new ST release is tagged, sync to that tag in a separate
`sync:` PR and update `ST_TAG` below.

Each tagged SillyBunny release records the ST release it is based on in
`changelog.md`, and `public/scripts/sillybunny-version-map.js` maps the SB
version to that ST minor.

Upstream ST tags must never reach `origin`:

```sh
git config remote.upstream.tagOpt --no-tags
```

Never run `git push --tags`. Push SillyBunny tags one at a time
(`git push origin vX.Y.Z`); bare upstream tags such as `1.19.0` would otherwise
be published to the SillyBunny repository.
The anchor merge must not import upstream runtime or application-code changes.
Any same-PR documentation changes should be explicit and reviewable in the file
diff.

## Refresh Upstream Refs

```sh
ST_TAG=1.19.0
git fetch --no-tags https://github.com/SillyTavern/SillyTavern.git \
  "refs/tags/$ST_TAG:refs/remotes/upstream/st-$ST_TAG"
```

Tags are fetched into `refs/remotes/upstream/` rather than `refs/tags/` so they
are never pushed by accident.

## Phase-Gate Drill

Run this before starting a new refactor phase and before an actual upstream sync.
When reviewing an ancestry-anchor PR before it merges, substitute `HEAD` for
`origin/staging`.

```sh
ST_TAG=1.19.0
git fetch origin
git fetch --no-tags https://github.com/SillyTavern/SillyTavern.git \
  "refs/tags/$ST_TAG:refs/remotes/upstream/st-$ST_TAG"

git merge-base --is-ancestor 51ad27fb86d39a3daca3adaa970375c9670c12df origin/staging
git merge-base origin/staging "refs/remotes/upstream/st-$ST_TAG"
git merge-tree --write-tree --name-only origin/staging "refs/remotes/upstream/st-$ST_TAG"
```

The first command must pass: the historical anchor stays in `staging` history.
The second prints the current merge base with the target tag; after a tag sync
it equals the tag commit. For `merge-tree`, a zero exit status means the merge
is clean; a nonzero status means conflicts need review, and the listed paths
after the tree ID are the conflicted files. Avoid `--quiet` here: it crashes on
git 2.55.

Conflicts must be confined to expected upstream-origin files and already
protected by `docs/upstream-touch-ledger.md` entries and tests.

For an upstream sync PR, review the complete change set since the previous ST base:

```sh
PREV_ST_TAG=1.18.0
git fetch --no-tags https://github.com/SillyTavern/SillyTavern.git \
  "refs/tags/$PREV_ST_TAG:refs/remotes/upstream/st-$PREV_ST_TAG"
git diff --stat "refs/remotes/upstream/st-$PREV_ST_TAG" "refs/remotes/upstream/st-$ST_TAG"
```

Use the output to identify fork-sensitive files and confirm that each divergence
is protected by the touch ledger and tests. Do not mix upstream sync
changes into unrelated feature or refactor PRs.
