# Changelog

## v1.7.1

### Merged Staging PRs
- PR #743 (2026-08-07) `fix: conversation mode send/save/cancel buttons non-functional`
- PR #747 (2026-08-14) `feat: add Chats Archive as a core extension`
- PR #748 (2026-08-09) `fix: Pathfinder bug fixes + making two features that weren't tied to anything real`
- PR #749 (2026-08-09) `feat: implement Pathfinder tool confirmation and mandatory tool use`
- PR #750 (2026-08-10) `fix: messages wrapped in <pre> wrap over instead of going beyond bounds`
- PR #751 (2026-08-10) `chore: update Pura's Director Preset to 15.1 and the corresponding trackers`
- PR #752 (2026-08-10) `chore: update Quick Image Gen to 3.0.1`
- PR #753 (2026-08-11) `fix: no redundant ICA toasts when updating bundled agents`
- PR #754 (2026-08-11) `fix: hardens save path for remote servers`
- PR #755 (2026-08-14) `fix(linkapi): prevent sending presencePenalty and frequencyPenalty samplers to Grok`
- PR #756 (2026-08-14) `fix(tokeniser): count every message all at once instead of one by one`
- PR #757 (2026-08-14) `chore: remove remaining graphify artifacts`
- PR #758 (2026-08-14) `fix(ui): bulk edit no longer bunches up characters together`
- PR #760 (2026-08-15) `fix(mobile): stop the viewport jumping while typing on mobile`
- PR #761 (2026-08-15) `chore: fix the graphify guard regex matching its own filename`
- PR #762 (2026-08-15) `fix(server): reworks port handling on Windows+Bun (#710)`
- PR #763 (2026-08-15) `chore: update Quick Image Gen to 3.1.1`
- PR #764 (2026-08-16) `fix(ica): harden the separation between Companion Agent and Pre-generation Inline Agent trackers`
- PR #765 (2026-08-16) `fix(connection_profiles): harden custom endpoint switches and additional parameter saving`
- PR #766 (2026-08-16) `fix(markdown): ensure markdown text wraps around as usual`
- PR #767 (2026-08-17) `feat: add the model name and reasoning effort after the icon`
- PR #768 (2026-08-17) `chore: update Quick Image Gen to 3.2.0`
- PR #769 (2026-08-17) `chore: gitignore the Quick Image Gen sync's leftover merge folder`
- PR #771 (2026-08-18) `fix: hardens chat scroll jumping`
- PR #772 (2026-08-18) `fix: list only mode now gets bigger and stretches to screen`
- PR #773 (2026-08-18) `fix: character menu controls no longer spill out of non-wide browsers`
- PR #774 (2026-08-20) `fix(ui): Manage extensions and Install Extension are now on their own rows`
- PR #775 (2026-08-20) `fix(mobile): message box text that says "Type a message, or /? for help" is no longer truncated`

## v1.7.0

**SillyBunny version 1.7.0 has released**
This update features comprehensive bug fixes all across the board, as well as a new feature, Conversation Mode!

**New: Conversation Mode**
Conversation Mode is inspired by instant messaging apps like Discord, Telegram, and Signal. Interface is more inspired by Telegram and Signal than Discord, however. Among a few features includes: solo messaging, group messaging, selfies, reminders, scheduling, and more! Based heavily on TheLonelyDevil's [Discord Pals](https://github.com/TheLonelyDevil9/discord-pals), check it out!

### Fixed
- Companion Agent fixes for regeneration, the fix trackers buttons, the general HTML regexes, and added more customisation options for Companion Agents, both in the Companion Agent drawer and the settings themselves.
- Fixed sampling profile, custom endpoint, secret binding, proxy isolation, and connection profile issues.
- Hardened chat saving, backups, renaming, metadata preservation, and unnecessary resaving. There should now be less backups overall, and your chat suddenly deleting and moving to the greeting while the rest disappears are now highly mitigated, as much as possible.
- Fixed compatibility for third-party extensions CharacterLibrary and ST-Copilot. Should be future-proofed for other third-party SillyTavern extensions but it depends. Open an issue on Github for specific extensions and we can take a look.
- Corrected Claude responses, Gemini thought signatures, Grok dialogue, and SillyTavern version mapping for extensions by hard-coding it to the latest version, 1.18.0.
- Fixed TTS extension reading the font color tags and HTML tags.
- Fixed multiple platforms' device issues with starting SillyBunny in either node or bun.
- Corrected some WebKit layout issues.
- Termux bun launch should now work better due to reordering of how dependencies are found and installed.
- Fixed UI bugs such as button and tag truncations.

### Added
- Conversation Mode for DM-style RPs with your characters.
- Added the hardcoding for the latest new models for different backends at the time of release. They should still be automatically updated via your API, this is just for UI/cleaning purposes.
- LinkAPI-specific backend with auto-routing, and Custom Endpoint Profiles for Custom OpenAI-compatible backend, similar to the Reverse Proxy option in other backends like AI Studio.
- Option to add more desktop top bar quick shortcuts.
- Option to include every page icon on the desktop and mobile top bar.
- Companion Agent settings - adding the ability for agents to depend on each other, send context to each other, and wait for other agents to finish before starting a specific one.
- A wand icon in the Custom CSS menu that allows you to request your equipped LLM what to add or change.
- Locks on every dropdown for Bunny Preset Tools to prevent random reopening and reclosing when using mobile devices, as well as allowing dropdown reordering.
- Delete-and-add swipe and TTS stop actions.
- Verbose console logging.
- Sorting by newest added character.
- Optional disabling of core extensions.
- New model/provider icons, control labels, model variants, and Kimi K3 partial-prefill support.
- Opt-in `bun --smol` launcher support on devices that need arguments before the start command. Use `SILLYBUNNY_BUN_SMOL=1 ./start.sh` to launch a small device-friendly SillyBunny.
- New agents: Level Up Companion, User-based Stats, and CYOA Choices with Skill Checks.

### Changed
- Reworked the home screen.
- Updated Quick Image Gen to upstream `v3.0.0`, with SillyBunny-specific compatibility.
- Updated Pura’s Director Preset, Grounded Prose Rules, TLD Card Conversion, and Memory Shard agent.
- Reorganized custom agent templates into content and tracker categories.
- Changed the default window size to Snap to Chat Width behavior.
- Main LLM messages by default now output before pre-generation intercept agents change them.
- Updated non-English README files to reference SillyBunny.

### Improvements
- Improved Android mobile performance.
- Improved mobile shell loading, touch behavior, horizontal navigation, and keyboard handling.
- Added more accent profiles.
- Added clearer iOS startup diagnostics.
- Improved accessibility labels and compact mobile controls.
- Improved documentation.

### Removed
- Removed deprecated model entries.
- Removed dead code.
- Removed placeholder text from the UI.
- Deprecated Group DMs from Group Chats, as they are now delegated to Conversation Mode.

### Supporting Mechanical Staging PR Ledger
- PR #495 (2026-06-15) `chore: bump version to 1.7.0`
- PR #496 (2026-06-16) `fix: keep card and hidden companions out of the tracker panel`
- PR #497 (2026-06-16) `fix: clamp unmapped SB minors to highest synced ST version`
- PR #498 (2026-06-16) `fix: prevent Windows file locks during chat integrity checks`
- PR #499 (2026-06-16) `feat: add edit button to companion previous states in tracker panel`
- PR #500 (2026-06-16) `feat: add availableSprites macro for Expressions Agent`
- PR #501 (2026-06-16) `feat: add desktop top bar shortcut slots`
- PR #502 (2026-06-16) `chore: sync Quick Image Gen v2.2.0`
- PR #503 (2026-06-18) `feat: add character Conversation Mode for Discord-style DMs`
- PR #505 (2026-06-18) `fix: re-apply model sampling profile after preset changes`
- PR #506 (2026-06-19) `fix: scope conversation connection profile without switching the global profile`
- PR #507 (2026-06-19) `chore: add missing MAX_AGENT_MAX_TOKENS export to agent-store test mocks`
- PR #508 (2026-06-19) `chore: sync stale test expectations to current source`
- PR #509 (2026-06-19) `fix: coalesce consecutive user messages in conversation mode`
- PR #510 (2026-06-19) `fix: navigate to exact setting from universal search`
- PR #511 (2026-06-19) `chore(frontend-budgets): raise blocking stylesheet bytes and startup script count ceilings`
- PR #512 (2026-06-19) `fix: prevent empty conversation replies when persona description uses brackets`
- PR #513 (2026-06-19) `fix: detect Node.js in standard install paths in Start-Node.bat`
- PR #514 (2026-06-19) `fix: snapshot client socket address so streaming abort detects Bun disconnects`
- PR #515 (2026-06-19) `fix: exclude hidden messages from companion context threshold so the memory shard waits for fresh context`
- PR #516 (2026-06-19) `fix(ica): guard main generation against echoing companion tracker format`
- PR #517 (2026-06-19) `fix: surface custom-category templates (HTML Toggle, etc.) in the templates browser`
- PR #518 (2026-06-19) `fix: make swipe DOM updates instant`
- PR #519 (2026-06-19) `fix: keep mobile shell visible during keyboard viewport shifts`
- PR #520 (2026-06-19) `fix: lazy-load Conversation Mode runtime`
- PR #521 (2026-06-19) `chore: hard-code Claude Opus 4.8 and GLM-5.2`
- PR #522 (2026-06-19) `fix: bootstrap bun-termux on Termux`
- PR #523 (2026-06-19) `fix: restore iOS keyboard shell offset broken by invalid CSS comments`
- PR #524 (2026-06-19) `chore: guard all first-party CSS against invalid // comments`
- PR #536 (2026-06-19) `fix: block pinch-zoom viewport drift on Android Firefox`
- PR #537 (2026-06-19) `fix: block multi-touch pinch-zoom on Firefox mobile`
- PR #538 (2026-06-19) `fix: scan all Claude content blocks for text, not just content[0]`
- PR #543 (2026-06-19) `fix: use 5-column grid for home action buttons and update TLD site link to BotBooru`
- PR #544 (2026-06-19) `chore: update TLD Card Conversion Preset to v8`
- PR #548 (2026-06-20) `fix: hide unused STscript controls in mobile composer`
- PR #549 (2026-06-20) `fix: scroll mobile drawer inputs above the keyboard`
- PR #550 (2026-06-20) `chore: reclassify custom in-chat agent templates into content and tracker`
- PR #551 (2026-06-20) `feat: add custom OpenAI-compatible endpoint profiles`
- PR #553 (2026-06-20) `feat: lock and reorder BunnyPresetTools section dropdowns`
- PR #554 (2026-06-20) `feat: add custom accent color profiles`
- PR #556 (2026-06-20) `feat: sort model favorites alphabetically and scope Custom favorites per URL`
- PR #557 (2026-06-20) `fix: preserve Bunny Preset Tools section icons`
- PR #558 (2026-06-20) `fix: persist Pathfinder section collapse state`
- PR #559 (2026-06-20) `chore(agents): update Grounded Prose Rules template`
- PR #560 (2026-06-20) `fix: bind custom endpoint profiles to saved secrets`
- PR #561 (2026-06-20) `fix(companion-panel): keep manual Play button visible after first run`
- PR #562 (2026-06-20) `fix: improve WebKit prefix parity and iOS guards`
- PR #563 (2026-06-20) `fix(ica): regenerate extract trackers from Fix Trackers`
- PR #564 (2026-06-20) `feat(in-chat-agents): live HTML preview and regenerate for custom tracker builder`
- PR #566 (2026-06-20) `feat(in-chat-agents): add textarea fullscreen toggles`
- PR #567 (2026-06-20) `fix: bind Custom endpoint status checks to profile secrets`
- PR #568 (2026-06-20) `fix: backport shell polish and loading-state fixes`
- PR #569 (2026-06-20) `fix: continue mobile shell state and UI polish`
- PR #571 (2026-06-20) `chore: streamline PR workflow runs`
- PR #572 (2026-06-20) `feat: Conversation mode & general UI polish`
- PR #576 (2026-06-21) `fix: restore mobile shell cascade guards`
- PR #577 (2026-06-21) `feat: add line spacing slider`
- PR #579 (2026-06-21) `fix: prevent companion panel blur flash on close`
- PR #581 (2026-06-21) `feat: add custom CSS AI wand`
- PR #585 (2026-06-21) `fix: Desktop Padding Reverts`
- PR #587 (2026-06-21) `fix: let in-chat agent trim regex actually work`
- PR #588 (2026-06-21) `fix: stop custom endpoint Connect from clobbering profile keys`
- PR #590 (2026-06-21) `fix: DOM content bleed over user and assistant messages`
- PR #591 (2026-06-23) `feat: show main LLM message before pre-generation intercept`
- PR #592 (2026-06-22) `feat: improve accent profile settings`
- PR #594 (2026-06-22) `fix: workspace and customize shortcuts toggle use intended behaviour`
- PR #595 (2026-06-22) `fix: PR unit test regression cleanup`
- PR #596 (2026-06-22) `feat: add margin size slider`
- PR #597 (2026-06-22) `fix: auto-close the post-generation ICA toast`
- PR #599 (2026-06-22) `fix: make Icons Only work on horizontal side rail`
- PR #600 (2026-06-22) `chore: add Pura's Director Preset 14.0 and RPG elements as agents`
- PR #601 (2026-06-22) `fix: make regex HTMLs work universally on ICA`
- PR #602 (2026-06-22) `fix: prevent switching branches from hanging`
- PR #606 (2026-06-22) `feat(console): add verbose logging toggle`
- PR #608 (2026-06-23) `fix: use set group chat greetings + harden group chat creation`
- PR #609 (2026-06-23) `fix(group_chat): fix group chat new messages + add greetings button QoL`
- PR #610 (2026-06-23) `fix: hide the iOS "not loading" warning when not applicable`
- PR #616 (2026-06-23) `docs: update alt language README files`
- PR #617 (2026-06-26) `chore: update Quick Image Gen to 2.2.1`
- PR #618 (2026-06-26) `fix: viewport escaping out of bounds due to dragging in general`
- PR #619 (2026-06-26) `fix(ui): make edit message icons smaller on mobile`
- PR #620 (2026-06-26) `feat(ui): preset settings dropdown`
- PR #621 (2026-06-27) `fix(connection_profile): persist custom endpoint profiles secret`
- PR #623 (2026-06-27) `fix(mobile_ui): soften touch guards and re-allow scrolling`
- PR #624 (2026-06-27) `feat(qol): add a Delete + Add Swipe button`
- PR #625 (2026-06-27) `chore: Change default for 'Snap to Chat Width'`
- PR #626 (2026-06-28) `fix: Hardening viewport escaping across the board`
- PR #627 (2026-07-27) `fix: Performance Optimizations for mobile on Android`
- PR #629 (2026-06-28) `feat(tts) - add stop button for TTS playback`
- PR #630 (2026-07-01) `fix(ica): render macros in Companion Agents drawer`
- PR #631 (2026-07-01) `feat(ica): add a hide/unhide button for every agent in the Companion Agents drawer`
- PR #633 (2026-07-01) `fix(sampling_profile): automatic sampling profile switch`
- PR #635 (2026-07-01) `fix(custom_css): allow importing of custom CSS when uploading themes that have it`
- PR #636 (2026-07-01) `fix(mobile_webkit_safari): steady the input textbox viewport`
- PR #637 (2026-07-01) `feat(ica): include the number of tokens used by agents in the UI`
- PR #639 (2026-07-07) `fix(profiles): resolve custom endpoint secret persistence, connection profile consistency, and sampling profile UX`
- PR #640 (2026-07-07) `fix: Batch Importing Embedded Lorebooks Correctly in One Shot`
- PR #641 (2026-07-07) `fix: Endpoint Profiles Not Loading Correctly in Clientside UI`
- PR #642 (2026-07-05) `fix(ipad_webkit_viewport): steady text box input viewport on iPadOS`
- PR #643 (2026-07-08) `chore: more SVGs for different models/companies`
- PR #644 (2026-07-08) `fix(ica): minimum context overrides number of messages in Companion Agents`
- PR #645 (2026-07-08) `fix: requests made under a connection profile no longer inherit the currently active proxy`
- PR #646 (2026-07-08) `fix: click-to-toggle header text now opt-in`
- PR #647 (2026-07-08) `fix: Gemini thought signatures getting mangled/corrupted`
- PR #648 (2026-07-08) `fix: agent prompt editor blow-up being shapeless/formless with text spilling off-screen`
- PR #649 (2026-07-08) `feat: add LinkAPI chat completion provider integration with auto-routing`
- PR #650 (2026-07-09) `fix(ica): viewing the in-chat agents injected into the preset should show their actual names`
- PR #651 (2026-07-09) `fix(card_imports): fixes chub AI import API + botbooru support`
- PR #652 (2026-07-09) `fix(mobile): restore viewport pan hardening and keep popup inputs above the keyboard`
- PR #653 (2026-07-09) `fix(tests): cover secret-bound profiles dropping plaintext keys (split from #627)`
- PR #654 (2026-07-09) `feat: New ordering mechanism for agents and companion sidebar`
- PR #655 (2026-07-09) `fix: that funkily-sized button (guided generations flush/sweep)`
- PR #656 (2026-07-09) `fix: Grok example dialogue glitch`
- PR #657 (2026-07-11) `feat(agents): let post-generation passes target companion outputs, impersonation text, and picked targets`
- PR #658 (2026-07-11) `fix(mobile): hold the chat composer above the iOS keyboard to stop the viewport escape`
- PR #659 (2026-07-15) `chore: add the new GPT 5.6 variants, Sonnet 5, remove deprecated models`
- PR #661 (2026-07-12) `fix: Favs not lighting up, scrolling favorites on desktop, validator behavior changes, etc`
- PR #662 (2026-07-15) `fix(chat_files): hardens chat files, fixes backups and chat renaming`
- PR #663 (2026-07-15) `fix(continue): continue button also works when thinking is interrupted`
- PR #664 (2026-07-15) `fix(ios): add exception to viewport fix on message box`
- PR #665 (2026-07-15) `fix(mobile): remove icon overlap on message box`
- PR #667 (2026-07-15) `fix(tts): TTS extension only considers actual quotes`
- PR #668 (2026-07-15) `fix: Viewport scrolling offscreen in-depth`
- PR #670 (2026-07-17) `fix(mobile): allow horizontal sliding`
- PR #675 (2026-07-17) `fix: Start-Node.bat unescaped parentheses causes immediate exit`
- PR #676 (2026-07-17) `fix: Bun throws EEXIST on mkdir when SillyBunny is installed inside OneDrive`
- PR #677 (2026-07-20) `chore: refresh and update Pura's Director Preset to 15.0`
- PR #678 (2026-07-22) `fix(ios): includes backwards compatibility of viewport fix for old iOS versions`
- PR #680 (2026-07-22) `feat: Card sorting option based on newest additions (for real)`
- PR #682 (2026-07-23) `chore: Update Group Utilities Link to correct GitHub`
- PR #683 (2026-07-24) `chore: enforce LF line endings via .gitattributes`
- PR #687 (2026-07-25) `fix: issue of being unable to import or rename any preset to any user-deleted bundled default presets`
- PR #688 (2026-07-25) `fix: characters with spaces show proper thumbnails`
- PR #689 (2026-07-26) `feat(launcher): gate bun --smol behind SILLYBUNNY_BUN_SMOL`
- PR #690 (2026-07-26) `fix: Chat saving issue resolution via hardening`
- PR #691 (2026-07-26) `fix: WI activation sliders width consistency`
- PR #692 (2026-07-26) `fix: overlap between favorites bar and Roleplay/Conversation selector`
- PR #693 (2026-07-26) `fix: Dropdowns scrollbar fixes`
- PR #694 (2026-07-26) `fix: QR Stale Bar Fix`
- PR #695 (2026-07-26) `chore: Clean up dead references`
- PR #696 (2026-07-26) `chore: Add labels for 23 control elements`
- PR #697 (2026-07-26) `chore: hardcoded values revised for z index in extension menu/options/popper modal`
- PR #698 (2026-07-26) `fix: subtitle tooltip for shell subtitles`
- PR #699 (2026-07-27) `feat: Allow disabling core extensions`
- PR #700 (2026-07-27) `fix(proxy): resolve the 'None' no-proxy error`
- PR #701 (2026-07-27) `fix(style): anchor bottom-positioned toasts to viewport on mobile`

### Merged Staging PRs
- PR #136 (2026-05-18) `fix: stop post-gen agents re-running on mobile recovery events`
- PR #702 (2026-07-28) `chore: prepare v1.7 pre-release cleanup`
- PR #703 (2026-07-29) `feat: reuse Start Reply With for Kimi K3 partial prefill`
- PR #704 (2026-07-30) `fix(ios): fix iOS crash startup logs not being detailed enough`
- PR #705 (2026-08-03) `fix(termux): fix the ordering of what is installed first on start-termux-bun.sh`
- PR #708 (2026-08-03) `fix: chats no longer constantly resave when opening them`
- PR #709 (2026-08-03) `fix: character metadata is preserved`
- PR #711 (2026-08-03) `fix(server): port now closes if it's unused`
- PR #712 (2026-08-03) `fix: character card metadata fixes (windows edition)`
- PR #725 (2026-08-04) `fix(ica): fix memory shard completely hiding the previous shard`
- PR #729 (2026-08-04) `fix: fix CharacterLibrary and ST-CoPilot incompatibilities`
- PR #731 (2026-08-04) `fix(characters): align favourites bar across tabs`
- PR #732 (2026-08-04) `feat(home): rework home screen for v1.7.0 release`
- PR #733 (2026-08-04) `docs: replace old 1.7.0 home screen screenshots with the new homepage UI`
- PR #734 (2026-08-05) `fix: conversation mode selected character`
- PR #736 (2026-08-05) `chore: update Quick Image Gen to 3.0.0`
- PR #737 (2026-08-05) `chore: remove previous non-1.7.0 screenshots`
- PR #738 (2026-08-06) `chore: merge 1.7.0 staging cleanly into main`

## v1.6.5

Date: 2026-06-15

This update introduces Companion Agents, sidecar-style auxiliary AI helpers that run alongside the main chat. It also adds an In-Chat Agent expression classifier with Quick Image Gen sprite generation, decoupled sampling settings, categorized settings tabs, more shell styles, and a large round of iOS, Windows, mobile, and stability fixes on top of 1.6.4.

### Added
- Added Companion Agents: sidecar-style auxiliary AI helpers that run alongside the main chat, reading the conversation and doing their own background job (tracking plot, watching relationships, drafting worldbuilding notes, summarizing history, and more) without interrupting the story.
- Companions run on one of two trigger modes, auto (after matching AI replies) or manual, with optional keyword/regex conditions and a probability percentage to fire only some of the time or on specific patterns.
- Companions can display as inline note cards (with regenerate, edit, copy, and delete actions), in a draggable slide-out side panel that docks to any screen edge, or hidden (feeding future runs without showing). The panel supports regenerate, manual note edits, jump-to-source-message, per-companion run history, a lock-open button, and a regenerate-all action.
- Added a dedicated Companion Agents dashboard (reachable from the wand menu and an extension toolbar button) to manage every companion across all chats, create new ones, import from file, pick from bundled templates, enable/disable with one tap, and convert eligible inline agents to companion execution.
- One-click conversion flips agents between inline and companion execution from agent cards and a bulk select-mode action, preserving prompt, regex scripts, injection, and conditions.
- Trackers converted to companion execution get an automatic loop by default (run after every reply, raw prompt sent verbatim, latest state fed back into the next generation, state shown in the slide-out panel instead of chat cards), with a one-time migration applying the same defaults to already-converted trackers.
- Companions are configurable per companion: trigger, display mode, output format (markdown/HTML/plain text), context window depth, token thresholds and limits, which context to feed (character card, persona, world info, author's note, system prompt, prior notes), self-feedback depth, raw prompt mode, shared-request batching, and per-companion model, temperature, and reasoning settings. Companions can run in parallel or sequentially.
- The batch companion selector lists every enabled companion so you can run any combination on demand.
- Ships 11 ready-to-use companions: Continuity Companion, Relationship Lens, Director's Commentary, Actor Interview, Lorebook Scout, Memory Shard, NPC Motivator, Plot Compass, Chatroom, Message Inbox, and Chat Only.
- Companions tied to a specific chat are removed automatically when that chat is deleted.
- Added an In-Chat Agent expression classifier that drives Quick Image Gen sprite generation, so agents can pick a character expression and generate a matching sprite.
- Added a Fix Trackers button that re-runs tracker agents to rebuild tracker state, with repair controls that stay visible for every enabled tracker, including legacy and pre trackers.
- Sampling settings can now be decoupled from chat completion presets so model sampling profiles load on their own.
- Added a quick delete shortcut button to the message actions.
- Added categorized settings tabs that wrap into a grid on desktop.
- Added more shell styles and reduced option padding in Customize.
- Added a hide toggle and a direct hide button for the bottom chat bar.
- Added ADHDBunny-UI to the Launchpad optional installs.

### Improved
- Prose Polisher maximum output tokens raised to 32000.
- Synced the bundled Quick Image Gen extension to v2.1.0.
- World info entry controls are now more compact.
- Extension load diagnostics give clearer detail when an extension fails to load.
- Mobile rail and quick-action model selection now route through the mobile-shell-lifecycle module for steadier narrow-screen behavior.

### Fixed
- Chat backup count is now capped to 25 by default (`backups.chat.maxTotalBackups`) instead of unlimited, preventing unbounded accumulation over time.
- Pre-write chat backups now skip writing when the on-disk content is unchanged (duplicate detection), reducing redundant snapshots during rapid save flows like swiping.
- SillyBunny to SillyTavern version mapping is corrected so extensions check compatibility against the right version.
- sillybunny-theme media queries now align to the 768px breakpoint instead of 760px.
- iOS WebKit boot failures are now surfaced instead of failing silently, with hardened frontend boot recovery.
- Clear cookies and cache now works on iOS WebKit.
- iOS chat overscroll blanking and keyboard composer displacement are fixed.
- Public JS revalidation caching is restored.
- script.js now loads under its bare URL to restore a single module identity, and is no longer double-evaluated through versioned module URLs.
- Generated install metadata is restored before updates run.
- Frontend restart now works on Windows through a unified graceful shutdown, server.js is self-supervising so restart works everywhere, and shutdown exit codes stay numeric.
- Windows write fallback is hardened, and direct writes are avoided after Windows temp rename failures.
- Character saves are protected from a stale frontend, pending character saves are canceled when switching characters, and the editor form no longer resets when selecting a character.
- Stale CSRF tokens are refreshed, and group chat loads retry after a CSRF refresh.
- OpenAI preset selection is preserved on backend switch, and the user backend is preserved on settings load instead of switching to the reverse proxy source.
- Stale settings overwrites are now prevented.
- Agent enable/disable toggle now responds on mobile.
- Stuck mobile message updates are force-flushed, and a deferred mobile repaint is awaited before MESSAGE_UPDATED.
- Mobile keyboard no longer hides the composer.
- MovingUI panels are stabilized on desktop.
- Save and Clear profile buttons no longer squish, and the sampling profile button keeps its text width.
- Mobile cache utility layout is fixed.
- Top-bar drawer hiding is scoped to native drawers, and extensions can hook the Characters top-bar button, for better extension compatibility.
- Guided Generations now honors impersonation perspective prompts.
- The constant "Model sampling profile loaded" toast is removed.

### Removed
- No user-facing features were removed in this release.

### Merged Staging PRs
- PR #402 (2026-06-10) `chore: bump version to 1.6.5`
- PR #404 (2026-06-10) `chore: route mobile rail and quick-action models through mobile-shell-lifecycle`
- PR #407 (2026-06-10) `docs: ledger the mobile-styles media gate and canonical breakpoints`
- PR #408 (2026-06-11) `fix: align sillybunny-theme 760px queries to the 768px breakpoint`
- PR #410 (2026-06-10) `fix: correct SillyBunny→SillyTavern version mapping for extension compatibility`
- PR #411 (2026-06-11) `fix: cap chat backups and deduplicate pre-write snapshots`
- PR #413 (2026-06-11) `fix: surface iOS WebKit boot failures`
- PR #414 (2026-06-11) `fix: unify graceful shutdown so frontend restart works on Windows`
- PR #415 (2026-06-11) `fix: increase Prose Polisher max tokens to 32000`
- PR #416 (2026-06-11) `fix: restore public JS revalidation caching`
- PR #417 (2026-06-11) `fix: restore generated install metadata before updates`
- PR #418 (2026-06-11) `fix: harden frontend boot recovery`
- PR #419 (2026-06-11) `fix: keep shutdown exit codes numeric`
- PR #420 (2026-06-11) `fix: protect character saves from stale frontend`
- PR #422 (2026-06-11) `fix: improve extension load diagnostics`
- PR #425 (2026-06-11) `fix: cancel pending character save when switching characters (#423)`
- PR #426 (2026-06-11) `fix: avoid resetting editor form when selecting character (#423)`
- PR #427 (2026-06-11) `fix: load script.js under its bare URL to restore single module identity`
- PR #428 (2026-06-11) `fix: make server.js self-supervising so restart works everywhere (#412)`
- PR #429 (2026-06-11) `fix: stop double-evaluating script.js via versioned module URLs (#424)`
- PR #430 (2026-06-11) `chore(tests): pin @playwright/test to 1.60.0 for chromium 1223`
- PR #431 (2026-06-11) `chore: layer fork stylesheets and consolidate top-bar mobile rules`
- PR #432 (2026-06-11) `chore: sync Quick Image Gen v2.1.0`
- PR #433 (2026-06-11) `chore: consolidate composer and bottom-bar mobile styles`
- PR #434 (2026-06-11) `chore: consolidate drawer and overlay mobile styles`
- PR #435 (2026-06-11) `chore: tighten phase 2 mobile css ratchets`
- PR #436 (2026-06-12) `fix: agent enable/disable toggle not responding on mobile`
- PR #437 (2026-06-12) `fix: scope top-bar drawer hiding to native drawers for extension compatibility`
- PR #438 (2026-06-12) `fix(mobile): prevent iOS chat overscroll blanking and keyboard composer displacement`
- PR #439 (2026-06-12) `fix: allow extensions to hook the Characters top-bar button`
- PR #440 (2026-06-12) `feat(ica): add Fix Trackers button to re-run tracker agents`
- PR #441 (2026-06-12) `fix(ica): make Fix Trackers button visible for all enabled trackers`
- PR #442 (2026-06-12) `fix(ica): show tracker fix controls after render`
- PR #443 (2026-06-12) `fix(ica): keep tracker fix button discoverable`
- PR #444 (2026-06-12) `fix(ica): recognize legacy tracker agents`
- PR #445 (2026-06-12) `fix(ica): include pre trackers in repair controls`
- PR #446 (2026-06-14) `feat: companion agents — sidecar-style auxiliary AI cards`
- PR #455 (2026-06-12) `fix(guided-generations): honor impersonation perspective prompts`
- PR #465 (2026-06-14) `fix: clear cookies and cache now works on iOS WebKit`
- PR #466 (2026-06-14) `fix(chat): await deferred mobile repaint before MESSAGE_UPDATED`
- PR #467 (2026-06-14) `fix: compact world info entry controls`
- PR #468 (2026-06-14) `feat(expressions): add In-Chat Agent classifier with Quick Image Gen sprite generation`
- PR #469 (2026-06-14) `feat(ica): show all enabled companions in batch selector`
- PR #470 (2026-06-14) `feat: decouple sampling settings from chat completion presets`
- PR #474 (2026-06-15) `fix: harden Windows write fallback`
- PR #475 (2026-06-15) `fix: refresh stale CSRF tokens`
- PR #476 (2026-06-15) `fix: retry group chat loads after CSRF refresh`
- PR #477 (2026-06-15) `fix(chat): force flush stuck mobile message updates`
- PR #478 (2026-06-15) `fix: avoid direct writes after Windows temp rename failures`
- PR #479 (2026-06-15) `fix: preserve OpenAI preset selection on backend switch`
- PR #480 (2026-06-15) `fix: mobile keyboard hides composer`
- PR #481 (2026-06-15) `fix: stabilize MovingUI panels on desktop`
- PR #482 (2026-06-15) `fix: prevent Save/Clear profile buttons from squishing`
- PR #483 (2026-06-15) `feat: prevent stale settings overwrites`
- PR #484 (2026-06-15) `fix(ui): preserve sampling profile button text width`
- PR #485 (2026-06-15) `feat: Add quick delete shortcut button to message actions`
- PR #486 (2026-06-15) `feat: Add categorized settings tabs with desktop grid wrapping`
- PR #487 (2026-06-15) `fix: preserve user backend on settings load instead of switching to reverse proxy source`
- PR #488 (2026-06-15) `fix(ui): fix mobile cache utility layout`
- PR #489 (2026-06-15) `feat: UI Improvement: Add more Shell Styles and reduce option padding`
- PR #490 (2026-06-15) `docs(readme): refresh screenshots for 1.6.5`
- PR #491 (2026-06-15) `fix: remove constant "Model sampling profile loaded" toast`
- PR #492 (2026-06-15) `feat: Add hide toggle option and direct hide button for bottom chat bar`
- PR #493 (2026-06-15) `chore: add docker instructions to contributing guide`
- PR #494 (2026-06-15) `chore: Add ADHDBunny-UI to Launchpad optional installs`

## v1.6.4

Date: 2026-06-10

This update adds a built-in ZIP auto-updater for non-Git installs, token estimates in the chat selector, serialized chat saves, and a round of mobile, chat-backup, and generation-life-cycle fixes on top of 1.6.3.

### Added
- Built-in ZIP auto-update lets non-Git installs check for and apply new SillyBunny releases directly from Customize > Server.
- The chat selector now shows an approximate token count for each saved chat so you can see chat sizes at a glance before switching.

### Improved
- Top bar height, message padding, and mobile chat density were tightened for a cleaner layout on phones and desktops.
- Mobile shell overlay exclusivity, drawer bounds, and viewport sync were consolidated into the mobile-shell-lifecycle module for steadier narrow-screen behavior.
- Settings tab now uses a distinct icon for easier recognition in the navigation shell.
- Optional backup diagnostic logging (`backups.chat.logging`) can trace chat and settings backup writes, skips, and autosave triggers while investigating backup frequency.

### Fixed
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

### Removed
- No user-facing features were removed in this release.

### Merged Staging PRs
- PR #366 (2026-06-07) `chore: prepare v1.6.4`
- PR #371 (2026-06-08) `fix: restore iOS mobile main screen layout`
- PR #372 (2026-06-08) `fix(mobile): guard preset dropdown scroll taps`
- PR #374 (2026-06-09) `fix: reduce chat backup bloat`
- PR #375 (2026-06-09) `fix: clarify Windows ZIP update guidance`
- PR #376 (2026-06-09) `fix: compact agent snapshots and defer interim backups`
- PR #378 (2026-06-09) `fix: revalidate default frontend assets on iOS`
- PR #379 (2026-06-09) `feat: in-app ZIP auto-update for non-git installs`
- PR #380 (2026-06-09) `fix: refresh stale iOS service worker cache`
- PR #381 (2026-06-09) `fix: remove floating edit indicator pill from message edit UI`
- PR #382 (2026-06-09) `feat: show approximate token estimate in chat selector`
- PR #383 (2026-06-09) `fix: respect reverse proxies for agent profile requests`
- PR #384 (2026-06-09) `chore: narrow top bar height and reduce message text padding`
- PR #385 (2026-06-09) `fix: abort agent generation requests on cancel`
- PR #387 (2026-06-09) `fix: create new group chat branches reliably`
- PR #388 (2026-06-09) `fix: release generation lock when aborting generation`
- PR #389 (2026-06-09) `chore: tighten mobile chat density for phone layout`
- PR #391 (2026-06-09) `fix: mobile character panel close button floating above header`
- PR #392 (2026-06-09) `test: add mobile shell smoke pack and mobile css ratchet budgets`
- PR #393 (2026-06-09) `fix: normalize legacy World Info positions at scan time`
- PR #394 (2026-06-10) `fix: preserve new group chat id during validation`
- PR #395 (2026-06-10) `fix(mobile): strengthen preset select touch guard`
- PR #396 (2026-06-10) `chore: route mobile drawer bounds through mobile-shell-lifecycle`
- PR #397 (2026-06-10) `chore: route mobile viewport sync plan through mobile-shell-lifecycle`
- PR #398 (2026-06-10) `fix: strip hidden content from closed details in screenshots`
- PR #399 (2026-06-10) `chore: centralize mobile overlay exclusivity in mobile-shell-lifecycle`
- PR #400 (2026-06-10) `chore: use distinct icon for Settings tab`
- PR #401 (2026-06-10) `fix: clip root overflow so search jumps can't shift the fixed viewport`

## v1.6.3

Date: 2026-06-07

This update focuses on safer chat switching and cloning, steadier mobile and persona controls, clearer runtime launchers, theme-aware UI polish, and tighter in-chat agent behavior for the 1.6 line.

### Improved
- Runtime launcher documentation and scripts now make automatic, Node.js, Bun, macOS, Linux, Windows, and Termux startup paths explicit.
- Mobile search, persona controls, alternate greetings, top-bar shortcuts, message actions, and shell spacing were polished to stay stable on narrow screens.
- Theme surfaces now respect toast colors and core message-block transparency without depending on Moonlit Echoes.
- In-chat agent refresh behavior, generation controls, and tool-call recursion cap handling are more predictable during active generations.
- Prompt logging and release changelog automation were tightened so verbose payloads and merged staging history are easier to audit.

### Fixed
- Verbose prompt payload logging now stays gated behind the prompt log preference.
- Chat cloning, pending swipe saves, and integrity-token rotation now avoid stale writes, cross-device history loss, and chat-switch races.
- Persona Scenario Notes selection, mobile alternate greeting controls, persona action spacing, and persona icon alignment now persist and render per character card.
- In-chat agent generation keeps the stop button and message actions visible while ignoring unrelated generation event payloads during UI refresh.
- Search close handling stabilizes the mobile viewport and auto-focuses search input without pulling the page out of position.
- Impersonation keeps first-person behavior on chat-completion backends.
- Top-bar character shortcut buttons now toggle closed instead of staying open.

### Added
- Runtime-specific launchers for forcing Bun or Node.js across Windows, macOS, Linux/WSL, and Termux.
- Runtime wiring for the tool-call recursion limit slider.
- Helper prefill role controls for Guided Generations and In-Chat Agents.
- Regression coverage for chat cloning, swipe saves, persona notes, integrity tokens, mobile controls, agent generation, transparency, theme-aware toasts, and launcher/changelog sync behavior.

### Removed
- No user-facing features were removed in this release.

### Merged Staging PRs
- PR #346 (2026-06-04) `chore: fix PR checks and changelog sync`
- PR #348 (2026-06-05) `fix: gate verbose prompt payload logging`
- PR #349 (2026-06-05) `fix: prevent chat cloning races`
- PR #350 (2026-06-05) `fix: preserve pending swipe saves before chat switches`
- PR #352 (2026-06-05) `fix: isolate mobile alternate greeting controls`
- PR #353 (2026-06-05) `fix: persist persona Scenario Notes selection per character card`
- PR #354 (2026-06-06) `fix: rotate chat integrity token on save to prevent cross-device history loss`
- PR #355 (2026-06-07) `fix: wire tool call recursion limit slider to runtime cap`
- PR #356 (2026-06-06) `fix: show stop button during in-chat agent generation`
- PR #357 (2026-06-06) `fix: paint message-block transparency in core without Moonlit Echoes`
- PR #358 (2026-06-06) `fix: stabilize mobile viewport on search close and auto-focus search input`
- PR #359 (2026-06-06) `fix: keep impersonate first-person on chat-completion backends`
- PR #360 (2026-06-06) `fix: ignore generation event payloads in agent UI refresh`
- PR #361 (2026-06-07) `fix: correct mobile persona action spacing`
- PR #362 (2026-06-07) `fix: make toast colors theme-aware`
- PR #363 (2026-06-07) `fix: align persona icon actions and alt greetings`
- PR #364 (2026-06-07) `fix: keep message actions visible during agent generation`
- PR #365 (2026-06-07) `fix: toggle top-bar character shortcuts closed`

## v1.6.2

Date: 2026-06-03

This update tightens Bun/client-disconnect cancellation, mobile navigation scaling, mobile API/model selection, reasoning token accounting, and Server Admin branch reporting for the 1.6 line.

### Fixed
- Bun-safe request cancellation now aborts upstream generation, image, and provider requests when the request, response, or socket disconnects without reporting expected client disconnects as provider failures.
- Streaming disconnect cleanup now treats Bun raw abort reasons as expected cancellation, keeping provider logs quieter after users stop or leave a stream.
- Thought and reasoning token totals now use the higher of provider-reported reasoning tokens and locally counted reasoning text so counts are no longer underreported.
- Server Admin now shows the tracked remote branch when Git reports an empty branch, `HEAD`, or a runtime branch prefix.
- Startup and Server Admin updates now restore a lone generated `bun.lock` diff before checking Git cleanliness, so deleting or locally refreshing the lockfile no longer blocks auto-update.
- Mobile shell rail buttons now scale down correctly with the Mobile Button Size slider instead of staying pinned to hardcoded rail dimensions.

### Added
- A reusable request-cancellation observer, verification script, and regression tests for request, response, and socket disconnect paths.
- Mobile-friendly inline and native picker controls for OpenRouter models, sorts, providers, quantizations, middle-out behavior, and searchable model ID rows on touch or narrow screens.
- Regression coverage for request cancellation, mobile shell button scaling, reasoning token accounting, and Server Admin branch fallback behavior.

### Removed
- No user-facing features were removed in this release.

### Improved
- Touch and narrow-screen API/model dropdowns now avoid Select2 keyboard traps by preferring inline or native picker behavior where appropriate.
- Character drawer routing, header copy, empty editor copy, and import intro text are clearer and more resilient across mobile and desktop panel layouts.
- Mobile and desktop navigation defaults return to a labeled horizontal layout, while vertical icon-only navigation remains opt-in.
- Side rails can derive shortcuts from all registered Workspace and Customize tabs when rail shortcuts are enabled.
- Shell cache keys and release metadata were refreshed for the 1.6.2 assets.

### Merged Staging PRs
- PR #313 (2026-06-02) `fix: Bun request cancellation propagation`
- PR #314 (2026-06-02) `fix: harden streaming disconnect cancellation`
- PR #316 (2026-06-03) `fix: scale mobile shell buttons with Mobile Button Size slider`
- PR #317 (2026-06-03) `fix: correct underreported thought token counts`
- PR #318 (2026-06-03) `fix: show tracked branch when local branch is unresolved`
- PR #319 (2026-06-03) `chore: release v1.6.2`

### Local Staging Commits
- 1f828ed (2026-06-03) `fix: polish menu layout and mobile dropdowns`

### Release Metadata
- Updated app, Horde client, bundled extension, package, lockfile, README mirror, release notes, Discord summary, and test metadata to 1.6.2.

## v1.6.1

Date: 2026-06-02

This update keeps the 1.6 series moving with safer chat lifecycle defaults, stronger preset/profile persistence, more reliable Quick Replies, and cleaner release notes.

### Release Metadata
- Updated app, Horde client, bundled extension, package, lockfile, and test metadata to 1.6.1.

### In-Chat Agents
- Updated bundled tracker agent templates with Pura's Director Preset 13.3 wording and bumped affected tracker templates to v2 so installed agents can be manually updated from the version pill.
- Added a script to detect changed bundled agent template content and bump matching template versions across individual template files and the bundled index.

### Merged Staging PRs
- PR #155 (2026-05-24) `fix: chat scroll and prompt manager scroll position issues`
- PR #156 (2026-05-22) `fix: improve mobile group and editor spacing`
- PR #157 (2026-05-22) `chore: remove redundant fork update launcher`
- PR #158 (2026-05-24) `feat: add mobile navigation customization`
- PR #159 (2026-05-24) `fix: Make message generation glow theme-aware`
- PR #160 (2026-05-23) `fix: avoid duplicate text completion close handlers`
- PR #161 (2026-05-25) `fix: surface moving ui reset for offscreen panels`
- PR #162 (2026-05-25) `fix: normalize character book positions`
- PR #163 (2026-05-26) `fix: isolate local prompt cache lanes`
- PR #165 (2026-05-26) `fix: abort generation on client disconnect`
- PR #191 (2026-05-26) `Fix local generation aborts after stop`
- PR #192 (2026-05-27) `fix: restore LCPP status after refresh`
- PR #193 (2026-05-27) `fix: keep quick reply bar after startup`
- PR #194 (2026-05-27) `Fix imported character auto-selection`
- PR #195 (2026-05-27) `fix: respect OpenAI preset link mode`
- PR #196 (2026-05-27) `Fix iOS group candidate row selection`
- PR #197 (2026-05-27) `fix: prevent text completion reasoning leaks in agents`
- PR #198 (2026-05-27) `fix: cover Guided Generations steering commands`
- PR #199 (2026-05-27) `fix: support oklch message screenshots`
- PR #200 (2026-05-27) `Fix Prose Polisher for guided impersonate`
- PR #201 (2026-05-27) `refactor: chat scroll anchor lifecycle`
- PR #203 (2026-05-27) `refactor: add chat render scroll intent resolver`
- PR #204 (2026-05-27) `fix: keep input history menu above composer`
- PR #205 (2026-05-28) `refactor: add chat render lifecycle index seam`
- PR #206 (2026-05-28) `chore: add chat lifecycle rollout guard`
- PR #207 (2026-05-27) `fix: stop disabled extensions injecting prompts`
- PR #208 (2026-05-28) `refactor: route chat bottom scroll through lifecycle`
- PR #211 (2026-05-29) `Refactor redisplay chat batching through lifecycle`
- PR #212 (2026-05-29) `Refactor show-more batching through lifecycle`
- PR #213 (2026-05-29) `Refactor chat lifecycle update queue helper`
- PR #214 (2026-05-29) `Refactor chat lifecycle message update route`
- PR #215 (2026-05-29) `Refactor mobile message updates through lifecycle queue`
- PR #216 (2026-05-29) `Refactor chat lifecycle stream buffer helper`
- PR #217 (2026-05-29) `Refactor streaming start scroll through lifecycle`
- PR #218 (2026-05-29) `Refactor streaming progress writes through lifecycle`
- PR #219 (2026-05-29) `Test replace-message anchor positions`
- PR #220 (2026-05-29) `Route swipe replacement through lifecycle`
- PR #221 (2026-05-29) `Add lifecycle resize observer helper`
- PR #227 (2026-05-29) `Refactor chat lifecycle media resize route`
- PR #228 (2026-05-29) `Fix Guided Generations GGSystemPrompt cleanup`
- PR #229 (2026-05-29) `Refactor chat lifecycle mobile viewport helper`
- PR #230 (2026-05-29) `Refactor chat lifecycle mobile viewport route`
- PR #231 (2026-05-29) `test: add chat render performance baseline`
- PR #232 (2026-05-29) `Refactor chat lifecycle route rollout defaults`
- PR #233 (2026-05-29) `Refactor chat lifecycle bottom scroll default on`
- PR #234 (2026-05-29) `Refactor chat lifecycle initial load default on`
- PR #235 (2026-05-29) `Refactor chat lifecycle redisplay batch default on`
- PR #236 (2026-05-29) `Refactor chat lifecycle show more default on`
- PR #237 (2026-05-29) `Refactor chat lifecycle message update default on`
- PR #238 (2026-05-29) `Refactor chat lifecycle streaming start default on`
- PR #239 (2026-05-29) `Refactor chat lifecycle streaming progress default on`
- PR #240 (2026-05-29) `Refactor chat lifecycle replace message default on`
- PR #241 (2026-05-29) `Refactor chat lifecycle media resize default on`
- PR #242 (2026-05-29) `Refactor chat lifecycle mobile viewport default on`
- PR #243 (2026-05-29) `Refactor mobile shell lifecycle helper`
- PR #244 (2026-05-29) `Refactor mobile shell lifecycle wiring`
- PR #245 (2026-05-29) `Refactor preset API sync lifecycle helper`
- PR #246 (2026-05-29) `Refactor preset API sync lifecycle wiring`
- PR #247 (2026-05-29) `Refactor generation lifecycle helper`
- PR #248 (2026-05-29) `Refactor generation lifecycle wiring`
- PR #249 (2026-05-29) `Refactor extension boot lifecycle helper`
- PR #250 (2026-05-29) `Refactor extension boot lifecycle wiring`
- PR #251 (2026-05-29) `Refactor prompt manager lifecycle helper`
- PR #252 (2026-05-29) `Refactor prompt manager lifecycle wiring`
- PR #253 (2026-05-29) `Refactor tooling UI hydration helper`
- PR #254 (2026-05-29) `Refactor tooling UI hydration wiring`
- PR #255 (2026-05-29) `Fix bulk preset deletion tooltip copy`
- PR #256 (2026-05-29) `Add compact Pathfinder mode selector`
- PR #257 (2026-05-29) `Add Quick Action icon picker`
- PR #258 (2026-05-29) `Fix character lorebook focus routing`
- PR #259 (2026-05-29) `Fix first-launch topbar scale default`
- PR #260 (2026-05-29) `Style boolean radio choices as segmented toggles`
- PR #261 (2026-05-29) `Fix Workspace Select2 dropdown geometry`
- PR #262 (2026-05-29) `Fix Quick Image Gen collapsed drawer layout`
- PR #263 (2026-05-29) `Add Pathfinder submodule toggle`
- PR #264 (2026-05-29) `Stabilize mobile sampler range rows`
- PR #265 (2026-05-29) `Add current chat files access`
- PR #266 (2026-05-29) `Add vertical chat layout setting`
- PR #267 (2026-05-29) `Preserve Prompt Manager scroll after save`
- PR #268 (2026-05-29) `Show source prompt token counts before generation`
- PR #269 (2026-05-29) `fix: encode Google Font family spaces correctly`
- PR #270 (2026-05-29) `fix: make mobile quick action icons tappable`
- PR #271 (2026-05-29) `fix: stabilize chat scrolling`
- PR #272 (2026-05-29) `Fix post agents after provider errors`
- PR #273 (2026-05-29) `Fix chat vectorization toggle persistence`
- PR #274 (2026-05-29) `Bind reverse proxy presets to source`
- PR #275 (2026-05-29) `Fix iOS streaming scroll jitter`
- PR #276 (2026-05-29) `Fix in-chat agent regex refresh`
- PR #278 (2026-05-29) `fix: stabilize streaming resize scroll pins`
- PR #279 (2026-05-29) `feat: add desktop vertical navigation settings`
- PR #280 (2026-05-31) `fix: chat shell wheel routing`
- PR #281 (2026-05-31) `feat: add post-main in-chat agent intercept timing`
- PR #283 (2026-06-02) `fix: persist presets immediately in connection profiles`
- PR #285 (2026-06-02) `feat: add explicit UI for reverse proxy backend binding`
- PR #286 (2026-05-31) `chore: Bump version numbers from 1.6.0 to 1.6.1`
- PR #287 (2026-06-02) `fix: improve server plugin dependency diagnostics`
- PR #288 (2026-05-31) `chore: update Pura director preset and tracker templates`
- PR #289 (2026-06-02) `fix: reset prompt order from selected preset`
- PR #290 (2026-06-02) `fix: make shell resize handles more visible`
- PR #291 (2026-06-02) `fix: preserve desktop prompt manager scroll`
- PR #292 (2026-05-31) `fix: prevent duplicate agent runner initialization`
- PR #293 (2026-05-31) `chore: update Pura Director Preset agents to v2`
- PR #294 (2026-06-02) `feat(tts): add OpenAI audio format selection`
- PR #295 (2026-06-02) `fix: bound rendered chat messages`
- PR #296 (2026-06-02) `chore: align PR checks with SillyBunny`
- PR #297 (2026-06-02) `fix: fetch current chat completion models`
- PR #298 (2026-06-02) `fix: refresh edited character avatars`
- PR #299 (2026-06-02) `fix: align desktop shell tabs with navigation preferences`
- PR #300 (2026-06-02) `fix: align native chat style headers`
- PR #301 (2026-06-02) `fix: improve Pathfinder swipe reuse and settings UI`
- PR #302 (2026-06-02) `fix: harden Select2 dropdown surfaces`
- PR #303 (2026-06-02) `fix: prevent corrupted wand message screenshots`
- PR #304 (2026-06-02) `fix: switch backend for bound reverse proxy presets`
- PR #305 (2026-06-02) `chore: remove stale semantic map artifacts`
- PR #306 (2026-06-02) `fix: close release readiness regressions`
- PR #307 (2026-06-02) `fix: avoid forced reconnect when loading bound reverse proxy presets`
- PR #308 (2026-06-02) `fix: restore desktop lorebook selection surfaces`
- PR #309 (2026-06-02) `fix: close release polish regressions`
- PR #310 (2026-06-02) `fix: sync reverse proxy preset when chat completion source changes`
- PR #311 (2026-06-02) `chore: sync Quick Image Gen v2.0.10`
- PR #312 (2026-06-02) `fix: close release readiness blockers`
## v1.6.0

Date: 2026-05-18

This update consolidates the v1.6.0 staging work since v1.5.3: preset and connection profile save reliability, full-chat navigation and search, mobile bottom-bar and drawer polish, chat completion tabs, pre-generation agent interceptors, iOS streaming stabilization, context-depth controls, character-menu rework, runtime update hardening, and release documentation automation.

### Character Cards
- fix(cards): warn when card HTML contains stripped `<script>`/`<iframe>` blocks (#94).
- feat(cards): add opt-in sandboxed execution for supported card scripts (#94).

### Presets And Connection Profiles
- Connection profile changes now serialize in order, abort superseded applications cleanly, save only after the latest selected profile finishes applying, and expose expanded summaries for easier review.
- OpenAI preset changes now expose an awaitable completion path and ignore stale async preset applications, keeping linked provider and model settings from being overwritten by older selections.
- Preset slash-command and welcome flows now wait for the active preset manager to finish applying supported preset changes before continuing.
- Connection profile create, update, delete, reload, and profile slash commands now flush settings immediately so rapid preset/API swaps persist reliably, including OpenRouter quantizations on profile requests.
- Preset saves now confirm before overwriting saved prompt text, and unsaved preset text edits warn before they are discarded.
- OpenAI preset saves and imports now carry `bias_presets`, so selected logit bias libraries and their editable entries persist with the preset instead of snapping back to the base file.

### Chat Loading And Search
- Re-applied chat scroll anchoring across staging and main so scrolling upward no longer skips earlier messages.
- Disabled native chat scroll anchoring on macOS browsers so it no longer fights SillyBunny's scroll preservation while users scroll through older messages.
- Existing chats now force-scroll to the latest message on initial load across desktop and mobile, while streaming and other non-forced chat scrolling still respect auto-scroll preferences and mobile manual-scroll suppression.
- Bottom chat navigation now includes go-to-top and go-to-bottom controls for the active chat.
- Bottom-bar chat search stays synchronized with desktop and mobile chat search controls, searches the full chat data including hidden or not-yet-rendered messages, and reports whether matches are visible, hidden, data-only, or absent.
- Mobile chat scrolling stays anchored while loading older messages or dragging SillyBunny shell tabs, with tab scrolling constrained horizontally to avoid page jumps.

### Mobile Shell, Bottom Bar, And Streaming
- Added a mobile-only collapse button that hides or restores the second-row chat actions, preserves 44px touch targets, and remembers the collapsed state across reloads.
- Moved bottom chat search behind a second-row search icon so the full search field only expands when requested, then placed that search icon directly before the trash action in the expanded row.
- Kept the mobile chat dropdown on the left with up/down controls beside it while the single collapse control hides the additional actions row.
- Fixed the mobile bottom chat bar breakpoint and first-row grid sizing so controls no longer overlap on wider phone and tablet layouts, while the desktop bar stays unchanged and mobile persona, chat select, action, and search controls stay symmetrical.
- Centered the visible mobile action row when it is shown.
- Polished shell menu focus, mobile controls, mobile prompt editor layout, advanced formatting mobile headers, and mobile navigation accessibility.
- Restored mobile composer auto-grow behavior and release mobile inputs correctly after closing the character drawer.
- Reduced iOS streaming pressure, aligned smooth-streaming checks, unblocked cancelled streams, and added stability toggles for narrow mobile streaming surfaces.

### Chat Completion Tabs
- Added the default Chat Completion Tabs extension for provider-specific chat completion controls.
- Added the default Prompt Inspector extension for inspecting and editing chat completion and text completion prompts before they are sent.
- Preserved tab content and scroll positions while switching, disabling, or scrolling through chat completion tabs.
- Omitted disabled `top_k` controls and sampler-owned chat completion controls from places where they should not be saved or shown.
- Honored connection profile secret IDs for custom chat completions so profile-backed secrets remain linked correctly.

### In-Chat Agents And Context Tools
- Added pre-generation agent interceptors with mutation preservation, validation hardening, and visible intercept history.
- Polished in-chat agent rewrite metadata so generated rewrites are easier to inspect and track.
- Added OOC and HTML context-depth controls, then normalized the related context-depth settings.
- Added Guided Correction to Guided Generations and a Prompt Manager preview for inspecting prompt output before use.
- Refreshed the Memory Sharding quick reply with dedupe and force-update handling, then normalized icon picker search behavior.

### Message Actions And Sampling Controls
- Hid disabled extension message actions instead of leaving unavailable controls visible.
- Hid Claude sampler omission toggles when they are not active for the selected backend path.
- Added `xhigh` reasoning effort and renamed the `auto` reasoning effort label to blank.
- Kept sampling cleanup scoped to the controls it owns.

### Character Menu And Drawer
- Reworked the character menu, compacted mobile character drawer chrome, and rotated the related service-worker, shell, and static asset cache keys so iOS WebKit clients load the updated drawer instead of stale cached files.
- Restored horizontal scrolling in the mobile character tab strip so more of the character list is visible immediately on phones.
- Centered the desktop Characters drawer section tabs while preserving the mobile horizontal-scroll layout and touch behavior.

### Character Editor
- Character alternate greetings now save from the live editor contents, so edited greetings persist instead of falling back to stale array state.

### Bundled Extensions, Templates, And Styles
- Baked workflow extensions into the core bundle and treated Bunny Preset Tools as a bundled extension.
- Bundled Echo, Whisper, Hush, Ripple, and Tide chat styles natively.
- Improved Pathfinder settings and retrieval before retiring the Pathfinder agent from the categorized templates browser.
- Removed Prompt Inspector and Chat Completion Tabs from Launchpad after bundling them natively.

### Runtime, Updates, And Docs
- Bun launchers now retry dependency installs without `--frozen-lockfile` if the locked install fails, so users no longer need to delete `bun.lock` after an update.
- Clean Git checkouts restore the tracked `bun.lock` after a local Bun lockfile refresh so future launcher self-updates are not blocked by a dirty lockfile.
- Server admin status, update, and branch handling now supports linked Git worktrees and stable branch tracking for runtime worktrees.
- Docker startup regressions were fixed, and Webpack now aliases Chevrotain to its prebundled ESM file.
- Added the server hygiene lesson, refreshed agent repository notes, and applied documentation polish from staging follow-ups.

### Reverted Before Release
- PR #47, the topbar repository logo experiment, was merged and then reverted before v1.6.0 shipped.
- PR #48, the Claude disable-`top_k` option, was merged and then reverted before v1.6.0 shipped.

### Release Metadata
- The welcome panel now uses the dynamic current-release label instead of a stale hardcoded 1.4.2 eyebrow.
- Updated app, Horde client, bundled extension, package, lockfile, and README metadata to 1.6.0.
- Added a `changelog:merged-prs` script and GitHub workflow so future merged staging PRs are recorded in `changelog.md` automatically.

## v1.5.3

Date: 2026-05-03

This update adds the Black Orange theme and desktop character drawer tiles, improves managed shell coexistence, restores Moving UI control over the character drawer size, and quiets expected Pathfinder sidecar aborts.

### Mobile UI Polish
- Restored chat scroll anchoring so scrolling up no longer skips over batches of earlier messages.
- Lengthened the slim mobile Persona bottom chat bar to match the Image #2 near-full-width footprint while preserving its compact height.
- Slimmed the mobile Persona bottom chat bar so the Bottom Bar Size slider can make it visually thinner while keeping the controls centered in one row.
- Narrowed the mobile Persona bottom chat bar so it no longer spans edge-to-edge on phone and landscape mobile layouts.
- Made the mobile Persona bottom chat bar even narrower, mobile-only, horizontal, and tied the compact width to the existing Bottom Bar Size slider.
- Recentered the Prompt Manager close, undo, and save icon buttons in the prompt editor footer.
- Let the Presets "Independent mode" helper copy wrap inside the mobile panel without being clipped, while keeping its checkbox and label aligned.
- Bumped the affected stylesheet cache keys so the mobile and prompt editor CSS updates are loaded by existing browsers.

### Provider Model Picking
- Added searchable Model ID inputs for Claude, AI21, Cohere, Perplexity, Vertex AI, Custom, and Z.AI providers by filtering each provider's Available Models list as the user types.
- Added favorite buttons for editable provider model IDs, reusing the existing per-provider model favorites store and pinning favorites at the top of the matching provider list.
- Kept typed custom model IDs available even when they are not returned by an API model list.

### Pathfinder
- Pathfinder automatic retrieval now waits for pipeline or sidecar lookup to finish before the main writing prompt is injected, while real cancellation still aborts retrieval.
- Contextual Pathfinder lorebooks now include chat, persona, character card/primary, extra character, and group member lorebooks without requiring manual Pathfinder selection or vectorization.
- Memory Summaries now keep the summary tool toggle off when disabled, accept intervals down to 2 messages, and offer a Create Summary action that writes through the Pathfinder summary lorebook path.
- Diagnostics now refresh tool registrations before checking state, read enabled tools from the active Pathfinder agent, and avoid false all-tools-disabled reports.
- Tightened Pathfinder mobile Pipeline Settings spacing and kept Diagnostics content/action alignment left in the settings panel.
- Duplicate bundled Pathfinder agents are cleaned up while preserving the automatic `tpl-pathfinder` agent.
- Pathfinder summary prompts are injected after retrieval prompt keys so the summary tool request no longer precedes retrieved context.

### In-Chat Agents
- Synced the Achievements Tracker and Scene Tracker template catalog entries with their updated source wording, and made bundled template reset recognize saved bundled agents after prompt wording changes.

### SillyTavern 1.18.0 Compatibility Sync
SillyBunny incorporates the 1.18.0 compatibility updates while preserving the fork's Bun-first runtime and custom shell.

- Kept SillyBunny's Bun-first defaults and port `4444` while updating Node-compatible dependency and lockfile state for the SillyTavern 1.18.0 surface.
- Updated launcher and Electron package files for the new runtime layout.
- Preserved fork defaults and avoided tracked `data/default-user/**` state.
- Added account-version session handling, password/recovery hardening, trusted proxy validation, private request filtering, basic-auth rate limiting, forwarded-header helpers, cache busting, and immutable data-root override support.
- Preserved SillyBunny session auth and HTTPS behavior while adopting compatible upstream hardening.
- Updated OpenRouter, OpenAI, NanoGPT, MiniMax, Workers AI, Kobold/KoboldCpp, NovelAI, Stable Diffusion, tokenizer, speech, vector, and text/chat completion paths.
- Added Workers AI vector UI controls and fixed OpenRouter PKCE browser encoding.
- Adopted required upstream 1.18.0 UI and JavaScript compatibility changes without replacing SillyBunny's shell/navigation structure.
- Added extension lifecycle compatibility, third-party extension warning flow, streaming display utilities, persona slash commands and events, provider settings updates, popup validation, swipe picker updates, and welcome panel templates.
- Kept mobile and desktop parity in scope for newly merged UI controls, especially settings rows, vector controls, and extension flows.
- Brought in or updated unit coverage for private request filtering, prompt converters, Tavern card validation, and utility behavior.
- PR verification before merge reported passing lint, unit tests, diff whitespace checks, and Node/Bun startup smokes.

### Themes And Character Drawer
- Added the Black Orange theme.
- Added desktop character drawer tile styling for the SillyBunny tabs layout.

### Shell And Moving UI
- Opening Customize no longer closes an already-open Workspace or Agents shell, and opening Workspace or Agents no longer closes Customize.
- Moving UI now keeps control of the character drawer position and size instead of being overridden by SillyBunny desktop drawer sizing.
- Disabled the SillyBunny character drawer resize handle while Moving UI is active so the upstream drag/resize controls remain the single source of truth.
- Preserved Launchpad highlighting when the SillyBunny shell reinitializes so Moonlit Echoes and Guided Generations toast actions open the correct Launchpad cards.
- Center-aligned checkbox controls and label text across desktop, mobile, OpenAI/API cards, settings cards, theme toggles, chat delete rows, and Pathfinder prompt settings.
- Aligned Character Author's Note placement controls and Custom API key controls on mobile WebKit.
- Kept the persona chat mass-delete dialog inside iOS safe areas and tightened its narrow-screen controls so the age input and presets remain reachable on mobile Safari.
- Bound the mobile chat mass-delete dialog to iOS WebKit's visual viewport, kept the overlay above app chrome during browser toolbar shifts, constrained scrolling to the dialog list, avoided mobile autofocus jumps, aligned checkbox rows, and rotated the SillyBunny shell cache keys so corrected styles load immediately.
- Made active character and chat lorebook toolbar icons glow with the active accent color so linked lorebooks are easier to spot in the character editor.
- Made Clear cookies & cache expire server-side HttpOnly session cookies as well as browser-visible cookies before reloading.
- Paused streaming autoscroll while iOS WebKit users touch or momentum-scroll the chat so mid-generation updates no longer snap the view away from the scroll position.
- Reduced live reasoning render churn on iOS WebKit so reasoning-heavy DeepSeek and GLM streams no longer overwhelm the browser during generation.
- Kept previous chat loads pinned to the bottom on iOS WebKit even when the chat list tap leaves temporary manual-scroll suppression active.
- Extended chat manual-scroll suppression to all mobile and narrow chat surfaces so Android/Termux and iOS do not fight user scrolling during streaming or history edits.
- Opened previous-message editors with scroll-preserving focus and removed mobile off-screen message containment so chat history stays anchored while editing.

### Settings Panels And Preset Prompts
- Settings panels (Customize, Presets, Workspace, etc.) now narrow alongside the chat when the chat width is reduced, matching standard SillyTavern behaviour.
- Toggling a prompt on or off inside a preset no longer jumps the scroll position back to the top; the panel stays at the user's current scroll position.

### UI Icons And Provider Models
- Replaced the Badge frontend icon with the pixel-art bunny badge shown in the latest reference image.
- Restored the Badge frontend icon to the original bunny artwork inside the peach pixel badge frame so the Shell Style preview no longer shows the distorted hand-drawn version.
- Added a Shell Style option to switch the frontend between the SillyBunny pixel icon and badge icon, including the splash screen, Home panel logo, favicon, and future system avatar messages.
- Aligned the Reverse Proxy preset row, Prompt Manager undo action, and OpenAI model favorite button with their neighboring dropdowns on desktop and mobile layouts.
- Added current OpenAI `gpt-5.5` and `gpt-5.5-pro`, Claude `claude-opus-4-7`, and Z.AI `glm-5.1` / `glm-5v-turbo` model choices to the backend dropdowns.
- Updated related OpenAI, Claude, and Z.AI capability handling so context, reasoning, media inlining, and Claude sampling rules stay in step with the added models.

### Settings And Browser Storage
- Added a dedicated Clear cookies & cache utility action, wired through the cache-busted SillyBunny shell script so stale browser cache does not leave the button inert.

### Pathfinder And Release Metadata
- Suppressed expected `AbortError` stack traces when Pathfinder sidecar generation is cancelled by its retrieval timeout or a closed client connection.
- Kept Pathfinder prompt action buttons from collapsing into icon-only controls by wrapping visible button labels in spans.
- Restored default Pathfinder tool toggles for existing template agents with empty tool definitions and made diagnostics report the last pipeline retrieval result.
- Added `SILLYBUNNY_USE_BUN=1 bash start.sh` as the launcher override for users who want to force Bun on ARM devices.
- Kept iOS WebKit chats pinned to the bottom while regenerated replies and post-generation agent refreshes update the latest message.
- Softened the idle send button glyph so the paper-plane icon no longer reads overly bright across themes.
- Prevented DeepSeek and other web tokenizers from failing when a Bun/ARM runtime exposes an empty server-side `location.href`.
- Updated app, Horde client, bundled extension, and package metadata to 1.5.3.

### Runtime And Upstream Sync
- Aligned the startup init flow with SillyTavern 1.18 by moving the old post-install bootstrap into `src/server-init.js` and wiring launchers plus Docker startup through `bun run init`.
- Kept first-run default public-file synchronization additive so missing bundled files are copied without overwriting existing user files.
- Updated default configuration with upstream keep-alive, forwarded header, trusted proxy, private address whitelist, authentication rate-limit, and cache buster options.
- Added upstream runtime dependencies and npm install guards for safer package installation defaults.
- Pointed OpenAI Responses tests at `default/config.yaml` so they do not depend on mutable local configuration.

### Character Drawer
- Reset character drawer tag grid placement and containment so inline tags stay inside their own character rows without overlapping adjacent entries.
- Made the character drawer X close the panel completely, added a dedicated back-to-list control for edit mode, restored inline tags in mobile grid view, and reduced the mobile header height.
- Restored mobile list-view character tags, hid the edit-only header after returning to the character list, hid the mobile hotswap strip while editing, compacted the mobile editor header, and kept the FAV/ADV controls readable on narrow screens.

### In-Chat Agents
- Updated bundled Achievements Tracker reset defaults to use `[ACH|Title|Rarity|Description of the achievement]`.
- Updated bundled Scene Tracker reset defaults to use `detail: one-line sensory detail to set the current scene`.
- Prevented swipe navigation from re-running already-applied post-generation agents while preserving real new-swipe generation processing.
- Made Cancel Agent requests persist through in-flight manual runs, added a Cancel Agent action directly to running prompt-pass toasts, and prevented cancelled manual outputs from applying after they return.
- Added pre-generation prompt preview actions in the agent editor and eligible agent cards so macro-expanded prompts can be checked before sending.
- Let manual agent runs start independently in Parallel mode instead of queuing them behind other manual runs.
- Restored agent transform badges and undo/redo access after chat refreshes when the active swipe still has saved transform history.
- Deferred post-processing for new assistant messages while an agent is already working so users can keep sending or swiping without the older agent touching the newer message.

### Local Commits
- `fix(pathfinder): wait for retrieval before generation`
- `fix(ui): tighten mobile persona bottom bar`
- `feat(ui): improve mobile preset and model controls`
- `fix(mobile): align settings controls and bun override`
- `fix(mobile): preserve ios chat position during regeneration`
- `fix(tokenizers): stabilize web tokenizer runtime loading`
- `fix(ui): soften idle send icon contrast`
- `fix(mobile): reduce ios reasoning stream churn`
- `fix(mobile): keep previous chats bottom-pinned`
- `fix(mobile): slim persona bottom chat bar`
- `fix(mobile): match persona bar screenshot width`
- `fix(ui): update badge frontend icon`
- `fix(mobile): stabilize chat scrolling while editing history`
- `sync: merge PR 11 runtime init alignment`
- `sync: align runtime init with SillyTavern 1.18`
- `fix: make OpenAI Responses tests use default config`
- `docs(changelog): place PR 11 notes under 1.5.3`
- `9fe08ef chore(sync): align SillyBunny with SillyTavern 1.18 compatibility`
- `7b6db61 sync: adopt direct SillyTavern 1.18 changes`
- `2d9c49e sync: align 1.18 security and runtime hardening`
- `f1f6137 sync: update 1.18 dependency locks`
- `02bc8c3 sync: complete SillyTavern 1.18 migration`
- `431e25c fix: preserve proxy filter startup order`
- `sync: merge PR 13 SillyTavern 1.18.0 compatibility`
- `5ebc574 fix: improve mobile UI accessibility polish (#16)`
- `feat(ui): add frontend icon selector and model updates`

## v1.5.2

Date: 2026-04-30

This update brings Group Utilities into Launchpad, improves Moonlit Echoes and Guided Generations migration paths, restores Pathfinder access to contextual lorebooks, fixes group-chat continuity, and focuses heavily on mobile Safari chat stability.

### Launchpad And Extensions
- Added SB-GroupUtilities to Launchpad optional installs, covering group presence, group greetings, shared group context, and SendAs utilities.
- Made the legacy Moonlit Echoes migration toast persistent until dismissed or opened, with a Show in Launchpad action that highlights the Moonlit Echoes Theme card.
- Added a Guided Generations fork notice that directs existing users to the SillyBunny-compatible fork in Launchpad.
- Updated bundled SillyBunny extension version labels to 1.5.2.

### Pathfinder
- Pathfinder now includes active chat-bound, character, character extra, and persona lorebooks alongside manually selected lorebooks by default.
- Added diagnostics for manual/contextual lorebook counts and registered ToolManager tools, reducing false missing-source and enabled-tool warnings.
- Normalized candidate entry matching and added warnings when candidate JSON does not match loaded lorebook entry names.
- Added unit coverage for contextual Pathfinder lorebook merging and deduplication.

### Group Chats And Agents
- Opening the Characters drawer during a group chat now jumps to the active group edit panel.
- Group Auto Mode now re-applies the saved global toggle when opening or creating group chats, while keeping the default off until the user enables it.
- Group DM history is included for the speaking character when returning to the main group chat without exposing private context to other speakers.
- Deleting a swipe clears pending post-generation recovery state so already-run post-generation agents do not fire again.
- Agent output history popups now use a scrollable desktop layout so long diffs keep Undo and Redo controls in view.

### Chat Naming And Workspace
- Chat auto-naming now allows longer title responses and strips reasoning wrappers before parsing, making the Persona bottom-bar wand more reliable with reasoning models.
- Persona bottom-bar Auto-label Chat now uses structured title output when available and falls back to raw title parsing, preventing false `No message generated` errors.
- Workspace tabs and mobile shortcut options now place API immediately after Presets.
- CYOA Choices bundled regex now removes empty optional choice rows before rendering.

### Mobile Chat Stability
- Added lazy/async loading hints for chat avatars and attached message images.
- Chat rendering now uses smaller mobile batches, ignores duplicate older-history touch/mouse activations, and contains off-screen messages to reduce WebKit layout and memory pressure.
- Mobile message updates now batch regex/HTML post-processing while keeping generation updates immediate.
- Streaming replies now patch formatted DOM in place, restore live formatted updates when stream fade-in is disabled, and reduce repeated swipe metadata cloning.
- Send flows now render user messages before slow handoffs, server ping, or group setup, then hold bottom scroll position to avoid iOS Safari send delays and snap-backs.
- Swipe navigation now anchors relative to the chat bottom and disables browser scroll anchoring on the chat scroller.
- New-message media scrolling now watches only visible media in the latest message and caps waits at 300 ms.

### Shell And Mobile UI
- Fixed group speaker controls overflowing to the right when a typing indicator appears by allowing the desktop control row to wrap cleanly.
- The Bottom Bar Size slider now scales the SillyBunny chatbar and Persona bottom chat controls on mobile instead of only affecting the legacy composer sizing.
- Background Visibility now supports 100%, refreshes upgraded slider metadata, and keeps composer/chatbar surfaces readable at high visibility.
- Header, chatbar, composer, bottom chat surfaces, and Clean Minimal mobile drawer/menu panels now use solid layers in no-blur or high-visibility setups to prevent compositor artifacts.
- Mobile Workspace, navigation, Characters, and Quick Actions drawers now have tighter, more consistent spacing, safer bounds, and solid focused panels while keeping page context visible where intended.
- Characters drawer right-lock alignment now applies immediately on macOS desktop browsers and stays edge-flush on shorter windows without losing drag/resize behavior.
- Mobile Characters drawer layouts now use native shell bounds, safe-area gutters, aligned controls, and square avatars that avoid squeezing on narrow iOS-sized viewports.
- Mobile Top Bar Label option cards are left-aligned so checkbox, title, and helper text read cleanly in one-column settings layouts.
- Rotated the SillyBunny theme, tabs, and service-worker cache keys so browsers pick up the hardened surface styling immediately.

## v1.5.1

Date: 2026-04-29

This update restores Prose Polisher coverage for guided impersonation workflows, makes Advanced Formatting a first-class workspace tab again, adds conservative startup-loading improvements for desktop and mobile, and polishes cross-platform UI alignment, focus, safe-area, and touch-target behavior.

### In-Chat Agents
- Added an opt-in prompt-pass condition for generated impersonation text so Prose Polisher can rewrite Guided Generations impersonations without mutating the previous assistant message.
- Shipped the bundled Prose Polisher template with impersonation polishing enabled, while keeping the new behavior off by default for other prompt-pass agents.
- Added editor UI and migration support for saved bundled Prose Polisher agents, plus unit coverage for both opted-out and opted-in impersonation behavior.

### Workspace And Formatting
- Promoted Advanced Formatting into its own left workspace tab immediately after Sampling.
- Kept the Formatting tab visible across backends instead of hiding the whole Advanced Formatting drawer outside Text Completions.

### Loading
- Deferred ordered classic library scripts, preloaded startup modules, and limited the mobile stylesheet to mobile viewports.
- Added a guarded service worker that stale-while-revalidates static library, CSS, image, and webfont assets while using network-first handling for HTML and JavaScript.

### UI Polish
- Replaced clipped outer focus outlines and oversized active-control shadows with inset rings so focused and highlighted controls stay inside rounded containers.
- Aligned shell headers, character drawer padding, welcome headers, and checkbox labels across desktop and mobile breakpoints.
- Normalized mobile safe-area fallbacks and 44 px tap targets for the composer, bottom chat controls, and welcome recent-chat actions.
- Cleaned up redundant shell borders, trailing recent-chat stat dividers, and duplicated macOS browser chrome patches.
- Left-aligned SillyBunny shell drawer eyebrow labels, titles, subtitles, and descriptions across desktop and mobile.
- Contained shell close-button focus rings inside rounded borders so highlights no longer bleed past the control edge.
- Gave mobile Customize, Navigate, and Characters drawers a rounded native sheet treatment with a slide-up entry, handle pill, side gutters, and safe-area-aware header spacing.
- Stabilized mobile Recent Chats text sizing in WebKit with scoped text-size adjustment, stronger line-clamp bounds, and narrow-screen overflow guards.
- Tightened the mobile composer bottom spacing by removing duplicate safe-area padding and avoiding the forced 34 px fallback under the chat bar.

### Chat Management
- Narrowed the Persona bottom chat bar on mobile with safe-area-aware side gutters while leaving the message composer width unchanged.
- Tightened mobile Persona bottom bar control heights, avatar sizing, icon buttons, gaps, and narrow-phone spacing so the bar no longer dominates the screen.
- Added Persona bottom bar shortcuts for mass deleting chats in the current character/group scope and asking the active LLM to name the current chat.
- Added aligned mass-delete checkboxes, protected the currently open chat, and included 7/30/90/180 day cleanup presets plus a matching `/autonamechat` command.

This patch focuses on persistence and restart fixes for the new agentic and admin workflows introduced around `v1.5.0`.

### Chat And Reasoning
- Persisted collapsed thinking/reasoning block state per message so user-expanded or user-collapsed reasoning blocks survive chat switches and reloads.

### Pathfinder
- Added an independent Pathfinder enable switch in settings so saving books, modes, or prompt settings no longer toggles Pathfinder off unexpectedly.
- Preserved nested Pathfinder settings, including pipeline prompts, custom pipelines, book permissions, and tool confirmations, instead of resetting omitted fields back to defaults.
- Raised Pathfinder pipeline stage output limits from `1024` to `32000` tokens by default and exposed the stage max-token setting in both prompt editors.

### Server Admin
- Fixed frontend Save & Restart and update restarts when launched from the provided Linux, macOS, and Windows launchers so the server relaunches in the same terminal instead of becoming a detached silent process.

### Local Commits
- `1f3c9b3 feat(agents): allow prompt passes on impersonations`
- `c6f8903 feat(shell): promote advanced formatting to workspace tab`
- `887be36 perf(loading): defer startup assets and cache statics`
- `de68413 fix(ui): replace clipped focus outlines with inset focus rings`
- `1434631 fix(ui): align headers drawer padding and shell title`
- `1f1fdd6 fix(ui): align checkbox layouts across breakpoints`
- `88ccda0 fix(mobile): normalize safe areas and tap targets`
- `cf7ea0a fix(ui): clean up borders and browser chrome patches`
- `bef9327 fix(ui): polish sillybunny shell drawers`
- `d92f1cf fix(mobile): stabilize recent chats text sizing`
- `7339d9e fix(mobile): tighten composer bottom spacing`
- `ce14e54 Revert "docs(changelog): note 1.5.1 chat-bar additions"`
- `3cecab4 Revert "feat(chat): add bottom-bar auto-name current chat button"`
- `4f78732 Revert "feat(chat): add bottom-bar mass chat delete with age filter"`
- `1c9bb64 Revert "fix(mobile): narrow bottom chat bar gutters"`
- `eeec412 feat(chat): add persona-bar chat management actions`

## v1.5.0

Date: 2026-04-26

This is the next main update after `v1.4.2`. It includes the new Group Chat system, rewording some UI elements, a unified Sampling workspace, improved mobile behavior, token accounting fixes, OpenAI Responses streaming fixes, In-Chat Agent fixes, RAG enablement fixes, cleaning up unnecessary dependencies, and redundant deprecated-code cleanup.

### Group Chats
Group Chats still work for normal group RP: you can pick a group, write as the user, choose who speaks next, and run the scene manually just like before. The new group chat system adds optional tools for people who want the group to feel more like a living conversation, chatroom, party scene, or auto-RP setup.

- Added a bottom group-chat control bar with active speaker selection, Speak Now, manual DM mode, Auto Mode, Auto DM, unread DM badges, and compact mobile controls.
- Added private per-character DM chats. DMs use participant-limited context, show unread badges on character avatars, can be opened with one tap, force DM mode while inside the private chat, and include Return to Group navigation.
- Added Auto Mode for scheduled or autonomous group replies, with per-group persistence, configurable delay, context-aware direct-name replies, group-wide prompts, and anti-loop limits so characters do not rapid-fire forever.
- Added Auto DM for private scheduled messages, including a separate cooldown so background DMs can happen without flooding the user.
- Added AI-generated 24-hour group schedules. SillyBunny can ask the model to create a full-day routine for the group, keep track of local time, catch up after downtime, and optionally let scheduled characters message when their entry is due.
- Improved inter-character conversation prompts so characters can answer, interrupt, agree, disagree, ask questions, or react to other participants instead of only responding to the user.
- Added an active-speaker typing indicator and clearer mobile group controls.
- Fixed group chat saving, branching, Recent Chats registration, empty new chats, custom-name reuse, Auto Mode persistence, draft preservation, unread DM alignment, DM tap targeting, and rapid-fire DM auto-replies.
- Removed redundant old group modes and controls, including Narrator Merge, One at a time, and the old Narrate Turn flow.

### Character Notes
- Made Character Author's Note (Private) editable in group chats and separated group-specific notes from individual chat notes.
- Fixed private note persistence and injection for `Use character author's note` plus `Replace`, `Top`, and `Bottom` placement.

### Workspace, Sampling, And Presets
- Added a unified Sampling menu in the Workspace menu for Chat Completions and Text Completions. This also migrates seed and logit bias information from Chat Completions to a more logical place, and includes a Neutralize Samplers button for Chat Completions.
- Updated Geechan's bundled roleplay preset to `Geechan - Universal Roleplay (Chat Completions) (v5.2)` plus matching Text Completions context and system prompt variants.
- Replaced `Geechan's Chatroom Prompt` with the overhauled `Geechan - Universal Online Chat (Chat Completions) (v1.0)` preset, plus matching Text Completions context and system prompt files.
- Updated `Pura's Director Preset (SillyBunny)` to version `13.0` and removed the separate SillyTavern variant from bundled content.
- Added roomier editing tools, including a resizable first-message field, a desktop World Info pop-up editor, expanded context-size presets, Text Completions preset parity, and better advanced definitions editing.
- Added an OpenRouter/NanoGPT-only `Unlocked Context Size` toggle in Chat Completion token budget settings, preserving SillyBunny's always-unlocked behavior for other providers.
- Fixed preset and settings layout polish, including balanced prompt manager panes, aligned prompt preset controls, equalized Presets dropdown controls, and less-clipped preset action text.
- Fixed Prompt Manager token attribution so the Main Prompt row shows the Main Prompt text itself instead of inheriting surrounding injected prompt totals.

### Chat History, Server Tools, And RAG
- Added Chat History tools for LLM-assisted chat labels, old-chat cleanup, and backup cleanup with previews, confirmations, retention filters, and mobile-friendly controls.
- Added Customize > Server thumbnail controls for format, quality, dimensions, sharp defaults, and per-user cache clearing; sharp PNG thumbnails are now the default.
- Fixed Vector Storage/RAG enablement so legacy saved flags migrate correctly and extensions can turn RAG on through live settings or the shared `SillyTavern.rag` API.
- Fixed OpenAI Responses streaming so expected client disconnects and aborts stop cleanly without noisy `Responses API stream error` logs, while preserving error logging for real upstream stream failures.
- Added Responses API stream coverage for Chat Completions SSE conversion, reasoning deltas, output deltas, and abort suppression.

### In-Chat Agents
- Fixed separated Individual/Group enablement, recovered saved toggles that were missing from scoped state, and made manual agent runs queue instead of disappearing.
- Fixed automatic post-generation runs on desktop and mobile, including late mobile render timing after the generation flag clears and delayed iOS Safari page wakeups.
- Fixed mobile post-processing recovery when iOS Safari misses the generation-ended event, leaves the generation flag stuck, or replaces the rendered message object before queued agents flush.
- Fixed regex-only agents so their formatter scripts attach as soon as an assistant message is received instead of waiting for post-generation processing.
- Fixed in-chat agent regex scripts so they attach during streamed assistant replies and render immediately, matching the native Regex extension timing.
- Fixed in-chat agent post-processing recovery for regenerated assistant replies and preserved prompt-transform diff/undo controls after chat reloads.
- Fixed Impersonate handling so it is treated as user-side generation and no longer runs post-processing, fallback recovery, or regex snapshot mutation against the previous assistant message.
- Fixed prompt-transform runs, transform history, processed-run keys, regex snapshots, and undo/redo controls to use active swipe metadata instead of leaking shared message metadata across swipes.
- Scoped Prose Polisher and agent change history to the active swipe so the document icon only shows edits for the currently visible message.
- Fixed dry-run prompt previews so active pre-generation in-chat agent prompts are included before generation starts, preventing token totals from jumping when the live request begins.
- Prevented mobile render replacements from rerunning post-processing agents that already handled the same generated message.
- Hardened mobile post-processing guards so delayed automatic render/receive events cannot rerun agents after generated timestamp metadata changes.
- Fixed active-swipe regex metadata persistence through chat reloads and prevented Impersonate events from clearing it.
- Added a separate Pathfinder memory summary UI with editable summary text and injection status.
- Fixed Agents Quick Toggles overflow, Pathfinder control alignment, hidden idle cancel buttons, and Pathfinder log detail layout.

### UI And Mobile
- Added a persistent compact mode for the refreshed SillyBunny UI.
- Reworked the default desktop and mobile UI for more consistent spacing, square icon buttons, aligned drawers, normalized dropdowns, readable highlighted text, and a less cramped composer.
- Renamed Navigate to Workspace, shortened the primary character shortcut labels to `FAV.` and `ADV.`, and removed deprecated visible Extras wording.
- Fixed mobile bottom chat controls, send/stop sizing, group avatar spacing, typing indicator alignment, toggle visibility, unread DM badge visibility, avatar refresh flicker, and mobile prompt control alignment.
- Fixed chat and character UI regressions around zoomed avatars, overflowing thumbnails, individual recent chats, group-row alignment, prompt visibility eye buttons, WebKit Ripple rendering, bottom chat spacing, composer panel theming, and first-message top alignment.
- Fixed the refreshed mobile composer so the chat text box and bottom action bar stay compact on narrow screens.
- Restored compact one-line mobile Prompt Manager rows on very narrow screens by keeping prompt names, controls, and token counts aligned in a single row.
- Removed the pill-shaped background from chat message numbers while keeping timer and token metadata spacing intact.
- Fixed reasoning token accounting so locally parsed `<think>`, `<thinking>`, and `<thought>` blocks count as thought tokens while visible message token counts stay scoped to output text.
- Enlarged quick context-size preset labels on mobile and narrow panels so values such as `128 K` and `1 M` fit their buttons cleanly.
- Aligned the mobile Quick Actions menu with fixed icon and label columns so every row starts and justifies consistently.

### Extensions And Moonlit Echoes
- Removed the bundled Moonlit Echoes extension, built-in Moonlit chat stylesheet, and Echo, Whisper, Hush, Ripple, and Tide options from core Appearance.
- Kept core chat style validation to Flat, Bubbles, and Document; old saved Moonlit style values now reset to Flat and clear legacy body classes.
- Added the SillyBunny-specific Moonlit Echoes fork to Launchpad optional installs.
- Added a warning-only Moonlit Echoes update toast that points affected users to the fork without disabling or changing saved theme settings.
- Replaced the patched bundled Nemo preset extension with the SillyBunny-owned Bunny Preset Tools local extension, including saved-settings migration and no nested upstream git checkout.
- Fixed duplicate extension settings drawers so repeated extension activation does not create doubled panels.
- Fixed Moonlit Echoes fork styling so enabled Moonlit chat thumbnails and the mobile composer remain usable.

### Maintenance
- Cleaned up launcher installs so routine starts are quieter, preserve ESLint dependencies, and avoid unnecessary dependency work when runtime inputs have not changed.
- Fixed Basic auth plus account-login sessions so module assets such as `/lib.js` keep loading after login on mobile browsers, and made unauthorized auth pages non-cacheable.
- Fixed lint coverage by including `scripts/**/*.js` in the standard ESLint target and resolving the existing lint failures.
- Fixed frontend cache clearing after updater reloads.
- Removed unused deprecated server utilities for mutable config writes and direct HTTP/2 requests, including the now-unused `node:http2` import.
- Removed unused deprecated Express parser aliases that were superseded by application-level middleware.
- Removed redundant root package metadata, dropped unused direct Chevrotain types, and moved test-only ESLint plugin ownership into the nested `tests` package.
- Cleaned up test lint references so nested test lint runs without warnings or undefined globals.
- Kept `public/scripts/f-localStorage.js` in place for extension compatibility.
- Bumped app-owned version strings to `1.5.0` without changing dependency versions.
