**SillyBunny version 1.6.4 has released**
This update refreshes SillyBunny's 1.6.4 release metadata, README copy, GitHub mirror, and update notes while tightening backup diagnostics and in-chat agent save behavior.

**Detailed Changelog**

**Improved**
- The UI version label, Horde client identifier, and Horde server fallback now consistently advertise SillyBunny 1.6.4.
- Package metadata, root package-lock entries, and bundled extension manifests now align with the 1.6.4 release line.
- Release documentation now has 1.6.4 README, changelog, GitHub mirror, and Discord-ready summary copy.

**Added**
- Optional backup diagnostic logging can be enabled with `backups.chat.logging` to trace chat and settings backup writes, skips, and autosave triggers while investigating backup frequency.
- A 1.6.4 Discord release post is available under `releases/` for announcement publishing.
- Regression expectations were refreshed so release automation coverage tracks the current package version.

**Fixed**
- Older in-chat agent regex snapshots now compact on load when they can be safely resolved, and interim agent saves can defer regular chat backups until the final post-processed save.

**Removed**
- No user-facing features were removed in this release.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
