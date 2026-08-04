# In-Chat Agents Glossary

## Core Terms

**In-Chat Agents (ICA)** is the extension that runs optional processing around normal chat generation. An **agent** is a stored prompt and configuration that defines its activation conditions, execution stage, model connection, context sources, and output handling.

**Main model** is the model used for the normal chat generation. Inline agents can add to its input or process its output. Companion agents run separate model requests and store their results without directly replacing the main response.

**Context** is the assembled input for a model request. For the main generation, it can contain the system prompt, character and persona data, World Info, Author's Note, recent chat messages, and injected agent prompts. Companion and intercept requests assemble their own context for their specific processing stage.

## Main Agents Panel

The main Agents panel is used to install, enable, search, organize, import, export, and edit agents.

| Control                    | What it does                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Agents On / Agents Off** | Enables or disables all ICA processing without changing individual agent toggles.                             |
| **New Agent**              | Opens a blank agent editor.                                                                                   |
| **Templates**              | Opens the bundled template library.                                                                           |
| **Update All**             | Updates installed agents whose bundled templates have newer versions. It is shown when updates are available. |
| **Fix Trackers**           | Reruns enabled tracker agents on the last assistant reply using tracker repair behavior where supported.      |
| **Companions**             | Opens the Companion dashboard.                                                                                |
| **Trackers → Companions**  | Converts inline tracker agents to Companion execution using automatic operation and panel display.            |
| **Cancel Agent**           | Stops the active ICA generation. It appears while an agent request is running.                                |
| **Select**                 | Enables multi-select mode for bulk actions.                                                                   |
| **Import**                 | Imports one or more agents from a JSON file.                                                                  |
| **Export All**             | Exports all installed agents to a file.                                                                       |

The list is divided into **All**, **Quick Access**, **Pre**, **Post**, and **Companions** tabs. Quick Access shows agents that have been pinned with **Pin to Quick Toggles**. Pre and Post show Inline agents that participate in those generation phases. The Companions tab shows agents using Companion execution.

The search box filters agents by text, while the category selector filters them as Tracker, Randomizer, Content, Companion, or Custom. These filters only change what is visible in the list. They do not modify or disable agents.

The **Agent Tokens** display reports the token count associated with active agent prompts. Separate helper requests, Companion input, and generated output can add more usage beyond this displayed value.

Pressing **Select** allows several agents to be changed together. The bulk controls can enable or disable selected agents, set their injection role to System or User, allow selected post-generation agents to process Companion output, convert agents to Companion execution, edit shared properties, or delete them. Bulk Edit changes only the properties selected in its dialog.

### Global Connection and Execution Settings

**Default Connection Profile** selects the connection used when an agent makes a model request and has no profile set in its own editor. Leaving it on **Use selected connection profile** makes ICA follow the active Connection Manager profile. I.e. if you're currently using GLM as your main model, the agent will use GLM to deploy agents that edit the before and/or after main model responses.

**Companion Connection Profile** provides a separate default for Companion requests. An individual Companion’s own Connection Profile takes priority. If it has no override, ICA uses the Companion profile; if no Companion profile is selected, it falls back to the normal ICA default connection.

**Append Agents Execution** controls post-generation agents whose prompt-pass mode is **Append generated content**. **Parallel mode** starts compatible append agents together and is faster, but it may create several simultaneous API requests. **Sequential mode** runs them one at a time in ascending Order and is less likely to encounter concurrency or rate limits, but it could take longer depending on the speed of your LLM.

**Companion Execution** independently controls whether Companion agents run in parallel or sequentially. In **parallel mode**, independent Companions can run at the same time. In **sequential mode**, they run one after another. Companion dependencies and batching can still alter how a particular set is grouped or delayed. E.g. you may batch Scene Tracker and Time Tracker together and each can be fed each other's context. They will both appear at the same time after generation, but this may take longer as more tokens are used.

**Run Companions Alongside Post-Gen Passes** starts Companions while post-generation processing is still running. This is faster, but those Companions receive the main reply before post-generation passes finish editing it. Leave this disabled when a Companion must analyze the final rewritten response.

**Helper Prefill Messages** adds reusable role-based text to helper-model requests. Blocks can begin with `[system]`, `[user]`, or `[assistant]`. Any text before the first header is treated as Assistant content. This is an advanced setting and can usually remain empty. Placing anything here may prevent models that don't accept prefills from running (e.g. Claude Opus 4.6+, Gemini 3.6 Flash and so on in the future).

**Separate Agents Between Individual and Group Chats** keeps separate enabled-agent sets for individual chats and group chats. The agents themselves are not duplicated; only their enabled state is separated.

**Allow prompt pass toast notifications** is the master switch for notifications from prompt-based post-generation passes. An individual agent’s own notification option must also be enabled. By default, this is on.

**View main LLM output before pre-generation intercept** is an advanced display option related to intercept processing. It is mainly useful while testing or debugging intercept behavior and can remain disabled for ordinary use.

**Enable Pathfinder submodule** enables or disables Pathfinder-related functionality without disabling the rest of ICA.

**Reset Bundled Agents to Defaults** restores bundled agents to their original template configuration. It does not reset custom agents. Export any bundled agent you have substantially customized before using this command.

## Agent Editor

The agent editor contains the prompt and all settings that control the agent’s behavior.

### Basic Agent Settings

**Name** is the label shown in the agent list, Companion interfaces, and related status displays. **Description** is a short explanation shown in the list. **Category** organizes the agent as a Tracker, Randomizer, Content agent, Companion, or Custom agent. Tracker classification also enables certain tracker-specific repair behavior.

**Phase** selects Pre-generation, Post-generation, or Both. It is mainly used by Inline execution to determine where the agent participates. **Execution** selects Inline or Companion behavior. Inline agents can inject, intercept, apply regex, or process the reply. Companions run separately and save notes.

**Pin to Quick Toggles** adds the agent to Quick Access so it can be found and toggled more easily.

### Prompt and Model Settings

The **Prompt** field contains the agent’s main instructions. A clear prompt should explain what information the agent should examine, what result it should produce, and what it must not do. A Companion prompt should explicitly say not to continue the roleplay when its task is analysis or tracking.

**Connection Profile** overrides the extension default for this agent’s AI refinement, intercepts, prompt-based post-generation processing, and Companion requests. **Model Override** specifies a model name instead of the profile’s configured model. Leave Model Override empty to use the model selected by the profile.

The **Preview** button shows the prompt after supported macros have been replaced. A macro is a placeholder such as `{{char}}`, `{{user}}`, or `{{random::first::second}}` that SillyBunny resolves using current chat information. Some generation stages provide additional macros for the current or original message. Preview is the best way to confirm what the LLM will parse from the agent.

**Refine** asks an AI model to rewrite or improve the prompt. Review the result before saving, especially when the prompt requires an exact tracker format. **Fullscreen** expands the prompt editor.

## Companion Settings

The Companion Settings section appears when Execution is set to Companion. Companions run after the main reply and store a separate result. The Display setting decides whether that result appears beneath the reply, in the Companion panel, or only as hidden context.

**AI Maker** creates a draft Companion prompt from a description. **Preview Feedback** shows the notes that the Companion would inject into the next main generation when feedback is enabled.

### Core Companion Options

| Option                 | Meaning                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Order**              | Controls visual ordering and sequential processing order. Lower values run earlier.                                                             |
| **Trigger**            | Selects automatic execution after matching replies or manual-only execution.                                                                    |
| **Display**            | Shows the result as a note card, in the Tracker panel, or as a hidden feedback note.                                                            |
| **Format**             | Treats the result as Markdown, safe HTML, or plain text.                                                                                        |
| **Context Messages**   | Sets the minimum number of recent valid chat messages included in the Companion request.                                                        |
| **Min Context Tokens** | Prevents automatic execution until the visible chat reaches approximately this size and can make recent-context collection extend farther back. |
| **History Depth**      | Sets how many earlier meaningful notes from the same Companion are included when Include prior notes is enabled.                                |
| **Max Tokens**         | Sets the maximum output-token request for the Companion result.                                                                                 |

**Order** is used when Companion Execution is Sequential. A Companion with Order 10 runs before one with Order 20. The drawer also displays Companions in this order, and rearranging them with the drawer’s drag handles updates the stored Order values. In Parallel mode, independent Companions may begin together, so Order does not by itself force one to finish before another. Modifying the dependency for each agent should be used when one result must wait for another. (E.g. Level Up Companion is dependent on the User-based Stats Generator agent, so Level Up Companion will show up after the latter is updated).

**Trigger** can be Auto or Manual. An Auto Companion runs after eligible replies when ICA and the agent are enabled, its conditions match, it is not hidden from automatic execution, and its minimum context threshold has been reached. A Manual Companion runs only through controls such as Play, Regenerate, Regenerate All, or the Companion dashboard.

**Display** has three choices. **Show note card** places a result beneath the assistant message it belongs to. **Tracker panel only** places its current state in the slide-out Companion panel. **Hidden feedback note** stores the result without rendering it as a card or panel section. A hidden-display result can still be used as feedback, retained context, shared Companion context, or dependency input.

> [!NOTE]
> Hidden display should not be confused with the eye button in the Companion panel. Hidden display decides where a result is shown. The eye button temporarily excludes an agent from automatic Companion runs without changing its Display setting or deleting its saved results.

**Format** adds an instruction asking for Markdown, safe HTML, or plain text. Markdown is appropriate for ordinary headings and lists. Safe HTML is intended for templates with HTML-based rendering. Plain text avoids Markdown and HTML interpretation - it is rendered as-is.

**Context Messages** controls how many recent messages the Companion receives at minimum. If the value is 10, ICA starts at the target message and walks backward through valid messages until it has collected at least ten. It does not automatically send the entire chat into its own context.

**Min Context Tokens** has two connected effects. First, an Auto Companion does not run until the visible chat has accumulated approximately the selected number of tokens. A value of 0 removes this threshold. Second, when ICA builds the recent-conversation section, it can continue collecting older messages after reaching Context Messages until it has also reached the requested token amount. Messages hidden from prompts are not counted toward this threshold.

For example, Context Messages 10 and Min Context Tokens 12000 means the Companion receives at least ten messages. If those messages contain fewer than approximately 12,000 tokens, ICA continues farther back. The automatic run also waits until the visible chat has reached approximately 12,000 tokens.

**History Depth** controls how many earlier completed notes from the same Companion are sent back to that Companion. It works only when **Include prior notes** is enabled. This allows a tracker to update an existing state rather than reconstructing it solely from the latest conversation. Empty results (e.g. tracker-none, API request failures, or manually deleted by user) are skipped so only notes with actual content are used.

**Max Tokens** is the requested maximum output tokens for the Companion’s generated output.

### Companion Context Sources

The Companion can receive several optional context sections. **Include character card** supplies descriptive card fields such as description, personality, scenario, system instructions, and creator notes. The character greeting and example dialogue are not included in this Companion section. **Include persona** supplies the active user persona. **Include World Info** performs a World Info scan and includes activated lore. **Include Author’s Note** includes the active chat or default Author’s Note. **Include System Prompt** includes the active main system prompt. (I.e. the default System Prompt field in SillyBunny.)

> [!NOTE]
> Enabling every source increases the input token size and can also expose the Companion to instructions that are irrelevant to its task. A simple state tracker may only need recent messages and its prior note. A lore analysis tool may only need the character card and World Info.

**Include prior notes** sends previous results from this Companion back into its own next request. The number is controlled by History Depth.

**Use agent prompt as-is (no added instructions)** prevents ICA from appending its normal format instruction. This is useful for trackers whose prompt already defines what *exactly* to output (e.g. The prompt itself already says "do not reproduce these specific instructions"). Companion boundary instructions still tell the model that the task is separate from the roleplay to prevent bleedthrough onto the main model, or confusing the main model with the sent agent info.

### Keeping Notes in Chat History

**Keep this agent in Chat History** places completed notes into context used by future main-model generations. This is different from Include prior notes. Include prior notes helps the Companion remember its own previous results; keeping notes in Chat History lets the main chat model receive them.

**Notes to keep** controls how many recent completed notes from this Companion are retained. **Keep all notes instead** retains every completed note from that agent. Keeping all notes can use substantial context in a long chat, particularly when each note repeats a complete state.

**Keep notes in context even when their message is hidden** retains a Companion note even when the assistant message that stores it has been hidden from prompts. Without this option, hiding the host message normally excludes its retained note as well.

### Feeding Notes Into Future Generations

**Feed recent notes into future generations** inserts completed Companion notes into later main-model prompts as auxiliary context. The notes use the agent’s Position, Depth, Role, and World Info scan settings from the Pre-Generation section.

**Feedback Depth** controls how many recent meaningful notes are injected. A value of 1 uses the latest meaningful note. A larger value includes more previous notes.

> [!NOTE]
> Feedback and retained Chat History are different mechanisms. Feedback places the note at a configured prompt position and role. Retained Chat History carries it as stored conversational context. Notes already being included through retained history are excluded from feedback collection to reduce token duplication.

### Batching Companions

**Run selected companions in one request** allows compatible Companions to share a single model request. **Batch With Enabled Companions** selects which other enabled Companions may be grouped with this one.

Selection alone does not guarantee batching. Agents need matching request settings, including connection profile, model, context configuration, and target message. Agents with incompatible settings run separately. If a batch response omits one marked result, ICA can fall back to running the missing Companion individually.

Batching reduces request count when several agents use the same model and context. It is less suitable when agents need different context or when one result must be completed before another starts.

### Passing Information Between Companions

**Send context to the following Companion Agents before generation** makes this Companion’s latest completed output available as extra prompt context to selected recipients. **Companion Agents Receiving This Context** selects those recipients.

This is useful when one agent produces state that another agent should analyze. A Scene Tracker can send its current scene state to Plot Compass, for example. Context sharing is one-directional; selecting Plot Compass as a recipient does not automatically send Plot Compass output back to the Scene Tracker.

**Re-run After These Companions Update** creates a **dependency**. When a selected Companion produces changed output, the dependent Companion reruns. **Delay until selected Companions finish** makes the dependent Companion wait when its dependency is already scheduled in the same processing pass. Without the delay option, both agents may initially run together and the dependent agent may rerun after the dependency changes.

Large dependency chains create additional requests and increase total completion time.

### Template-Specific Companion Options

Some bundled Companions add settings that do not appear on ordinary agents. Chatroom can select a preset **Chatroom Style**, define reusable custom styles in `Name: instructions` format, and use selected character cards outside the current chat as **Extra Character Reactors**. These cards are used as outside commenters rather than active scene participants.

Director’s Commentary can select a preset **Director Voice**, a randomized voice, the active narration voice, or a custom voice stored in its own `Name: instructions` library.

Plot Compass includes a **Plot Objective**. This is a direction for the Companion to consider, such as guiding the story toward a location without forcing the current scene. The objective can also be edited from the Companion panel.

## Custom Tracker Builder

Tracker agents can expose a Custom Tracker Builder. The **Tracker Format Example** field contains a sample of the exact output structure. **Rules / Behavior Notes** explain when the tracker should update, which values should be preserved, and what counts as a change. **HTML / Style Notes** describe how the extracted tracker should be presented.

**Generate Kit** asks AI to create the tracker prompt, extraction pattern, and formatting configuration. Review the generated prompt and regex before using it in an important chat, particularly when the tracker depends on exact opening and closing tags.

## Pre-Generation Settings

Pre-generation settings control how an Inline prompt or Companion feedback is placed into model context.

### Mode and Intercepts

**Inject prompt into context** adds the agent prompt directly to the normal main-model request. It does not require a separate helper request. This mode is suitable for writing rules, behavior instructions, point-of-view controls, and other prompts the main model should follow while producing its reply. This is similar to a Chat Completions' preset modularity in SillyBunny.

**Run agent to modify outgoing context** makes a separate intercept request. Intercepts are more complex and consume additional tokens, but they can transform assembled context or process generated output.

For intercept agents, **Timing** selects Pre-generation or Post-main generation. Pre-generation occurs before the main model receives the final context - this is the modular same main model prompt. Post-main generation occurs after the main model finishes its reply and before the resulting response completes the normal ICA processing path.

**Apply Mode** can be Replace context, Wrap / append, or Patch via tags. Replace expects the agent result to serve as the replacement context. For chat-completion APIs, a pre-generation replacement may need to be a valid array of role messages (System, User, Assistant, for example as the usual flow). Wrap preserves the original context and adds the intercept result before or after it (e.g. an agent that tells 'add this message after' can be used for Wrap). Patch looks for content between the configured opening and closing tags (e.g. the XML tags of  <example>Content</example> is considered by the agent.)

**Insert Position** selects whether a Wrap result goes before or after the original context. **Wrap Prefix** and **Wrap Suffix** add fixed text around the generated intercept result. **Patch Start Tag** and **Patch End Tag** define the delimiters used by Patch mode. **Max Tokens** is the requested output limit for the intercept request.

### Position, Depth, Role, Order, and World Info Scanning

**Position** selects In Prompt, In Chat, or Before Prompt. In Prompt places the agent in the normal prompt area. In Chat inserts it among chat messages. Before Prompt places it before the main prompt section.

**Depth** determines how far back an In Chat insertion is placed. A lower value places it nearer the newest conversation messages. Depth is also used when Companion feedback is enabled.

**Role** represents the inserted content as System, User, or Assistant. System is appropriate for high-level rules on providers that respect later System messages. User can be more reliable on models that weaken additional System instructions. Assistant can be useful for summaries, prefills, or content appended to the assistant message.

**Order** controls the sequence of agents that occupy comparable stages and positions. Lower values are processed first. Order determines sequence, but it does not make one instruction more important than another.

**Scan for World Info keywords** allows text in the agent prompt or feedback note to activate World Info entries. Disable it when the agent contains many terms that might trigger unrelated lore.

## Agent Regex

An agent can contain one or more SillyTavern-style regex scripts. These scripts can find, remove, replace, extract, or reformat text when the agent activates. Bundled trackers often use regex to convert structured model output into a more readable display.

**Load Bundled Regex** restores the scripts supplied with a bundled template. **Add Regex** creates another script attached to the agent. Each regex script has its own matching and replacement configuration, placement rules, depth limits, and options controlling where it runs.

Regex can alter both content and formatting. Test new scripts on expendable messages and keep a backup of your current agents before making extensive changes.

## Post-Generation Actions

**Use this agent prompt as a post-generation prompt pass** makes a separate model request after the main response is generated. In **Rewrite current message** mode, the result replaces the current response, so the agent must return the complete desired message. In **Append generated content** mode, the original response is kept and the new result is added after it.

**Max Tokens** sets the requested output limit for this post-generation call. Rewrite mode needs enough output capacity for the full replacement response. **Show toast notifications while this prompt pass runs** displays progress when both the agent option and the global notification switch are enabled.

**Run this agent’s post passes on generated impersonation text** allows the prompt pass and Agent Regex to process generated text for the user or persona side. **Run this agent’s post passes on companion agent outputs** applies those processes to completed Companion notes before they are stored.

When Companion processing is enabled, **Companion targets** limits the action to selected Companions. Leaving the selection empty targets all Companion outputs. A general prose-rewriting agent should not be applied to a strict structured tracker unless its prompt is designed to preserve that structure.

**Enable utility post-processing** activates non-model helper actions. Extract to Variable uses a regex pattern to find content and save it under a variable name. Append Text adds fixed text after the response. More complex transformations should use Agent Regex.

## Conditions

**Probability** sets the percentage chance that an otherwise eligible agent activates. A value of 100 always allows activation when the other conditions match. A value of 0 prevents automatic activation.

**Trigger Keywords** is a comma-separated list used to limit activation to matching content. Leaving it blank allows the agent to run without a keyword requirement.

**Generation Types** decide which SillyBunny actions can trigger the agent. Normal applies to ordinary assistant responses. Continue applies when extending an existing response. Impersonate applies to generated user or persona text. Quiet applies to background generations used by supported features.

## Companion Panel

The Companion panel is a slide-out drawer used by Companions whose Display setting is **Tracker panel only**. Open it by clicking the floating Companion handle or selecting **Companion Panel** from the Extensions menu.

The floating handle can be dragged to the left, right, top, or bottom edge of the viewport. It snaps to the nearest edge and saves its position. It is hidden when ICA is globally disabled, when no relevant panel Companion or stored panel state is available, or while Conversation Mode controls the interface.

Enabled panel-mode Companions can appear before they have generated a result. In that case, their section displays **No state yet**. Stored panel-mode results can also remain visible when their original agent is no longer available.

### Panel Header Buttons

| Button             | What it does                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Lock / Unlock**  | Keeps the panel open when clicking elsewhere, or restores automatic closing.                                     |
| **Regenerate All** | Runs enabled Companions on the latest valid message. This is a manual action and can include manual-only agents. |
| **Close**          | Closes the panel.                                                                                                |

When the panel is unlocked, clicking outside it closes it. Lock state is saved.

### Buttons on Each Companion

| Button              | What it does                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Drag grip**       | Reorders the Companion and saves the new Order. It also supports the Up and Down arrow keys while focused. |
| **Eye / Eye Slash** | Hides or unhides the Companion for automatic execution. It does not delete the agent or its notes.         |
| **Play**            | Runs this Companion on the latest valid reply.                                                             |
| **Regenerate**      | Reruns this Companion on the original message that owns the displayed state.                               |
| **Fix**             | Reruns the state with strict output enforcement, mainly for malformed tracker output.                      |
| **Edit Note**       | Opens the stored result for manual editing.                                                                |
| **Settings**        | Closes the panel and opens the full agent editor.                                                          |
| **Jump to Message** | Closes the panel and scrolls to the source message.                                                        |

Play and Regenerate have different targets. If the panel shows a state attached to message 42 while the chat is currently at message 50, Play runs the Companion on the latest valid message. Regenerate reruns the state on message 42. Fix also targets the source message but adds tracker repair enforcement.

The eye button hides the agent from automatic Companion execution. Hidden agents remain installed and enabled, retain their saved notes, and can still be run manually. This is separate from selecting Hidden feedback note as the Display mode.

Each section can show the agent name, source message number, estimated input and output tokens, current result, pending status, or an error. The panel also provides a short history of up to five previous states. Older entries have their own Edit Note button.

The token information pills describe the Companion request itself. Input tokens are estimated from the prompt and context sent to the Companion. Output tokens estimate the Companion’s generated result.

### Special Panel Controls

Plot Compass can display a **Plot Objective** field. Entering an objective and pressing the compass button saves it and reruns Plot Compass on the applicable message. Submitting an empty field clears the objective, though if it runs anyway, the LLM could still make up its own objective to follow.

Chat Only can display a **Private side chat** field. Sending an aside adds it to the Chat Only side transcript and reruns that Companion. It is not part of the main chat context unless you modify it to be.

Chatroom can display a **Respond to the chatroom** field. Sending a response supplies it as additional Chatroom context and reruns the Chatroom Companion. It also remains separate from the main conversation.

A completed Memory Shard can display **Hide story above this shard**. After confirmation, earlier messages are excluded from future prompts while remaining visible in the chat interface. The Memory Shard is intended to carry their summarized information forward. Hidden messages can later be restored through normal message visibility controls.

Some Companion results contain clickable choice lines. Clicking one inserts its text into the normal message input. The panel closes afterward unless it is locked.

## Companion Dashboard

The Companion dashboard is opened with **Companions** in the main ICA toolbar. It provides a management view rather than only showing the latest panel state.

The dashboard displays installed Companions together with their trigger, display, format, batching, feedback, and recent token information. Each Companion can be enabled or disabled, run on the latest message, edited, or converted back to Inline execution. Eligible Inline agents appear in a separate section and can be converted to Companion execution.

The dashboard toolbar includes **Run All on Last Message**, **Companion Panel**, **New Companion**, and **AI Maker**. It also shows recent Companion notes and can jump to the message that owns a selected note.

## Importing, Exporting, Updating, and Resetting

Import accepts agent JSON files. Imported agents may include prompts, model settings, conditions, Companion configuration, regex, and template references. Review an imported agent before enabling it because it may add model requests or modify generated messages.

Export All saves the current agent collection. Export before extensive edits, template updates, conversions, or resets.

Update All refreshes installed agents backed by newer bundled templates. ICA preserves several user-specific properties during bundled updates, including enabled state, favorites, profile overrides, model overrides, Companion configuration, and Order where applicable. Review updated prompts and regex afterward.

Reset Bundled Agents to Defaults restores template-backed agents to their bundled configuration. Custom agents are not affected.
