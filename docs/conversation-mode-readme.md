# Conversation Mode

Conversation Mode gives each character a separate instant-messaging-style chat outside the normal roleplay. Instead of writing a full narrated scene, characters respond as if they are talking through private messages (solo or group). These Conversation threads have their own history, branches, memories, attachments, notifications, and settings.

Conversation Mode does not replace the normal Roleplay mode. You can switch between the two modes without turning the roleplay into a DM. Characters can optionally react to events in the current roleplay, but this only happens when **React to current roleplay** is enabled.

Conversation Mode uses your active model connection by default. You can also select a separate **Connection Profile** for all Conversation Mode generations. Features such as replies, memory summaries, schedules, prose polishing, proactive messages, and generated images may create additional model or image-generation requests.

> [!NOTE]
> Labels and behavior may change while development continues.

## Getting Started

1. Pick or import a character, then use the character mode switch at the top left of the Character menu drawer to change from **Roleplay** to **Conversation**.

2. Open the **Pals** panel and start a solo DM with one of your characters. You can also create a group Conversation and add several characters to it.

3. Type a message into the Conversation composer and press **Send**. Conversation Mode uses a separate prompt designed for casual, direct-message-style replies rather than narrated roleplay.

4. Open the gear button in the Conversation header to review the DM settings. If Conversation Mode cannot generate a reply, check the **Connection Profile** under Context Overrides. Leaving it on **Use current connection** makes Conversation Mode use your currently active model.

5. Make sure to test basic functionality first! Keep automatic messaging, scheduling, and image generation disabled until the normal DM works correctly. These options can generate messages or images without another manual Send action.

## How Conversation Mode Works

Every solo DM or group DM has its own Conversation chat history. This history is stored separately from the normal roleplay chat and is also separated by persona. Switching to another persona gives that persona their own Conversation threads and memories.

Conversation Mode normally sends the recent DM transcript, character information, persona information, current time, saved Conversation memory, and any selected overrides to the model. Its default system prompt tells the model to respond as the selected character using plain chat messages rather than narration or roleplay actions. This can be overridden by custom user instructions if wanted.

A character can return several short chat bubbles in one reply. You can reply to a specific message, edit messages, copy them, pin them, regenerate character replies, create a new branch from an earlier message, or delete individual messages.

## Solo DMs, Group DMs, and Pals

The **Pals** panel lists your available solo and group Conversation threads. It also shows unread indicators and lets you search for a DM, start another solo chat, create a group chat, or mark all Conversation messages as read.

A solo DM contains the user and one main character. A group DM can contain several characters. You can use `@Name` to address a particular member. Depending on the message, one or two group members may answer. Characters can also be allowed to talk to each other automatically when that group option is enabled.

The persona controls at the bottom of the Pals panel let you switch the active persona and set your Conversation status. Because histories are persona-specific, changing persona also changes which Conversation threads and memories are being used.

## Conversation Branches

A Conversation thread can have several branches. A branch is an alternate version of the same DM history.

Pressing **New Chat** creates another Conversation branch. It does not delete the previous branch. You can switch between branches, rename them, or delete a branch from the Pals panel.

You can also choose **Branch from here** on a message. The new branch keeps the Conversation up to that selected message, allowing you to continue from that point without changing the original branch.

Conversation memory can carry into new branches if the setting is enabled, so starting another branch does not necessarily make the character forget everything previously summarized.

## Message Controls

Each message can provide actions for replying, copying, pinning, branching, and deleting. Character messages can also be read aloud or regenerated. When **Enable Quick-Edit DM Actions** is enabled, messages can be edited directly. When **Character Prose Polisher** is enabled, character replies also show a polishing action.

Replying to a message adds a visible reply preview to the composer and gives the model a reference to the selected message. Pinning a message adds it to the **Pins** filter. Reactions such as a heart, sparkle, or laugh are stored on the message without creating another model reply.

## Tools and Filters

Press the sliders button beside the composer to show Conversation tools.

The **Main** tab shows the full thread. **Pins** shows pinned messages. **Selfies** shows generated Conversation images. **Files** shows messages with attachments. **OOC** shows out-of-character notes, while **Memories** collects pinned messages, reminders, and generated images.

The quick tools include **Selfie**, **Remind**, **Schedule**, **Summarize**, and **Force**. Selfie sends the current Conversation context to Quick Image Gen. Remind creates a reminder in the current DM. Schedule opens the weekly routine editor. Summarize refreshes the saved Conversation memory. Force requests a reply even when the character is shown as Do Not Disturb or Offline.

The search field filters messages in the current thread and can be combined with the selected tab.

## Conversation Memory

Conversation memory is a persistent summary written by the model for long-term DM continuity. It focuses on information such as relationship tone, promises, preferences, boundaries, private jokes, and unresolved topics.

Memory is separate from the visible message history. It can remain available after starting a new branch or deleting an old DM history. Use **Clear memory** when you want that saved continuity removed as well.

Conversation Mode can create and periodically update memory after enough messages have accumulated. You can also press **Create memory**, **Refresh memory**, or the quick **Summarize** tool manually.

A solo DM can optionally remember saved summaries from group DMs containing that character. A group DM can likewise receive relevant memory from the character’s solo DM. This is controlled by the related-memory option in the settings.

## Character Availability and Schedules

Each character can be shown as Online, Idle, Do Not Disturb, or Offline. Their selected or scheduled status can affect reply timing and whether an automatic responder is used.

The Character Schedule describes what the character is doing during different days and times. It can be generated with the current model or edited manually. Schedule entries contain a time range, activity, and availability status.

The schedule is used as current character context. For example, the model may be told that the character is working, sleeping, or commuting. It can also affect when proactive messages are allowed.

The separate **Manual Scheduling** section is used for fixed-time messages. You can add weekly slots that send a specific check-in at a chosen day and time. Character Schedule describes the character’s routine; Manual Scheduling creates scheduled outgoing messages.

## Automatic Messages

Automatic messaging is optional and disabled until its related controls are enabled.

**User Idle Actions** are global. An auto follow-up can respond to silence (either from user or other group chat members) in the current thread, while a spontaneous ping can begin a new topic after a longer quiet period.

**Proactive Messaging** belongs to the selected DM or group. It lets the character or group members message first after the configured inactivity period. Patience controls how long Conversation Mode waits, Max follow-ups limits repeated messages, Talkativeness affects the character’s automatic-chat behavior, and Reply delay controls how long simulated typing waits before displaying the result.

**Enable Scheduling** sends messages from the weekly Manual Scheduling slots. **Allow characters to talk to each other** permits selected group members to create autonomous character-to-character messages after the configured cooldown.

These features use the Conversation connection and may create model requests while the Conversation workspace is closed. You are notified whenever you get a new message from either or both of these automatic messages.

## Files and Images

You can attach files with the paperclip button, paste supported files into the composer, or drag them onto the Conversation workspace. A message can contain up to four attachments, with a maximum size of 25 MB per file.

Conversation Mode supports common image, audio, video, text, document, spreadsheet, presentation, ebook, JSON, and CSV formats. Media is displayed directly where supported. Other files appear as downloadable attachments, and supported document text can be added to the model’s prompt context. Do remember only Vision-capable models can parse these; other models will likely just hallucinate and pretend they saw something.

Image features use the bundled extension Quick Image Gen, modified for SillyBunny use and automation. The quick **Selfie** tool asks for a scene and generates an image for the current character. A character can also request an image through a hidden `[selfie]` command when that option is enabled. Spontaneous Selfies allow image generation during automatic Conversation activity.

Image generation requires Quick Image Gen to be installed and configured. Its model, provider, and usage limits are separate from the Conversation text model.

## Prompts and Context

The **Geechan Chatroom System Prompt** controls the basic Conversation writing format. It is designed for first-person, plain-text messages without roleplay narration. It can be edited or reset to its bundled default.

**Custom Instructions** apply globally to all solo and group Conversation threads. **Grounded Dialogue Rules** are another optional global block intended to reduce repetitive or clichéd wording.

A DM can override its Lorebook and Author’s Note. Conversation Mode also includes character information, persona information, current device time, saved memory, and schedule context when building a reply.
