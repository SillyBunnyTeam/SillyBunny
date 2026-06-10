**SillyBunny version 1.6.4 has released**
This update adds a built-in ZIP auto-updater for non-Git installs, token estimates in the chat selector, serialized chat saves, and a round of mobile, chat-backup, and generation-life-cycle fixes on top of 1.6.3.

**Added**
- Built-in ZIP auto-update lets non-Git installs check for and apply new SillyBunny releases directly from Customize > Server.
- The chat selector now shows an approximate token count for each saved chat so you can see chat sizes at a glance before switching.

**Improved**
- Top bar height, message padding, and mobile chat density were tightened for a cleaner layout on phones and desktops.
- Mobile shell overlay exclusivity, drawer bounds, and viewport sync were consolidated into the mobile-shell-lifecycle module for steadier narrow-screen behavior.
- Settings tab now uses a distinct icon for easier recognition in the navigation shell.
- Optional backup diagnostic logging (`backups.chat.logging`) can trace chat and settings backup writes, skips, and autosave triggers while investigating backup frequency.

**Fixed**
- Chat saves are now serialized through a single queue to prevent save corruption when multiple saves fire at once.
- Stopping an in-flight agent generation now reliably aborts the upstream request and releases the generation lock so the UI returns to its idle state.
- Creating a new group chat now correctly branches a new chat file and preserves the new chat id during validation.
- Quick Replies bar is now centered alongside the popout trigger, and the floating edit indicator pill was removed from the message edit UI.
- Desktop quick actions no longer shift the shell layout while the chat is open.
- Mobile character panel close button no longer floats above the header.
- Preset dropdown scroll taps are now guarded so list items cannot be mis-tapped while scrolling on mobile.
- iOS-specific fixes restore the main screen layout, refresh a stale service worker cache, and revalidate default frontend assets after app updates.
- Legacy World Info positions are now normalized at scan time.
- Screenshots now strip hidden content from closed `<details>` elements instead of capturing invisible text.
- Search jumps can no longer shift or clip the fixed viewport by clipping root overflow.
- Chat backup bloat is reduced: older agent regex snapshots compact on load, interim agent saves defer regular backups until the final post-processed save, and duplicate post-save backups are skipped when only chat integrity changes.
- Agent profile requests now respect reverse proxy headers so profile resolution works behind proxies.
- Windows ZIP update guidance is clearer for users running from a ZIP instead of Git.

**Removed**
- No user-facing features were removed in this release.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
