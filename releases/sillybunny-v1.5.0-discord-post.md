**SillyBunny version 1.5.0 has released**
This release focuses on the new Group Chat system, a cleaner Workspace/Sampling flow, stronger mobile polish, and fixes for In-Chat Agents, RAG, OpenAI Responses streaming, launchers, and extension handling since version 1.4.2.

**Detailed Changelog**

**Added**
- New Group Chat tools: bottom control bar, active speaker selection, Speak Now, manual DM mode, Auto Mode, Auto DM, unread DM badges, and compact mobile controls.
- Private per-character DM chats with participant-limited context, Return to Group navigation, forced DM mode, and unread badges.
- AI-generated 24-hour group schedules with local-time tracking, downtime catch-up, and optional scheduled messages.
- Unified Sampling menu in Workspace for Chat Completions and Text Completions, including seed/logit-bias relocation and Chat Completions Neutralize Samplers.
- Chat History cleanup and backup tools with previews, confirmations, retention filters, and mobile-friendly controls.
- Server thumbnail controls for format, quality, size, sharp defaults, and per-user cache clearing.
- Responses API streaming coverage for SSE conversion, reasoning deltas, output deltas, and abort suppression.
- Pathfinder memory summary UI with editable summary text and injection status.
- Persistent compact mode, refreshed desktop/mobile spacing, and mobile Quick Actions alignment improvements.
- SillyBunny-specific Moonlit Echoes fork in Launchpad optional installs plus warning-only migration guidance for affected users.

**Fixed**
- Group chat saving, branching, Recent Chats registration, empty new chats, custom-name reuse, Auto Mode persistence, draft preservation, unread DM alignment, DM tap targeting, and rapid-fire DM auto-replies.
- Character Author's Note private-note persistence/injection in group chats.
- Preset/settings layout issues, Prompt Manager token attribution, prompt controls, and preset dropdown spacing.
- Vector Storage/RAG enablement migration and live extension toggles through `SillyTavern.rag`.
- OpenAI Responses streaming disconnect/abort handling without noisy false-error logs.
- In-Chat Agent enablement, saved toggles, manual queues, automatic post-generation runs, iOS Safari/mobile recovery, streamed regex attachment, active-swipe metadata, prompt previews, and Impersonate handling.
- Mobile chat controls, send/stop sizing, avatar spacing, toggle visibility, unread DM badges, prompt control alignment, composer compactness, and narrow Prompt Manager rows.
- Reasoning token accounting for local `<think>`, `<thinking>`, and `<thought>` blocks.
- Duplicate extension settings drawers, Moonlit Echoes fork styling, launcher install noise, Basic auth module loading, lint coverage, frontend cache clearing, and nested test lint warnings.

**Removed**
- Redundant old group modes and controls: Narrator Merge, One at a time, and the old Narrate Turn flow.
- Bundled Moonlit Echoes extension, built-in Moonlit chat stylesheet, and Echo, Whisper, Hush, Ripple, and Tide core Appearance options.
- Separate SillyTavern variant of Pura's Director Preset from bundled content.
- Patched bundled Nemo preset extension, replaced by Bunny Preset Tools.
- Deprecated server mutable-config and HTTP/2 helper utilities, deprecated Express parser aliases, unused root package metadata, and unused direct Chevrotain types.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run git pull.
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
