**SillyBunny version 1.5.2 has released**
This update adds the Group Utilities bundle to Launchpad, improves migration guidance for Moonlit Echoes and Guided Generations, restores Pathfinder access to chat-attached lorebooks, fixes group-chat continuity, and focuses on mobile Safari chat stability.

**Highlights**
- Group Utilities is now available from Launchpad optional installs, including group presence, greetings, shared context, and SendAs helpers.
- Moonlit Echoes migration notices now stay visible until handled, with a Launchpad action that opens the Theme card directly.
- Guided Generations users now get a fork notice pointing to the SillyBunny-compatible fork in Launchpad.
- Pathfinder now searches active chat-bound, character, extra character, persona, and manual lorebooks by default.
- Workspace tabs and mobile shortcuts now keep API immediately after Presets.

**Fixed**
- Pathfinder diagnostics now show manual/contextual lorebook counts, validate registered tools correctly, and warn on unmatched candidate entry JSON.
- Group chats now reopen the active group edit panel, persist Auto Mode correctly, and include private DM history for the active speaker without leaking it to other speakers.
- Swipe deletion no longer retriggers already-run post-generation agents, and long agent output-history diffs keep Undo/Redo visible.
- Auto-label Chat handles longer/reasoning model title output and falls back cleanly when structured titles are unavailable.
- CYOA Choices no longer renders blank optional choice rows.

**Mobile and UI polish**
- Mobile chat rendering uses smaller batches, off-screen containment, batched post-processing, and visible-media waits to reduce WebKit pressure.
- Streaming replies now update formatted DOM live more efficiently and keep stream-fade disabled cases visually current.
- iOS Safari send flows render user messages before slow handoffs, server ping, or group setup, then hold bottom scroll position to avoid delayed sends and snap-backs.
- Background Visibility now supports 100%, with solid chatbar/composer surfaces and hardened shell layers for high-visibility or no-blur setups.
- Characters, Workspace, navigation, and Quick Actions drawers have tighter mobile spacing, safer bounds, and cleaner right-lock behavior on macOS desktop browsers.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen `Start.bat`, `Start.command`, or `start.sh`.
- ZIP users: grab the new release zip directly.
