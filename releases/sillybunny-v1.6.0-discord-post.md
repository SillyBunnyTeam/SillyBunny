**SillyBunny version 1.6.0 has released**
This update consolidates the v1.6.0 staging work into main: safer preset/profile saves, full-chat navigation and search, mobile bottom-bar polish, pre-bundled workflow extensions, native chat completion tooling, pre-generation agent interceptors, iOS streaming stabilization, and runtime update hardening.

**Highlights**
- Preset and connection profile changes now save more reliably, wait for the latest selected profile, and avoid stale async preset applications overwriting newer choices.
- Bottom chat navigation now includes go-to-top and go-to-bottom controls, while chat search covers the full chat data including hidden or not-yet-rendered messages.
- Mobile bottom-bar controls now collapse cleanly, keep 44px touch targets, and avoid overlap across wider phone and tablet layouts.
- Guided Generations, Input History, Quick Image Gen, and Prompt Inspector are now pre-bundled.
- Chat Completion Tabs are now bundled natively for provider-specific chat completion controls.
- Pre-Generation Intercepts are a new In-Chat Agents feature for running agents before the main reply, with preserved mutations, stronger validation, and visible intercept history.
- NPC Motivator by Sheep is bundled as a starter Pre-Generation Intercept template.
- Pura's Director Preset is updated to V13.1, Geechan's Universal Roleplay presets are updated to V5.2, and Geechan's Universal Online Chat V1.0 is now bundled.
- Prose Polisher now supports Guided Generations impersonation polishing through its bundled opt-in prompt-pass update.
- Character menu and drawer updates improve mobile compactness, tab scrolling, desktop drawer alignment, and stale iOS cache handling.
- Bun launcher updates now retry dependency installs without `--frozen-lockfile` when the locked install fails.
- Echo, Whisper, Hush, Ripple, and Tide chat styles are now included natively.

**Fixed**
- Re-applied chat scroll anchoring so scrolling upward no longer skips earlier messages.
- Reduced iOS streaming pressure, unblocked cancelled streams, and added stability toggles for narrow mobile streaming surfaces.
- OpenRouter quantizations on connection profile requests now persist correctly.
- Docker startup regressions and the Webpack Chevrotain ESM alias issue are fixed.
- Profile prompt transforms now strip reasoning blocks instead of leaking them into transformed prompts.
- Memory Sharding quick replies now dedupe and handle force-update cases more reliably.
- Advanced formatting mobile headers, prompt editor layout, and mobile navigation focus received polish.

**Added**
- Guided Correction is now available in Guided Generations.
- Prompt Manager preview lets you inspect prompt output before use.
- OOC and HTML context-depth controls are now available.
- `xhigh` reasoning effort is available, and the old `auto` reasoning label has been renamed to `None`.
- Character card imports now warn when stripped `<script>` or `<iframe>` blocks are detected.
- Release documentation automation now records merged staging PRs in `changelog.md`.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen `Start.bat`, `Start.command`, or `start.sh`.
- ZIP users: grab the new release zip directly.
