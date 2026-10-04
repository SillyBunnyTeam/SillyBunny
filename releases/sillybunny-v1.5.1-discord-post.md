**SillyBunny version 1.5.1 has released**
This update focuses on Prose Polisher impersonation support, a cleaner Advanced Formatting workspace, faster/safer startup asset loading, stronger mobile polish, Pathfinder persistence fixes, and new Persona bottom bar chat-management tools.

**Highlights**
- Prose Polisher can now opt into Guided Generations impersonation output without mutating the previous assistant message.
- Advanced Formatting is now a first-class Workspace tab and remains visible across supported backends.
- Startup loading is lighter with deferred classic scripts, startup module preloads, a mobile-only stylesheet load, and a guarded service worker for static assets.
- Mobile and desktop UI polish pass: safer focus rings, cleaner shell borders, aligned headers/checkboxes, rounded mobile drawers, stabilized Recent Chats text, and tighter composer spacing.
- Persona bottom chat bar now has shortcuts for mass deleting current character/group chats and asking the active LLM to name the current chat.
- The mobile Persona bottom chat bar is more compact, including smaller avatar/buttons, tighter gaps, and narrow-phone spacing.

**Fixed**
- Thinking/reasoning collapse state now persists per message across chat switches and reloads.
- Pathfinder saving no longer turns the agent off or resets saved lorebook, pipeline, prompt, and tool selections.
- Pathfinder pipeline stage output defaults were raised to `32000` tokens and now have visible max-token controls in prompt editors.
- Save & Restart from the server admin UI now relaunches correctly from the Linux, macOS, and Windows launchers.

**Chat Management**
- Added Persona bottom bar mass delete for the current character/group scope.
- The open chat is protected during mass delete.
- Added aligned checkbox rows and 7/30/90/180 day cleanup presets.
- Added `/autonamechat` for LLM-assisted current chat naming.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen `Start.bat`, `Start.command`, or `start.sh`.
- ZIP users: grab the new release zip directly.
