**SillyBunny version 1.6.5 has released**
This update introduces Companion Agents, sidecar-style auxiliary AI helpers that run alongside the main chat. It also adds an In-Chat Agent expression classifier with Quick Image Gen sprite generation, decoupled sampling settings, categorized settings tabs, more shell styles, and a large round of iOS, Windows, mobile, and stability fixes on top of 1.6.4.

**New: Companion Agents**
Companion Agents are extra AI helpers that sit beside the main chat. They read the conversation and do their own background job without interrupting the story, so one can track plot while another watches relationships and a third drafts worldbuilding notes.
- Each companion runs on a trigger mode you choose: auto (after a matching AI reply) or manual. You can gate it with keyword or regex conditions and a probability percentage so it fires only some of the time or only on specific patterns.
- Show a companion how you want it: inline note cards (with regenerate, edit, copy, and delete), a draggable slide-out side panel that docks to any screen edge, or hidden so it feeds future runs without showing. The panel adds jump-to-source-message, per-companion run history, a lock-open button, and a regenerate-all action.
- A dedicated Companion Agents dashboard (from the wand menu and an extension toolbar button) manages every companion across all your chats. Create new ones, import from file, pick from bundled templates, enable or disable with one tap, and convert eligible inline agents to companion execution.
- One-click conversion flips an agent between inline and companion execution from the agent card or a bulk select action, and keeps its prompt, regex scripts, injection, and conditions.
- Trackers you convert to companion execution get an automatic loop by default: they run after every reply, send the raw prompt verbatim, feed the latest state back into the next generation, and show that state in the side panel instead of chat cards.
- Tune each companion on its own: trigger, display mode, output format (markdown, HTML, or plain text), context depth, token thresholds and limits, which context to feed it (character card, persona, world info, author's note, system prompt, prior notes), self-feedback depth, raw prompt mode, shared-request batching, and its own model, temperature, and reasoning settings. Companions can run in parallel or one after another.
- Ships with 11 ready-to-use companions: Continuity Companion, Relationship Lens, Director's Commentary, Actor Interview, Lorebook Scout, Memory Shard, NPC Motivator, Plot Compass, Chatroom, Message Inbox, and Chat Only.
- Companions tied to a specific chat are removed automatically when that chat is deleted.

**Added**
- In-Chat Agent expression classifier that drives Quick Image Gen sprite generation, so an agent can pick a character expression and generate a matching sprite.
- Fix Trackers button that re-runs tracker agents to rebuild tracker state, with repair controls that stay visible for every enabled tracker, including legacy and pre trackers.
- Sampling settings can be decoupled from chat completion presets so model sampling profiles load on their own.
- Quick delete shortcut button on the message actions.
- Categorized settings tabs that wrap into a grid on desktop.
- More shell styles and reduced option padding in Customize.
- Hide toggle and a direct hide button for the bottom chat bar.
- ADHDBunny-UI added to the Launchpad optional installs.

**Improved**
- Prose Polisher maximum output tokens raised to 32000.
- Synced the bundled Quick Image Gen extension to v2.1.0.
- World info entry controls are now more compact.
- Extension load diagnostics give clearer detail when an extension fails to load.
- Mobile rail and quick-action model selection route through the mobile-shell-lifecycle module for steadier narrow-screen behavior.

**Fixed**
- Chat backup count is now capped to 25 by default instead of unlimited, preventing unbounded accumulation over time.
- Pre-write chat backups skip writing when the on-disk content is unchanged, reducing redundant snapshots during rapid save flows like swiping.
- SillyBunny to SillyTavern version mapping is corrected so extensions check compatibility against the right version.
- iOS WebKit boot failures are now surfaced instead of failing silently, with hardened frontend boot recovery.
- Clear cookies and cache now works on iOS WebKit.
- iOS chat overscroll blanking and keyboard composer displacement are fixed.
- Public JS revalidation caching is restored, and script.js loads under its bare URL to restore a single module identity.
- Generated install metadata is restored before updates run.
- Frontend restart now works on Windows through a unified graceful shutdown, and server.js is self-supervising so restart works everywhere.
- Windows write fallback is hardened, and direct writes are avoided after Windows temp rename failures.
- Character saves are protected from a stale frontend, pending saves are canceled when switching characters, and the editor form no longer resets when selecting a character.
- Stale CSRF tokens are refreshed, and group chat loads retry after a refresh.
- OpenAI preset selection is preserved on backend switch, and the user backend is preserved on settings load instead of switching to the reverse proxy source.
- Stale settings overwrites are now prevented.
- Agent enable and disable toggle now responds on mobile.
- Mobile keyboard no longer hides the composer, and stuck mobile message updates are force-flushed.
- MovingUI panels are stabilized on desktop.
- Mobile cache utility layout is fixed, and profile buttons no longer squish.
- Guided Generations now honors impersonation perspective prompts.
- The constant "Model sampling profile loaded" toast is removed.

**Removed**
- No user-facing features were removed in this release.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Docker: run git pull, then sudo docker compose up -d --build (the --build is required to rebuild the local image).
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
