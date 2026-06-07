**SillyBunny version 1.6.3 has released**
This release focuses on safer chat switching and cloning, steadier mobile/persona controls, clearer launchers, theme-aware UI polish, and tighter in-chat agent behavior.

**Detailed Changelog**
- Runtime launchers are clearer, with explicit Bun and Node.js options for Windows, macOS, Linux/WSL, and Termux.
- Verbose prompt payload logging now stays behind the prompt log preference.
- Chat cloning, pending swipe saves, and chat integrity tokens were hardened to prevent stale writes, chat-switch races, and cross-device history loss.
- Persona Scenario Notes, mobile alternate greetings, persona icon actions, and persona spacing now persist and align more reliably per character card.
- In-chat agent generation keeps stop/message controls visible and ignores unrelated generation refresh payloads.
- Mobile search close handling stabilizes the viewport and auto-focuses search without yanking the page out of place.
- Toast colors and message-block transparency now follow the active theme more consistently.
- Tool-call recursion limit settings now apply at runtime.
- Top-bar character shortcuts now toggle closed cleanly.
- No user-facing features were removed in this release.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
