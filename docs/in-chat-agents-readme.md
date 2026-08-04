# In-Chat Agents

In-Chat Agents, shortened to **ICA**, add optional processing steps around a normal SillyBunny chat reply. An agent is a saved prompt together with settings that decide when the prompt is used, which model handles it, what information it receives, and what happens to its result.

Some agents simply add instructions to the normal prompt before the main model writes. Others make a separate model request to rewrite a response, produce a tracker, summarize the conversation, create suggestions, or record information for later turns. Because separate requests use additional input and output tokens, enabling more agents can increase response time and token usage.

The **main model** is the model that writes the normal, actual chat reply. Choose your **Default Connection Profile** to pick a model to use for **post-generation** trackers or **post-main intercept pre-generation trackers**.  A **Companion model** is an optional model used for **Companion Agents**. Both may use the same connection profile, but ICA also lets you assign a faster or less expensive profile to either agent.

> [!NOTE]
> Labels and behavior may change while development continues.

## Getting Started

1. Open **In-Chat Agents** from the Extensions panel and make sure the toolbar says **Agents On**. This is the master switch for ICA. Turning it off stops agents from running without changing the enabled state of each individual agent.

2. Next, open **Templates**. SillyBunny includes a library of pre-made trackers, randomizers, content agents, and Companions, but most of them are not installed automatically. Choose any agent, click/tap it to install it, and enable it in the agent list. Start with one agent first to make it easier to see what that agent changes and whether its model connection works.

3. If the agent makes a separate model request, it needs a working connection profile. The **Default Connection Profile** is used when an agent does not have its own set override. Companion agents can instead use the **Companion Connection Profile**, allowing normal chat replies and background notes to use different models.

4. After enabling the agent, send a normal chat message. An Inline agent may change the prompt or the final assistant response. A Companion agent stores a separate note. Depending on its Display setting, that note may appear beneath the assistant reply, inside the slide-out Companion panel, or remain hidden for use as future context.

## How ICA Fits Into Chat Generation

SillyBunny normally collects the system prompt, character information, persona, World Info, Author’s Note, and recent chat messages into a model request. This collected information is called the **context**. The main model reads that context and generates the next assistant response.

ICA can participate at several points in this process. A **pre-generation** agent can insert additional instructions before the main request; think of this as a modular prompt you would usually see in a Chat Completions preset. An **intercept** agent can make a separate request to transform context or process the main output. A **post-generation agent** can rewrite the completed response, append more generated text, extract information, or apply regex formatting. Companion agents run as separate side tasks and save their own results, based on the current chat file, without directly replacing the assistant message.

Not every agent uses every stage. A simple writing-rule agent may only inject a few lines into the main prompt. A relationship tracker may run after every reply as a Companion. A prose editor may make a second model request and replace the original response with its edited version.

An agent can therefore affect cost in different ways. **Pre-generation** prompt injection adds text to the main request but does not make a separate request. Intercepts, AI refinement, post-generation prompt passes, and Companions normally make additional requests.

## Inline and Companion Execution

An **Inline agent** participates directly in the main response pipeline. It can inject instructions, intercept context, rewrite the assistant response, append generated content, apply regex, or extract structured text. Use Inline execution when the agent is supposed to be used at the same context with the main model. E.g. the scene tracker as an inline agent is considered as instructions for the main model itself to place into its reply.

A **Companion agent** runs separately and saves a note on the message it analyzed. It can maintain trackers, summarize events, produce commentary, suggest possible directions, record character state, or pass information to another Companion. Companion execution never directly replaces or edits the assistant message.

For example, an Inline prose agent could rewrite a reply to remove repetition. A Relationship Companion could read the same reply and separately record that trust between two characters decreased. The prose agent changes the message, while the Relationship Companion stores information about it. This Companion Agent is then sent to the main LLM.

## Templates

The Templates browser contains pre-made agents with prompts and settings already configured. Available templates include trackers for scene state, time, relationships, reputation, events, items, status, choices, achievements, and other information. It also includes randomizers and Companion tools such as continuity notes, relationship analysis, Plot Compass, Chatroom, Chat Only, Director’s Commentary, Memory Shard, and other sidecar agent features.

Some templates are also available in groups. A group installs or activates several related agents together. Groups are useful after you understand how the individual agents behave, but enabling a large group immediately can create many model requests and make troubleshooting difficult.

Installed bundled agents can later receive template updates. Custom agents can be created with **New Agent** and are not affected by the command that resets bundled agents.
