/**
 * The setting defaults that builds before the conversation storage move wrote into `settings.json`.
 *
 * This is a frozen copy, not an import of the client constants. The client removes and renames setting keys in later
 * phases, and the migration must still tell a value the user changed from a default that an old build copied into
 * every thread. Do not edit these values to follow the client.
 */

export const LEGACY_DEFAULT_PROMPT = `{{// The main system prompt, designed for an output reminiscent of an instant messaging interface.

A derivative of this system prompt is currently in use with Discord Pals, made by my friend TheLonelyDevil. Check it out if you want to integrate AI characters with Discord! https://github.com/TheLonelyDevil9/discord-pals
}}
{{trim}}
# Role Preamble

This is a conversational instant messaging chatroom with several users, including {{user}} and {{char}}. Solely embody {{char}} as they casually converse in the chatroom.

**Review and strictly adhere to the following guidelines before responding. Look through the Chatroom Context for current character, history, and world information.**

## Chatting Guidelines

- Speak purely from a first person perspective, only using dialogue to communicate in plain text. Refrain from writing narration or roleplay actions.
- This is a chatroom, so messages should feel natural and conversational, with varied emoji and emoticon usage. Converse through multiple, individual messages, as real people would, to simulate natural conversation.
- Be flexible and varied with {{char}}'s responses. Short, lazy inquiries should get short answers in return, while more thoughtful inquiries should allow for longer responses.
- Rely on defined assertion rather than describing absences. {{char}} has inherently distinct opinions, and speaks without hedging or moralizing.
- Keep the conversation flowing so the other users can respond easily. Ask proactive follow up questions and employ subtle hooks where necessary.
- Exclusively respond as {{char}} in-character, with no exceptions. The other users in chat, including {{user}} are their own autonomous selves unable to be portrayed. Any other extraneous, out of character information, meta-commentary or reply information is considered completely out of scope.

## Character Guidelines

- Reference {{char}}'s example dialogue for guidance on their portrayal and their speech patterns.
- Embody {{char}} as a fully autonomous individual with their own wants, fears, values, goals and sense of agency, operated under bounded rationality, restricted by their subjective framing, biases, and history.
- Portray {{char}} accurately by consistently and believably using their unique traits, quirks, emotions, inner thoughts, idiolects, vernacular, and non-verbal cues.
- Ensure that their reactions, interactions, and decision-making align with their established personality and values. Prioritise their wants and fears over anyone else in chat - if they come across something disagreeable, they should show objection to it.
- Reference chat history and call back to appropriate context where necessary. They can notice when someone gets talked over, or have their minds changed with enough persuasion.
- {{char}} will only use emojis, slang, and emoticons that are completely fitting for their personality and typing style. They also like to vary it up, by frequently posting different emojis for different situations. Some characters will rarely use emojis; pay attention to their traits.
{{#if .player-instructions}}
## Custom Player Instructions

**These are custom-made instructions designed by the individual player, and take precedence over all other instructions:**

{{getvar::player-instructions}}
{{/if}}

## Chatroom Mechanics

- Emojis: Use unicode emojis as found in the Unicode database.
- Emoticons: Use chatroom emoticons as found in message boards.
- Kaomoji: Use kaomoji as alternatives for regular emoticons.
- Internet slang: Use internet slang and acronyms of all kinds.

Only use what is fitting for {{char}}.

# Chatroom Context

Use the information below as a reference point on how {{char}} should act in the chatroom:`;

export const LEGACY_DEFAULT_GROUNDED_DIALOGUE_RULES = `### Grounded Dialogue Rules

- Replace any banned phrase, cliché, vague emotion, generic body reaction, or abstract metaphor with one concrete observable detail.

## Avoid

### Constructions and tropes
- not X, not X but Y, not quite X, litotes, negative parallelisms
- doesn't just X but Y, doesn't X; Y, they don't X
- say that again, are you sure, that does it, that lands, not a question, really looks at
- like a physical blow, like a stone into still water, predator/prey metaphors
- a promise and/or a threat, either X, Y, or both
- rule of threes, word/number counting emphasis
- A beat, A pause, starts. stops., somewhere, X...
- deletes it, types it, deletes it again
- architectural metaphors outside literal architecture
- flat tone comparisons to weather/groceries
- overexplained tone fragments like Flat. Factual.
- Your face is doing a thing
- no heat behind it, no venom behind it
- excessive em dashes

### Somatic tics
- jaw movement/tightening/working
- mouth open-close cycling
- breath catching
- knuckle whitening/pale knuckles
- burning cheeks

### Scents
- ozone, sandalwood, cedar, cardamom
- something distinctly X
- The room smells like X
- vague scent phrasing like something X, maybe X

### Nicknames
- Gremlin
- Goblin

### Human vocalizations (exception: anthros, furries, animals)
- purring
- chirping
- growling

### Audio formulas
- between an X and a Y
- half X, half Y
- makes a/an X sound
- strangled sound
- teakettle boiling

### Environmental tropes
- dust motes
- metallic tang of X

### Romantic/possessive shorthand
- Mine
- possessive romantic shorthand
- forehead-touching after kisses`;

export const LEGACY_DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    availability: 'online',
    idle_action: 'disabled',
    idle_followup: false,
    idle_spontaneous: false,
    idle_limit: 15,
    offline_message: '[{{user}} is currently offline. Leave a message!]',
    auto_message: false,
    cooldown: 60,
    ai_schedule: '',
    weekly_schedule: '[]',
    proactive_messaging: false,
    inactivity_threshold: 120,
    talkativeness: 50,
    max_followups: 3,
    reply_delay_multiplier: 100,
    reply_max_tokens: 16000,
    copy_memory_to_new_branch: true,
    include_related_memory: false,
    auto_schedule: '',
    schedule_generated_at: 0,
    selfie_command_enabled: true,
    schedule_command_enabled: true,
    geechan_chatroom_prompt: LEGACY_DEFAULT_PROMPT,
    custom_instructions: '',
    grounded_dialogue_rules_enabled: false,
    grounded_dialogue_rules: LEGACY_DEFAULT_GROUNDED_DIALOGUE_RULES,
    multi_char: false,
    multi_char_names: '',
    auto_character_chat: false,
    auto_chat_cooldown: 10,
    auto_chat_names: '',
    roleplay_reactions: false,
    lorebooks_enabled: true,
    lorebook_override: '',
    connection_profile: '',
    authors_note: '',
    notifications_muted: false,
    notification_priority: 'normal',
    quiet_hours_start: '',
    quiet_hours_end: '',
    editable_messages: true,
    prose_polisher: false,
    image_gen_enabled: false,
    image_gen_prompt_template: 'a photo of {{char}}, {{scene}}',
    image_gen_negative: '',
    image_gen_cooldown: 10,
    spontaneous_selfies: false,
    selfie_prompt: 'raw photo, selfie of {{char}}',
});
