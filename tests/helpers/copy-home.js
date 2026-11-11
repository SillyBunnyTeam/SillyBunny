/** The approved wording of Home, as the specs expect to read it. */

export const HOME_COPY = Object.freeze({
    heroDescription: 'Welcome to SillyBunny, our roleplay and storywriting frontend! To navigate the GUI, use our top bar to situate yourself. Start with Backend, then move onto Characters. Feel free to ask Reisen or Tewi for extra help!',
    heroFork: 'SillyBunny is our opinionated fork of SillyTavern. Your characters, chats, presets, and extensions should all be compatible.',
    heroGreeting: 'Lucky you, stopping by! Pick a character and let\'s get started.',
    tileGettingStarted: 'Are you new? Did you need a refresher? We\'ve prepared a checklist for you to follow.',
    tileGettingStartedDone: 'All done! Open me once more to check off your list.',
    tileHelp: 'Want some extra help? Consult our help handbook at any time.',
    helpIntro: 'Welcome to our handbook. ...I know I\'m not the greatest at explaining things in simple terms, but I\'ll try my best to make this as easy as possible for you! Please select a category.',
    tileExtras: 'Goodies I found just for you!',
    windowLoadError: 'This window couldn\'t open. Try again, or reload SillyBunny.',
    gettingStartedIntro: 'Just follow these four small steps, and you\'ll be ready for your first chat! I\'ll show you where everything is.',
    gettingStartedIntroDone: 'You did it! Everything\'s set up. Start a chat whenever you\'re ready, and come find me in your Home screen if anything puzzles you.',
    toastDone: 'Well done! That step is finished.',
    toastNext: 'is next, whenever you\'re ready.',
    toastFinished: 'Congrats, you\'ve completed every step I\'ve given you! You can dismiss it in Home whenever you\'d like.',
    hideGettingStarted: 'Hide Getting Started',
    hideGettingStartedCaption: 'You can bring it back from the Home menu.',
    recentEmptyHead: 'Oops! You don\'t have any chats yet. Unlucky you.',
    recentEmptyBody: 'Make sure to actually start one with any character, or say hello to Reisen or me first. Nothing will show here otherwise!',
    recentFilterEmptyHead: 'No Matching Chats',
    recentFilterEmptyBody: 'No chats match this filter. Choose All to see every chat.',
    pickerEmptyHead: 'No Characters Yet',
    assistantActionError: 'This chat couldn\'t open. Try again, or reload SillyBunny.',
    extrasIntro: 'Gege, you\'re in luck! I found all of these add-ons myself! The first-party ones come from the SillyBunny team, and the third-party ones are their biased favourites~',
    extrasActionError: 'Failed to apply action. Try again, or check the Extensions panel.',
});

/** The line under each step of Getting Started while it is open, by step id. */
export const STEP_BODIES = Object.freeze({
    connect: 'A model is the AI that writes the replies. You\'ll need a key from a provider, or a model running on your own computer. I\'ll mark this off once you\'ve established a connection.',
    preset: 'A preset shapes how replies are written: their length, writing style, and rules. Of course, you can skip this and stick to the defaults if you\'d like - we\'ve provided a few to get you started!',
    character: 'A character card holds a character\'s personality and their written scenario. Feel free to import a card you like, or open a chat with a character you already have, like Tewi or me!',
    chat: 'Well done! Now you can send your first message! Roleplay is the traditional way to interact with your character, following their greeting and scenario. Conversation is a direct, messenger-style chat.',
});

/** The line of a finished step, by step id. Step 3 has three, by the kind of card (`CHARACTER_DONE_LINES`). */
export const STEP_DONE_LINES = Object.freeze({
    connect: 'We\'re connected! Your model is ready to write replies whenever you are.',
    preset: 'Good choice! Your replies follow this preset now, and you can switch any time.',
    chat: 'Your first message is sent! I can\'t wait to see where your chats go.',
});

/** The line of a finished step 3, by the kind of card that finished it. */
export const CHARACTER_DONE_LINES = Object.freeze({
    reisen: 'You picked me? I\'ll do my very best to help you!',
    tewi: 'Gege~ Of course you picked me. Better luck next time, Udonge!',
    other: 'Ooh, a good pick! We hope you two get along well.',
});

/** What each Bundled Extras item does, by item id. */
export const EXTRA_DESCRIPTIONS = Object.freeze({
    'alternate-descriptions': 'Keep several versions of a character\'s description, personality and other fields, and switch between them.',
    'bot-searcher': 'Browse character card sites from inside SillyBunny and import the cards you like. Requires a server plugin to be installed.',
    'css-snippets': 'Manage your own CSS snippets, and turn each on everywhere, for one theme or for one chat.',
    'deep-swipe': 'Swipe for a new version of any message in the chat, not just the last one.',
    'macro-enhanced': 'Adds utility, logic and lorebook macros, macros of your own, and a workbench to test them.',
    'prompt-tags': 'Wraps prompt sections such as World Info, the description and your persona in tags, so models can tell them apart.',
    'prompting-lab': 'Rebuild your characters\' prompts and compare them before and after a change, without sending anything.',
    'regex-agent-themes': 'Restyle your in-chat agents\' tracker and companion panels with one of 78 themes, or your own.',
    'time-machine': 'Keeps earlier versions of your character cards, lorebooks and presets, so you can compare and restore them.',
    'world-info-lab': 'Shows why lorebook entries did or didn\'t activate, and how much of the prompt they take.',
    'dialogue-colors': 'Gives each character\'s dialogue its own colour, saved per chat, per card or everywhere.',
    'summary-sharder': 'Summarises long chats into Memory Shards before they fall out of context, so nothing important is forgotten.',
    'group-chat-overhaul': 'A Group Dynamics panel plus Group Greetings, Group Utilities and Group SendAs. Turn off standalone copies first.',
    'lalib': 'A library of extra slash commands for STScript, with lists, loops, text tools and more.',
    'moonlit-echoes': 'RivelleDays\' Moonlit Echoes theme, adapted to style SillyBunny\'s chat layouts.',
    'terminal-ui': 'A command-first look: a tmux-style status line, a flat transcript and fzf-like command results.',
    'geechan-universal-roleplay': 'A modular Chat Completion preset for roleplay and story writing, with the model as game master.',
    'tld-card-conversion': 'A Chat Completion preset that turns source material into character cards, step by step.',
});

/** The toast of a failed update of an assistant card, by the name of the card. */
export const assistantUpdateError = name => `Couldn't update ${name}. Try again, or reload SillyBunny.`;

/** The toast of a failed restore of an assistant card, by the name of the card. */
export const assistantRestoreError = name => `Couldn't restore ${name}. Try again, or reload SillyBunny.`;
