# Conversation Mode Glossary

Conversation Mode is a separate direct-message workspace for talking to SillyBunny characters outside the normal Roleplay transcript. This reference explains the visible controls, automatic behavior, prompt settings, and stored Conversation data.

## Opening and Closing Conversation Mode

Choose a character and use the **Roleplay / Conversation** mode switch to open Conversation Mode. Opening the workspace does not delete or replace the normal roleplay chat. Conversation Mode has its own timeline and input field. A character card must exist before the UI workspace can open. When no Conversation DM has been selected, the workspace asks you to choose or create one through the Pals panel.

Closing Conversation Mode returns to the normal Roleplay interface. Conversation histories, branches, memories, unread counts, schedules, and enabled automatic behavior remain stored.

## Separate Conversation Data

Conversation Mode stores its messages separately from ordinary character chat files. Solo DMs, group DMs, branches, memories, reminders, schedules, and unread counts are part of the Conversation store. Conversation data is also associated with the active persona. Switching personas changes the Conversation threads and long-term memories available to that persona. This prevents two different personas from automatically sharing the same private DM history. If you'd like to use the same persona with alt details, use the Persona Scenario Notes. Conversation Mode normally includes up to the most recent 32 messages from the current branch in a generation request. Long-term memory is used to preserve useful information from older messages without repeatedly sending the entire thread.

## Conversation Header

The Conversation header shows the current character or group, participant avatars, and current availability information.

| Control        | What it does                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Pals**       | Opens the Pals panel containing solo DMs, group DMs, unread indicators, personas, and Conversation status controls. |
| **Add Member** | Adds another eligible character to the current group Conversation. It appears when group membership can be edited.  |
| **New Chat**   | Creates and selects a new branch for the current Conversation. It does not delete the previous branch.              |
| **Settings**   | Opens the DM or Group controls drawer.                                                                              |

The Conversation workspace window is also moveable so long as Moving UI is enabled.

## Pals Panel

The Pals panel is the Conversation contact and thread list. It contains solo DMs, group DMs, branch controls, unread counts, and recent-message previews.

| Control                    | What it does                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| **New Solo Chat**          | Opens a picker for enabling and starting a Conversation DM with a character. |
| **New Group Chat**         | Opens the group Conversation creator.                                        |
| **Mark All Read**          | Clears unread counts for the active persona’s Conversation threads.          |
| **Search direct messages** | Filters the visible Pals list by character or group name.                    |
| **Close**                  | Closes the Pals panel.                                                       |

Selecting a Pal opens that specific solo or group thread. Conversation entries may also appear among recent chats on the SillyBunny welcome screen.

Deleting a solo DM through its Pals controls resets its Conversation branches and disables that character’s solo Conversation. Deleting a group DM history resets the corresponding group Conversation history. These actions are different from **New Chat**, which preserves older branches.

## Persona and User Status Controls

The footer of the Pals panel displays the active persona. Pressing the persona avatar opens the persona picker. Changing persona changes the Conversation identity, persona information, selected Scenario Notes, and persona-specific Conversation histories. The edit-persona-status button lets you provide a status or description associated with the current persona. This can be added to the Conversation prompt as user-presence context.

The status button offers Online, Idle, Do Not Disturb, and Invisible. Invisible is stored as the user’s Offline state. The character model receives the user’s current status, allowing it to respond differently when appropriate. When the user is Invisible, they will never receive any pings from characters, regardless of if Spontaneous ping and automated messages are enabled.

## Solo DMs

A solo DM contains the active persona and one character. Its settings can be configured independently from other solo DMs, except for options marked **Global**. Conversation Mode uses the character card, Conversation system prompt, recent DM transcript, persona information, current time, memory, and selected context overrides when generating replies. A solo DM can optionally remember saved summaries from group DMs that include the same character.

## Group DMs

A group Conversation contains the active persona and several characters. Group Conversation settings force multi-character mode and autonomous character chat support on at the configuration level.

When the user sends a group message, Conversation Mode chooses eligible speakers. Explicit `@Name` mentions take priority, and they respond immediately once tagged. When no character is named, it can favor the most recently addressed speaker or choose among group members. Other group members may also respond. Response is based on chance percentage or when the LLM takes the context and decides that a particular character would be best to respond next in the current group conversation. 

Each generated group message is produced as its own character. The model is instructed not to speak for the other participants while generating that character’s response.

Group DMs can optionally receive relevant saved memory from a character’s solo DM. Private solo information is provided with an instruction not to reveal it unless it naturally belongs in the group Conversation.

## Conversation Branches

A branch is an alternate history within the same Conversation thread.

| Action               | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| **Select branch**    | Opens an existing branch.                                                          |
| **New branch**       | Creates a new empty branch and asks for a name.                                    |
| **Rename branch**    | Changes the branch’s displayed name.                                               |
| **Delete branch**    | Permanently removes the selected branch after confirmation.                        |
| **Branch from here** | Creates a branch containing the messages up to and including the selected message. |
| **New Chat**         | Creates another branch named using the next available Chat number.                 |

Branching from a user message can immediately queue a character response in the new branch. Branching from a character message simply creates and opens the copied history up to the point where the branch was created. When a source branch has a memory summary, **Branch from here** copies that summary into the new branch. Conversation memory is therefore not automatically erased by creating another branch.

## Composer (Bottom Bar)

The Conversation composer contains the message field, reply preview, attachment preview, tools toggle, paperclip, and Send button.

Press Enter to send when the main SillyBunny send-on-enter preference allows it (Desktop is pressing Enter/Return to send, Mobile is press the send button to send). Shift+Enter creates a new line. Files can be selected through the paperclip, pasted from the clipboard, or dropped onto the Conversation workspace. When replying to a specific message, a **Replying to** preview appears above the composer. Press its close button to cancel the targeted reply message without deleting your drafted text.

The tools toggle shows or hides filters, quick actions, and search. Its visible state is remembered in the local settings.

## Sending and Reply Generation

Several quick messages sent close together may be collected before the character begins responding, making the LLM wait for 5 seconds before truly responding. This gives the user time to send a short sequence without causing a separate model reply to every line. The reply request includes the current Conversation system prompt, character information, persona information, relevant memory, current time, selected schedule state, recent transcript, attachments, and the current user directive.

Conversation responses can be split into several chat bubbles when the model separates parts with blank lines. Each bubble is stored as a Conversation message.

## Message Actions

Message controls appear beside a message on desktop or under the ellipsis menu on smaller screens.

| Action                 | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Edit**               | Changes the stored message. It appears when Quick-Edit DM Actions is enabled.     |
| **Polish**             | Rewrites a character message through the Conversation prose-polishing action.     |
| **Reply**              | Sets the message as the current reply target.                                     |
| **Copy message**       | Copies the message text to the clipboard.                                         |
| **Pin / Unpin**        | Adds or removes the message from the Pins and Memories filters.                   |
| **Branch from here**   | Creates a new branch ending at this message.                                      |
| **Speak**              | Reads a character or partner message using the available text-to-speech system.   |
| **Regenerate message** | Replaces the selected character message using the preceding Conversation context. |
| **Delete message**     | Removes the message after confirmation.                                           |
| **React**              | Toggles a heart, sparkle, or laugh reaction on the stored message.                |

Regenerate is not available for user or system messages. It keeps the same speaker and uses the messages before the selected reply as context. If the thread changes while regeneration is running, the older message result is not written over the newer history. The regeneration takes priority, in essence.

Reactions do not make a model request. They add or remove reaction information from the stored message, considered mostly fluff or cosmetic.

## Conversation Tools and Filters

The tools area contains timeline filters, quick actions, and a search field.

| Filter       | What it shows                                                  |
| ------------ | -------------------------------------------------------------- |
| **Main**     | The full Conversation timeline.                                |
| **Pins**     | Messages marked as pinned.                                     |
| **Selfies**  | Images generated through Conversation Mode.                    |
| **Files**    | Messages containing media or file attachments.                 |
| **OOC**      | Messages stored as Conversation out-of-character notes.        |
| **Memories** | Pinned messages, reminders, and generated Conversation images. |

Search checks message names, roles, text, attachment descriptions, and reply-reference text. It can be used while one of the filters is active.

| Quick action  | What it does                                                                            |
| ------------- | --------------------------------------------------------------------------------------- |
| **Selfie**    | Asks for a scene description and sends it to Quick Image Gen for the current character. |
| **Remind**    | Asks for a delay or time and reminder text, then stores a reminder in the current DM.   |
| **Schedule**  | Opens the weekly character routine editor.                                              |
| **Summarize** | Manually refreshes Conversation memory.                                                 |
| **Force**     | Queues a reply even when normal availability rules would prevent one.                   |

## Attachments

Conversation messages support up to four attachments. Each file may be up to 25 MB. Supported media includes common image, audio, and video files. Supported document extensions include TXT, Markdown, PDF, EPUB, DOCX, XLSX, PPTX, ODT, ODS, ODP, JSON, and CSV.

Images, audio, and video are rendered directly into the UI. Other attachments are shown as file links. For supported documents, SillyBunny attempts to extract a limited amount of text and add it to the Conversation prompt.

Attachments are stored on the Conversation message. The Files filter shows messages that contain attachments.

## Presence and Availability

The **Status** setting controls the selected character’s manually configured availability.

| Status             | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| **Online**         | The character is available for normal live DM replies.                                                 |
| **Idle**           | The character can reply but may appear slower or less immediately available.                           |
| **Do Not Disturb** | Normal new messages can receive the configured auto-responder instead of an immediate generated reply. |
| **Offline**        | Normal new messages can receive the configured auto-responder while the character is away.             |

When a stored character schedule exists, the current schedule block supplies the effective activity and status. This scheduled state can take precedence over the manual Status selection. The **Force** tool bypasses normal availability restrictions, such as Invisible or DnD, and requests a response anyway.

### User Idle Actions

User Idle Actions are marked **Global**, which means they apply across solo and group Conversation DMs.

**Send auto follow-up** creates a check-in after the user has been quiet in the current thread for at least the Idle Minimum. It is tied to the latest period of user inactivity and does not repeatedly fire for the same silence period.

**Spontaneous ping** starts a casual new topic or ambient thought after a quiet stretch. When both idle actions are enabled, the spontaneous ping waits longer than the normal follow-up.

**Idle Minimum** is the number of quiet minutes required before these actions can run.

These settings are different from Proactive Messaging. Idle Actions are global reactions to user silence, while Proactive Messaging is configured for the selected DM and uses its schedule, patience, follow-up count, and talkativeness.

### Offline/DND Auto-responder

The **Offline/DND Auto-responder** is inserted when the character’s manually selected availability is Offline or Do Not Disturb. The message can be edited freely.

The default text is:

```text
[{{user}} is currently offline. Leave a message!]
```

The `{{user}}` macro is replaced with the active persona name.

## DM Notifications

Conversation Mode tracks unread messages separately for each persona and thread. Unread indicators can appear on the Pals button, Conversation mode switch, document title, favicon, and Characters drawer.

**Mute this DM** suppresses its notification sound and popup while preserving unread badges.

**Priority** can be Normal, Silent, or Priority. Notification behavior also respects quiet hours and the thread’s mute state.

**Quiet start** and **Quiet end** use `HH:MM` values. During that period, sound and popup notifications can be suppressed while unread indicators continue updating.

Pressing **Mark All Read** in the Pals panel clears unread counts for the active persona.

## Character Schedule

Character Schedule represents the character’s weekly routine and current availability. It is used as model context and by automatic Conversation behavior.

**Generate schedule** asks the current active model to produce a weekly routine for the selected character. The generated schedule also supplies Talkativeness and an Inactivity Threshold.

**Edit schedule** opens the weekly routine editor. Each day can contain time blocks with a time range, activity, and status. Valid statuses are Online, Idle, Do Not Disturb, and Offline.

The editor also contains **Talkativeness** and **Inactivity Threshold**. Saving changes stores the schedule for that character and persona.

When a current schedule block exists, the Conversation prompt tells the model the character’s current local activity, status, and time. This can influence what the character mentions and whether they are treated as available.

## Proactive Messaging

**Let this character message me first** enables proactive solo-DM messages. In a group Conversation, the equivalent option allows group members to message first. Proactive messaging uses the selected DM or group’s settings and can run even when Conversation Mode's UI workspace is not open.

**Patience** is the minimum inactivity period before proactive behavior is considered. Its visible range is 15 to 360 minutes.

**Max follow-ups** limits how many proactive follow-up messages can be sent before the user responds. Its visible maximum is three.

**Talkativeness** is a value from 0 to 100 used by Conversation scheduling and automatic behavior. It also affects simulated reply timing. Lower values contribute to sending a slower interval of messages, while higher values reduce that delay.

**Reply delay** is a percentage multiplier for simulated typing delay. The default value of 100 uses the normal calculated delay. A value of 0 removes it. A value of 200 approximately doubles it, subject to the internal maximum delay. This is simply for cosmetic purposes.

**Max reply tokens** is the requested output-token ceiling for each Conversation reply. The default is 16,000, with a visible range from 64 to 64,000. Some providers may include reasoning tokens into the message reply, hence the 16k default. This prevents cut-offs.

In group Conversations, these specific settings apply only to that group and do not alter the members’ solo DMs.

## Character Commands

Conversation Mode can tell the model about hidden commands. When used correctly, these commands are removed from the visible message and processed separately.

## Selfie command

When **Selfies through Quick Image Gen (`[selfie]`)** is enabled, a character may include:

```text
[selfie]
```

or a context-specific form such as:

```text
[selfie: context="showing the rainy street outside"]
```

The command is removed from the visible text. A Generate selfie action is attached to the resulting message or an image request is processed through the Conversation image workflow.

### Schedule update command

When **Character status updates (`[schedule_update]`)** is enabled, a character may update its current activity and status through a structured command. This lets the character record that it has gone to work, arrived home, gone to sleep, or otherwise changed availability. Primarily based on the current character schedule.

### Reminder command

Conversation Mode also tells the character it can create a reminder when the user naturally requests one:

```text
[reminder: 2h | check the oven]
```

The command is removed from visible text and stored as a Conversation reminder.

These commands depend on the model following the required syntax. The quick Selfie and Remind tools provide manual alternatives.

## Chat Memories

Conversation memory is a model-written summary used for long-term continuity. It focuses on durable information such as relationship tone, promises, unresolved topics, preferences, private jokes, boundaries, and emotionally important events.

Automatic memory generation begins after enough non-system messages exist. Later updates occur after additional messages have accumulated. Only recent messages are used to produce each summary, while the previous summary is included so the model can update it.

| Control            | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| **Create memory**  | Creates the first summary when the thread has content.                     |
| **Refresh memory** | Regenerates the memory from the current summary and recent thread history. |
| **Clear memory**   | Removes the stored summary.                                                |
| **Summarize**      | Quick-tool form of refreshing Conversation memory.                         |

Memory is persistent and is not automatically removed when a branch or visible DM history is deleted. Use **Clear memory** when you also want the saved long-term context removed.

The internal **Copy memory to new branch** behavior is enabled by default. New branches can therefore retain the source Conversation’s summarized continuity.

### Related Memory

In a solo DM, **Remember group DMs in this solo DM** includes saved summaries from group Conversations containing that character.

In a group DM, **Remember solo DMs in this group DM** includes relevant memory from the selected character’s solo Conversation.

The prompt tells the model to treat related memories as background and not reveal private details where they would not naturally belong.

## Manual Scheduling

Manual Scheduling creates fixed-time outgoing messages. It is separate from the Character Schedule.

**Enable Scheduling** activates scheduled Conversation messages.

**Cooldown** is the minimum number of seconds between scheduled sends.

The **Weekly Schedule** editor contains one or more entries with selected weekdays, a time, and the message context. At the selected minute, Conversation Mode can ask the character to send a message based on that entry.

The automatic worker checks Conversation tasks periodically rather than continuously, so a scheduled action may not begin at the exact millisecond of the selected time.

Character Schedule describes what the character is doing. Manual Scheduling tells Conversation Mode when to create a particular outgoing message. (I.e. schedule character to message me around this time.)

## Prompts and Formats

### Geechan Chatroom System Prompt

The **Geechan Chatroom System Prompt** is the main Conversation-specific style prompt. Its bundled version instructs the model to speak as the selected character using first-person plain chat text, avoid narration and roleplay actions, vary message length naturally, and avoid speaking for the user or other participants.

The model can produce multiple individual chat bubbles rather than one long roleplay passage.

**Reset to default** restores the bundled Geechan prompt.

Editing this prompt changes the base behavior for the selected Conversation settings scope. Invalid or contradictory instructions can make the model return narration, speaker labels, or malformed messages.

### Custom Instructions

**Custom Instructions** are marked Global. They apply to every solo and group Conversation DM.

Use this field for rules that should affect all characters, such as a preferred message length or a general formatting restriction. Character-specific instructions belong in the character card, selected Author’s Note override, or thread-specific system prompt. These instructions are taken into priority if anything contradicts with the chatroom system prompt. For example, if you prefer asterisks, you may write that actions are wrapped in asterisks, and it ignores the system prompt forbidding that.

### Grounded Dialogue Rules

**Grounded Dialogue Rules** are an optional Global prompt block. The rules discourage repeated clichés, vague emotional descriptions, excessive mannerisms, and certain common prose constructions. The checkbox enables or disables the block. The pencil button opens a larger editor containing the full rules. Reset inside that editor restores the original rules. These rules apply only to Conversation Mode prompts and do not modify the normal Roleplay preset.

## Additional Members and Autonomous Character Chat

**Add additional members in the chat** enables selection of other character cards as Conversation participants.

The Group DM Members picker searches and selects eligible characters. Their avatar identifiers are stored as the member list. Mention a member using `@Name` to make them a likely reply target. Mentions are highlighted in the displayed message where applicable.

**Allow characters to talk to each other** permits enabled members to generate autonomous character-to-character messages in the current Conversation thread.

**Character chat cooldown** sets the minimum number of minutes between autonomous character messages. The default is ten minutes.

Group Conversation threads use the same member list for ordinary user-directed replies and autonomous character chat.

## React to Current Roleplay

**React to current roleplay** lets a character privately respond to activity from the current normal Roleplay chat or Roleplay group chat.

When enabled, Conversation Mode can occasionally create a DM aside based on a newly rendered character roleplay message. In a group roleplay, it may choose the speaker or another eligible Conversation member. These reactions are saved in the separate Conversation thread rather than inserted into the normal roleplay transcript. Enabling this option can create additional Conversation model requests during roleplay.

## Context Overrides

### Lorebook Override

**Lorebook Override** selects a specific World Info book for the Conversation. Leaving it on **Character default (no override)** uses normal character-linked behavior.

When an override is selected, the system prompt tells the model to prefer that lore focus over normal roleplay-scene continuity.

### Connection Profile

**Connection Profile** is marked Global and is used for all Conversation Mode model generations. Leaving it on **Use current connection** follows the currently active connection profile. The selected profile is used for ordinary Conversation replies and Conversation sidecar generations such as memory and schedules where applicable. Changing this setting affects solo and group Conversations globally.

### Author’s Note Override

**Author’s Note Override** supplies Conversation-specific instructions for the selected DM or group. It replaces the character’s normal Conversation Author’s Note source when filled. Standard macros apply.

## Image Generation

Conversation Mode image features require the bundled extension, Quick Image Gen, which is modified to be used with SillyBunny.

**Enable chatroom image generation** allows Conversation Mode to request images.

**Image Prompt Template** is the base prompt used for generated Conversation images. Its default is:

```text
a photo of {{char}}, {{scene}}
```

**Negative Prompt** supplies content that the image generator should avoid.

**Image Cooldown** sets the minimum number of minutes between Conversation image generations for that thread.

**Enable Spontaneous Selfies** allows automatic Conversation activity to produce a selfie when image generation is enabled and the cooldown has elapsed.

**Selfie Prompt Template** is used for spontaneous selfies. Its default is:

```text
raw photo, selfie of {{char}}
```

The quick Selfie tool asks for a scene description. A character-generated `[selfie]` command can also create a Generate selfie action. While an image is being generated, the Conversation timeline shows a pending item with a Stop button.

Quick Image Gen has its own specific settings on its own extension menu. Selecting a Conversation text connection does not configure the image provider.

## DM Tweaks

**Enable Quick-Edit DM Actions** shows the pencil action beside Conversation messages. Disabling it hides the quick Edit action but does not lock or encrypt stored messages.

**Character Prose Polisher** adds a wand action to non-user messages. Pressing it sends the selected message through the Conversation polishing workflow and updates the stored result. It uses the default Prose Polisher agent from In-Chat Agents.

## Notifications and Unread Counts

A Conversation message increments unread state when it arrives outside the active thread. Opening the relevant thread clears or updates its unread state according to the normal Conversation notification flow. Unread counts can be displayed in several places, including the Pals toggle, Conversation mode tab, browser title, favicon, and Characters controls. Muted threads and quiet hours still retain unread counts. They mainly suppress the message sound and popup notification. A Conversation notification popup can be clicked to open the thread and branch that produced the message.
