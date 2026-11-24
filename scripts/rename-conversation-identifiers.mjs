#!/usr/bin/env node

// Renames the internal identifiers of conversation mode to the terms of the conversation rework
// (plan S1): conversation, member, chat, list. It has two modes so that the rename can be
// reviewed before it touches a file:
//
//   inventory  scans the scope, proposes a new name for every identifier that holds an old stem,
//              and writes the map as rename-map.md (for people) and rename-map.json (for `apply`).
//   apply      reads the reviewed rename-map.json, checks that a new scan gives the same map, then
//              moves the files with `git mv` and rewrites the names. It never commits.
//
//   node scripts/rename-conversation-identifiers.mjs inventory --out <dir>
//   node scripts/rename-conversation-identifiers.mjs apply --map <dir>/rename-map.json [--include-stored]
//
// A name in the stored table is a property or a value in stored data. It keeps its name in the
// commit that applies this map, because the storage switch writes the new name together with the
// new reader and so every commit keeps the app working on existing data. `--include-stored` renames
// those names too and is for the storage tasks.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The script quotes the old names in its tables and must not rename them.
const SCRIPT_PATH = 'scripts/rename-conversation-identifiers.mjs';

/**
 * Scope
 */

const PRIMARY_PATTERNS = [
    /^public\/scripts\/sillybunny-conversation\//,
    /^public\/scripts\/sillybunny-conversation\.js$/,
    /^public\/css\/sillybunny-conversation\.css$/,
];

// Places that may refer to the names of the primary files. Whether a file in them is in scope
// depends on its content, see `collectScope`.
const SECONDARY_ROOTS = [/^public\//, /^tests\//, /^scripts\//, /^LESSONS\.md$/, /^docs\/upstream-touch-ledger\.md$/];

// Vendored code is out of scope by the brief; the locale files hold no identifier of this mode.
const OUT_OF_SCOPE_PATTERNS = [
    /^public\/lib\//,
    /^public\/scripts\/extensions\/third-party\//,
    /^public\/scripts\/extensions\/quick-image-gen\//,
    /^public\/locales\//,
];

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|zip|7z|mp3|ogg|wav|mp4|webm|pdf|gz|bin|jar|apk|wasm|model)$/i;

// Task 1T rewrites or deletes these. They import names from renamed client modules, so only the
// imported names and the module paths change in them, and only so that the server still starts.
const SERVER_IMPORTER_PATTERN = /^src\/endpoints\/(?:sillybunny-conversation|conversation-[\w-]+)\.js$/;

const CLIENT_MODULE_PATH = /public\/scripts\/sillybunny-conversation(?:\/[\w.-]+)?/;

// A test or helper that mentions a server route or module tests code that task 1T rewrites, so the
// names it uses for that code belong to the server and stay.
const SERVER_MODULE_REFERENCE = /(?:src\/)?endpoints\/(?:sillybunny-)?conversation[\w-]*(?:\.js)?|\/api\/sillybunny-conversation\S*/g;

const CLIENT_REFERENCE = /sillybunny-conversation\/|sillybunny-conversation\.(?:js|css)|sb[-_]conversation|sb_conv_|sb-conv-|data-sb-conversation|sbConversation/;

// A test whose name has this word exercises conversation mode; its own bare locals (`thread`,
// `branch`) are renamed with the rest.
const CONVERSATION_FILE_NAME = /conversation/;

// A test that mentions both the client modules and the server routes. `bindings` renames only the
// names that the file imports from a client module (the REST tests, which 1T replaces). `except-server-imports`
// renames everything but the names in an import from a server module. `expected-source` renames
// what an assertion says about a client source file that the test read.
const MIXED_FILE_POLICY = {
    'tests/sillybunny-conversation-api.test.js': 'bindings',
    'tests/sillybunny-conversation-backend-save.test.js': 'bindings',
    'tests/sillybunny-conversation-key-compatibility.test.js': 'except-server-imports',
    'tests/conversation-mode-scoped-profile.test.js': 'expected-source',
};

/**
 * Names
 */

const STEMS = ['pals', 'pal', 'dms', 'dm', 'partners', 'partner', 'branches', 'branch', 'threads', 'thread'];
const STEM_SET = new Set(STEMS);

// S1 of the plan. `pals rail` is a phrase of its own: the rail is the conversation list.
const PHRASES = [
    { from: ['pals', 'rail'], to: ['conversation', 'list'] },
];

const SEGMENT_MAP = {
    pals: 'list',
    pal: 'conversation',
    dms: 'conversations',
    dm: 'conversation',
    partners: 'members',
    partner: 'member',
    branches: 'chats',
    branch: 'chat',
    threads: 'conversations',
    thread: 'conversation',
};

const IDENTIFIER_RUN = /-{0,2}[A-Za-z_$][A-Za-z0-9_$-]*/g;

/**
 * Splits a name into words and the separator that precedes each word.
 * @param {string} token Name
 * @returns {{text: string, separator: string}[]} Words
 */
function splitWords(token) {
    const words = [];
    const lead = token.match(/^-+/)?.[0] ?? '';
    let separator = lead;
    for (const piece of token.slice(lead.length).split(/([_-]+)/)) {
        if (!piece) {
            continue;
        }
        if (/^[_-]+$/.test(piece)) {
            separator = piece;
            continue;
        }
        const camel = piece.replace(/([a-z0-9])([A-Z])/g, '$1\0$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2').split('\0');
        camel.forEach((text, index) => {
            words.push({ text, separator: index === 0 ? separator : '' });
        });
        separator = '';
    }
    return words;
}

function hasStem(token) {
    return splitWords(token).some(word => STEM_SET.has(word.text.toLowerCase()));
}

/**
 * @param {string} token Name
 * @returns {'single'|'camel'|'snake'|'kebab'|'mixed'} The way the name is written
 */
function shapeOf(token) {
    if (splitWords(token).length === 1) {
        return 'single';
    }
    const hyphen = /[A-Za-z0-9]-[A-Za-z0-9]/.test(token);
    const underscore = /[A-Za-z0-9]_[A-Za-z0-9]/.test(token);
    if (hyphen && underscore) {
        return 'mixed';
    }
    return hyphen ? 'kebab' : underscore ? 'snake' : 'camel';
}

function isScreaming(token) {
    return /[A-Z]/.test(token) && token === token.toUpperCase();
}

function matchCase(replacement, original, screaming) {
    if (screaming) {
        return replacement.toUpperCase();
    }
    return /^[A-Z]/.test(original) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

/**
 * The mechanical proposal of S1: each old stem is replaced by its new stem, `pals rail` by
 * `conversation list`, and a word that a replacement repeats next to itself is dropped.
 * @param {string} token Name that holds a stem
 * @returns {string} The proposed name
 */
function mechanicalName(token) {
    const words = splitWords(token);
    const screaming = isScreaming(token);
    const result = [];
    for (let index = 0; index < words.length; index++) {
        const phrase = PHRASES.find(candidate => candidate.from.every((part, offset) => words[index + offset]?.text.toLowerCase() === part));
        if (phrase) {
            phrase.to.forEach((target, offset) => {
                const source = words[index + Math.min(offset, phrase.from.length - 1)];
                result.push({ text: matchCase(target, source.text, screaming), separator: source.separator, replaced: true });
            });
            index += phrase.from.length - 1;
            continue;
        }
        const lower = words[index].text.toLowerCase();
        if (STEM_SET.has(lower)) {
            result.push({ text: matchCase(SEGMENT_MAP[lower], words[index].text, screaming), separator: words[index].separator, replaced: true });
            continue;
        }
        result.push({ ...words[index], replaced: false });
    }
    const collapsed = [];
    for (const word of result) {
        const previous = collapsed[collapsed.length - 1];
        if (previous && (word.replaced || previous.replaced) && previous.text.toLowerCase() === word.text.toLowerCase()) {
            continue;
        }
        collapsed.push(word);
    }
    return collapsed.map(word => word.separator + word.text).join('');
}

/**
 * Decisions that need reading of the code
 */

/**
 * A name that is a property or a value in stored data keeps its name in the commit that applies the
 * map. `next` is the name that the storage switch writes; `null` means the stored name goes away.
 * @type {Record<string, {next: string|null, why: string}>}
 */
const STORED_TOKENS = {
    activeBranchId: { next: 'activeChatId', why: 'Property of every stored conversation entry (`extension_settings.sillybunny_conversation.characters[key]`). S2.3 writes `activeChatId`.' },
    branches: { next: 'chats', why: 'Property of every stored conversation entry: the map of chats. S2.3 writes `chats[]`. The 29 local variables of this name rename with it.' },
    legacyThreadPersonaAssignments: { next: null, why: 'Top-level store property. S2.6 step 5 removes it from `settings.json` after the migration.' },
    partner_avatar: { next: 'member_avatar', why: 'Message `extra` property in stored chats (S1).' },
    copy_memory_to_new_branch: { next: null, why: 'Per-conversation setting key that has no effect. Removed in Phase 5 (S5.6).' },
    sb_conv_copy_memory_to_new_branch: { next: null, why: 'DOM id of the hidden control that mirrors the setting key. It goes with the key.' },
    conversation_branch_id: { next: 'conversation_chat_id', why: 'Field of a Home recent chat and of a pinned chat (`PinnedChat`), which the Home pins persist. S2.8 moves the pins to the conversation id.' },
    conversation_branch_name: { next: 'conversation_chat_name', why: 'Field of a Home recent chat, next to `conversation_branch_id`.' },
    _branch_: { next: null, why: 'Infix of the Home pin key `conversation_<owner>_branch_<id>` (`welcome-screen.js`), a stored value. S2.8 replaces the pin key.' },
    missing_branch: { next: 'missing_chat', why: 'Stored value of `reminder.invalidReason`.' },
    sb_conv_thread_: { next: null, why: 'Prefix of the legacy localStorage keys that the one-time browser migration reads. The old name must stay readable.' },
};

/**
 * Names that are stored at a few sites and are an internal name everywhere else. Every use is
 * renamed except the stored sites, which keep the old spelling. A stored site is a member access on
 * one of the owners, or a property in an object literal that holds one of the marker keys (the
 * shape of a stored object), or a destructuring of one of the owners. A stored object built with
 * the shorthand `{ branchId }`, or read with `const { branchId } = reminder`, is written out as
 * `{ branchId: chatId }` so that the stored property keeps its name.
 * `calls` names the functions whose first argument is a stored object.
 * @type {Record<string, {next: string, owners: string[], literalMarkers: string[], calls: string[], why: string}>}
 */
const STORED_SITE_RULES = {
    branchId: { next: 'chatId', owners: ['reminder', 'rem'], literalMarkers: ['triggerAt'], calls: ['resolveConversationReminderBranchId'], why: 'Property of a stored reminder (`reminders[].branchId`), written in `thread-store.js` and `auto-engine.js` and read in `thread-store-utils.js`.' },
    threadAvatar: { next: 'anchorAvatar', owners: ['threadStore', 'targetStore'], literalMarkers: ['activeBranchId', 'branches'], calls: [], why: 'Property that `context.js` writes to every stored conversation entry. S2.3 does not keep it; `characters` holds the avatars.' },
};

/**
 * Stored names that hold no old stem, so the scan does not find them, and that the plan renames,
 * moves or dissolves. They are here so that tasks 1T and 1U have one list.
 */
const STORED_NAMES_WITHOUT_STEM = [
    { old: 'geechan_chatroom_prompt', next: 'system_prompt', why: 'Per-conversation setting key (S1, S5.6). The migration maps it.' },
    { old: 'multi_char_names', next: 'extras', why: 'Per-conversation setting key, the CSV of additional members (S2.3 `extras`, removable only).' },
    { old: 'characters (store field)', next: 'one `conversations/<id>/conversation.json` per entry', why: 'The map of thread key to conversation entry in `settings.json` (S2.2, S2.6).' },
    { old: 'groups (store field)', next: 'conversations with `kind: group`', why: 'Conversation-owned group records (S2.3).' },
    { old: 'reminders (store field)', next: '`reminders[]` in each `conversation.json`', why: 'S2.3.' },
    { old: 'group `members`', next: '`characters`', why: 'Avatar file names of a group (S2.3).' },
    { old: 'group `conversation_settings`, `is_conversation_group`', next: '`settings`, `kind: group`', why: 'S2.3.' },
    { old: 'memory fields of an entry and of a chat (`memorySummary`, `memoryMessageCount`, `memoryUpdatedAt`)', next: '`chat_metadata.sb_conversation` of each chat file', why: 'S2.4.' },
    { old: 'message `role: \'partner\'`', next: '`role: \'member\'`', why: 'S1. The string values stay in code and tests in this commit.' },
];

/**
 * Names that S1 keeps, that only look like a stem, or that belong to something else. Visible wording
 * (labels, titles, accessible names, toasts, prompts) is not listed per name: it is counted by word.
 * @type {Record<string, string>}
 */
const KEPT_TOKENS = {
    'fa-code-branch': 'FontAwesome icon class, not a branch of a conversation',
    mes_create_branch: 'Upstream class of the message button "Branch from Here"',
    'branch-from-message': 'Id of the action "Branch from Here"; S1 keeps the action name and the word is a verb',
    branchConversationFromMessage: 'The action "Branch from Here"; branch is a verb',
    'branch-create': 'Upstream slash command `/branch-create`',
    swipe_picker_branch: 'Upstream swipe picker class',
    extension_branch_name: 'Git branch field of the extension installer',
    'sb-branch-select': 'Git branch select of the server admin page',
    'sb-branch-select$': 'Git branch select of the server admin page',
    'switch-branch': 'Server admin route for git branches',
    switchBranchOptions: 'Git branch switching of the server admin page',
    'about-branch': 'Git branch row of the About window',
    'label-by-branch': 'GitHub workflow name',
    'pr-auto-labels-by-branch': 'GitHub workflow file',
    'base-branch': 'Git term',
    'main-thread': 'Browser main thread (a Settings description)',
    'data-conversation-branch-id': 'Attribute of the Home recent-chat rows (`sillybunnyHome.html`, `recent-chat.js`, `welcome-screen.js`); the Home code owns it and S2.8 changes the pins',
    conversationThreadOpened: 'Method of the Home getting-started signals; Home-owned, called from `getting-started-boot.js`',
    'discord-pals': 'Name of the Discord Pals project in a system prompt',
};

/**
 * Names that are compound and sit in strings, comments or text, and that are not identifiers of
 * the code: test titles, test ids and error codes of the server routes.
 */
const PROSE_LIKE_TOKENS = new Set([
    'same-thread', 'different-thread', 'thread-level', 'branch-a', 'branch-b', 'branch-1', 'branch-a-message', 'branch-b-message',
    'alpha-branch', 'beta-branch', 'alpha-branch-message', 'beta-branch-message', 'deleted-branch', 'partner-message',
    'invalid_branch_id', 'invalid_branches', 'unsafe_thread_key', 'branch_2',
]);

/**
 * Compound names in strings that are ids of actions, pages, events, surfaces or mock values, not
 * styled words. They are accepted as references wherever they occur.
 */
const DATA_VALUE_TOKENS = new Set([
    'add-character-dm', 'delete-dm', 'open-add-dm', 'choose-dm', 'add-dm-no-matches', 'close-pals', 'toggle-pals', 'pals-toggle',
    'pals-empty', 'new-branch', 'rename-branch', 'delete-branch', 'select-branch', 'open-branch-menu', 'conversation-thread-opened',
]);

/**
 * Names in code of tests and helpers that no primary file holds. The table lists them because the
 * rename has to move them with the surfaces and specs that use them.
 */
const TEST_ONLY_TOKENS = new Set([
    'ADD_DM_EMPTY', 'PALS_EMPTY', 'THREAD_EMPTY', 'THREAD', 'THREAD_INDEX', 'BRANCH_NAMES', 'addConversationBranches', 'branchMessage',
    'branchMessageId', 'showMainThread', 'startThread', 'conversationAddDmNoMatches', 'conversationChooseDm', 'conversationPalsEmpty',
    'palsRailSource', 'partnersSource', 'partnerMessage', 'persistedThread', 'personaAThreadKey', 'threadKeys', 'threadMessages',
    'threadStoreSource', 'makeThread', 'branchA', 'branchB', 'getBackendThreadKey', 'getBrowserThreadKey', 'threadIndex',
]);

/**
 * Proposals that replace the mechanical name. `decided` is a name that S1 states, `proposed` is a
 * name that the plan leaves open or that the mechanical name would break.
 * @type {Record<string, {next: string, status: 'decided'|'proposed', why: string}>}
 */
const NAME_OVERRIDES = {
    'add-character-dm': { next: 'start-direct-conversation', status: 'decided', why: 'S1 example' },
    createConversationBranchForAvatar: { next: 'createConversationChat', status: 'decided', why: 'S1 example' },
    createConversationBranch: { next: 'buildConversationChat', status: 'decided', why: 'The mechanical name is the S1 name of `createConversationBranchForAvatar`. This one builds the chat object and creates nothing in the store' },
    threadAvatar: { next: 'anchorAvatar', status: 'decided', why: 'The avatar of the character whose conversation entry it is; the anchor character of a group' },
    getConversationThreadStore: { next: 'getConversationRecord', status: 'proposed', why: 'The mechanical name `getConversationStore` is the existing accessor of the whole store in `context.js`' },
    threadStore: { next: 'conversationRecord', status: 'proposed', why: 'Follows `getConversationRecord`; `conversationStore` would read as the whole store' },
    threadStoreHasConversationUsage: { next: 'conversationRecordHasUsage', status: 'proposed', why: 'Follows `conversationRecord`; the mechanical name repeats `conversation`' },
    threadStoreSource: { next: 'conversationStoreSource', status: 'decided', why: 'Test variable that holds the text of `thread-store.js`, which S1 renames to `conversation-store.js`' },
    getConversationThread: { next: 'getConversationMessages', status: 'proposed', why: 'It returns the message list of a chat; the mechanical name `getConversation` would not say that' },
    saveConversationThread: { next: 'saveConversationMessages', status: 'proposed', why: 'It saves the message list of a chat' },
    saveConversationMessageThread: { next: 'saveConversationContextMessages', status: 'proposed', why: 'It saves the message list of a message context' },
    safeParseThread: { next: 'safeParseMessages', status: 'proposed', why: 'It parses a stored message list' },
    getConversationThreadCount: { next: 'getConversationMessageCount', status: 'proposed', why: 'It counts messages; no caller exists' },
    targetThread: { next: 'targetMessages', status: 'proposed', why: 'A message list' },
    isConversationActiveThread: { next: 'isConversationActive', status: 'proposed', why: 'The mechanical name repeats `conversation`' },
    isThreadActive: { next: 'isActive', status: 'proposed', why: 'The mechanical name is the name of the function that it calls (`isConversationActive`) in the same file' },
    isSameConversationQueueThread: { next: 'isSameQueueConversation', status: 'proposed', why: 'The mechanical name repeats `conversation`' },
    getConversationGroupThreadAnchor: { next: 'getConversationGroupAnchor', status: 'proposed', why: 'The mechanical name repeats `conversation`' },
    buildConversationRenderThreadKey: { next: 'buildConversationRenderKey', status: 'proposed', why: 'The mechanical name repeats `conversation`' },
    getConversationPals: { next: 'getDirectConversations', status: 'proposed', why: 'It lists the characters with a direct conversation' },
    pals: { next: 'conversations', status: 'proposed', why: 'A list of rail items, not the rail' },
    remainingPals: { next: 'remainingConversations', status: 'proposed', why: 'S1 maps `pal` to `conversation`' },
    palsList: { next: 'listItems', status: 'proposed', why: 'The mechanical name `list` collides with the rail and says nothing; the element holds the rows' },
    sb_conversation_pals_list: { next: 'sb_conversation_list_items', status: 'proposed', why: 'The mechanical name is the new id of the rail (`sb_conversation_list`)' },
    'sb-conversation-pals-list': { next: 'sb-conversation-list-items', status: 'proposed', why: 'The mechanical name is a class that S1 would give to the rail' },
    'sb-conversation-pal': { next: 'sb-conversation-list-item', status: 'proposed', why: 'The mechanical name `sb-conversation` is the name of the whole mode' },
    'sb-conversation-pal-row': { next: 'sb-conversation-list-row', status: 'proposed', why: 'The mechanical name is too general' },
    'sb-conversation-pal-avatar': { next: 'sb-conversation-list-item-avatar', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-copy': { next: 'sb-conversation-list-item-copy', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-kind': { next: 'sb-conversation-list-item-kind', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-name': { next: 'sb-conversation-list-item-name', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-name-row': { next: 'sb-conversation-list-item-name-row', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-preview': { next: 'sb-conversation-list-item-preview', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'sb-conversation-pal-unread': { next: 'sb-conversation-list-item-unread', status: 'proposed', why: 'Child of `sb-conversation-list-item`' },
    'open-add-dm': { next: 'open-start-direct-conversation', status: 'proposed', why: 'Follows the S1 example `add-character-dm` to `start-direct-conversation`' },
    toggleAddDmPicker: { next: 'toggleStartDirectConversationPicker', status: 'proposed', why: 'Follows `open-add-dm`' },
    ADD_DM_EMPTY: { next: 'START_DIRECT_CONVERSATION_EMPTY', status: 'proposed', why: 'Follows `open-add-dm`' },
    'add-dm-no-matches': { next: 'start-direct-conversation-no-matches', status: 'proposed', why: 'Follows `open-add-dm`; surface id of the registry' },
    conversationAddDmNoMatches: { next: 'conversationStartNoMatches', status: 'proposed', why: 'Follows `open-add-dm`; the mechanical name repeats `conversation`' },
    'choose-dm': { next: 'choose-conversation', status: 'proposed', why: 'Surface id of the registry' },
    conversationChooseDm: { next: 'conversationChoose', status: 'proposed', why: 'The mechanical name repeats `conversation`' },
    captureRoleplayDMRequest: { next: 'captureRoleplayAsideRequest', status: 'proposed', why: 'DM here is the private message that a character sends while the user roleplays; the code already calls it an aside (`groupAsideLastSent`)' },
    triggerRoleplayDM: { next: 'triggerRoleplayAside', status: 'proposed', why: 'See `captureRoleplayDMRequest`' },
    triggerGroupAsideDM: { next: 'triggerGroupAside', status: 'proposed', why: 'See `captureRoleplayDMRequest`' },
    appendConversationThreadMessage: { next: 'appendConversationChatMessage', status: 'proposed', why: 'The mechanical name `appendConversationMessage` is the existing function of `message-writer.js`' },
    updateConversationThreadMessage: { next: 'updateConversationChatMessage', status: 'proposed', why: 'Pairs with `appendConversationChatMessage`' },
    getGroupThreadConversationSettings: { next: 'getGroupRecordConversationSettings', status: 'proposed', why: 'The mechanical name is the export of `context.js` that `settings-store.js` imports' },
    getSoloThreadConversationSettings: { next: 'getSoloRecordConversationSettings', status: 'proposed', why: 'Pairs with `getGroupRecordConversationSettings`' },
    'sb-conversation-thread-empty': { next: 'sb-conversation-timeline-empty', status: 'proposed', why: 'The mechanical name is an existing class (`sb-conversation-empty`, the empty text of the schedule and the timeline fallbacks)' },
    THREAD_EMPTY: { next: 'TIMELINE_EMPTY', status: 'proposed', why: 'Selector of `sb-conversation-timeline-empty`' },
    'new-branch': { next: 'new-named-chat', status: 'proposed', why: 'The mechanical name is the existing action `new-chat` (New Chat). This one asks for a name' },
    thread: { next: 'messages', status: 'proposed', why: 'In code this word names a message list; the mechanical `conversation` would name a message list after the whole conversation' },
    branch: { next: 'chat', status: 'decided', why: 'S1; rename needs a different name in files that import the roleplay `chat` array' },
    showMainThread: { next: 'showMainChat', status: 'proposed', why: 'Shows the chat with the id `main`' },
    startThread: { next: 'startConversation', status: 'proposed', why: 'Starts a direct conversation in a spec' },
    THREAD: { next: 'MESSAGES', status: 'proposed', why: 'A list of seeded messages' },
    THREAD_INDEX: { next: 'MESSAGE_INDEX', status: 'proposed', why: 'Index of a seeded message' },
    threadMessages: { next: 'chatMessages', status: 'proposed', why: 'A message list' },
    persistedThread: { next: 'persistedConversation', status: 'proposed', why: 'A stored conversation entry in a fixture' },
};

// The line of an upstream-origin file that the rename changes gets this marker, which the
// upstream-sync rules need on every divergence.
const UPSTREAM_MARKER_WHY = 'Home renames and deletes Conversation mode chats through that module\'s exports.';

/**
 * A bare local name takes the second name in a file that already holds the first. The roleplay
 * `chat` array is imported by several modules, and `member` and `messages` are common locals.
 */
const BARE_FALLBACKS = {
    branch: 'conversationChat',
    thread: 'conversationMessages',
    partner: 'memberCharacter',
    partners: 'memberCharacters',
    pals: 'conversationItems',
    pal: 'conversationItem',
};

/**
 * Collisions that were read and are not one: the other name is a parameter of a separate function.
 */
const ACCEPTED_COLLISIONS = [
    { token: 'partnerAvatar', file: /\/media\.js$/, why: 'The existing `memberAvatar` is the parameter of another arrow function' },
    { token: 'branchId', file: /\/temporary-chat-seams\.test\.js$/, why: 'The existing `chatId` is the parameter of an unrelated mock function' },
    { token: 'partners', file: /\/auto-engine\.js$/, why: 'The `members` of this file lives in another function than the two `partners` locals (lines 506 and 581 at e681e5b38)' },
];

/**
 * Bare words of strings and styles that are values of the page state, not wording.
 * The page of the layout is `pals`, `chat` or `settings`; S1 calls the first one `list`.
 */
function renamesBareValue(occurrence, text) {
    if (occurrence.token !== 'pals') {
        return null;
    }
    if (occurrence.context === 'css') {
        return 'list';
    }
    if (occurrence.context === 'string' && occurrence.whole) {
        return 'list';
    }
    const around = text.slice(Math.max(0, occurrence.start - 48), occurrence.end);
    if (/data-sb-conversation-page\s*=\s*['"]?pals$/.test(around)) {
        return 'list';
    }
    // The page value in a comment or a type: `pals` in backticks, 'pals' in a JSDoc union.
    return occurrence.context === 'comment' && /[`']pals[`']/.test(text.slice(occurrence.start - 1, occurrence.end + 1)) ? 'list' : null;
}

/**
 * Files
 */

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 1 << 29, encoding: 'utf8' });
}

function readRepoFile(file) {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function isPrimaryFile(file) {
    return PRIMARY_PATTERNS.some(pattern => pattern.test(file));
}

/**
 * @typedef {'primary'|'secondary'|'doc'|'mixed'|'importer'} FileRole
 * `primary` files are the module, its entry and its stylesheet. `secondary` files refer to their
 * names. `doc` files are LESSONS.md and the ledger. `mixed` files refer to the client and to the
 * server routes, `importer` files are server files that import client modules.
 */

/**
 * Sorts the tracked files into those that the rename may change and those that it must not.
 * @param {RegExp|null} surfacePattern Names of the module's surface (exports, ids, classes, action ids): a file that holds one is in scope
 * @returns {{files: {file: string, text: string, role: FileRole}[], skipped: {file: string, reason: string}[]}} Scope
 */
function collectScope(surfacePattern = null) {
    const files = [];
    const skipped = [];
    for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
        if (BINARY_EXTENSION.test(file) || file === SCRIPT_PATH || !fs.existsSync(path.join(repoRoot, file))) {
            continue;
        }
        const primary = isPrimaryFile(file);
        const importer = SERVER_IMPORTER_PATTERN.test(file);
        if (!primary && !importer && !SECONDARY_ROOTS.some(pattern => pattern.test(file))) {
            continue;
        }
        if (OUT_OF_SCOPE_PATTERNS.some(pattern => pattern.test(file))) {
            skipped.push({ file, reason: 'vendored code or locale data' });
            continue;
        }
        const text = readRepoFile(file);
        if (primary) {
            files.push({ file, text, role: 'primary' });
            continue;
        }
        const importsClient = CLIENT_MODULE_PATH.test(text);
        if (importer) {
            if (importsClient) {
                files.push({ file, text, role: 'importer' });
            }
            continue;
        }
        if (file === 'LESSONS.md' || file === 'docs/upstream-touch-ledger.md') {
            files.push({ file, text, role: 'doc' });
            continue;
        }
        const withoutServerPaths = text.replace(SERVER_MODULE_REFERENCE, '');
        const mentionsClient = CLIENT_REFERENCE.test(withoutServerPaths) || CONVERSATION_FILE_NAME.test(path.basename(file)) || Boolean(surfacePattern?.test(withoutServerPaths));
        if (!mentionsClient) {
            continue;
        }
        const mentionsServer = text.match(SERVER_MODULE_REFERENCE) !== null;
        if (mentionsServer && !importsClient && !CLIENT_REFERENCE.test(withoutServerPaths)) {
            skipped.push({ file, reason: 'tests the server routes that task 1T rewrites' });
            continue;
        }
        files.push({ file, text, role: mentionsServer ? 'mixed' : 'secondary' });
    }
    return { files, skipped };
}

function loadUpstreamOriginFiles() {
    const fixture = path.join(repoRoot, 'tests/fixtures/upstream-origin-public-files.json');
    return new Set(fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : []);
}

/**
 * The names that a file imports from the client modules, with the span of each import statement.
 * @param {string} text Source
 * @returns {{statements: {start: number, end: number, names: Set<string>}[], foreign: {start: number, end: number}[], unaliased: Set<string>, other: Set<string>}} Bindings
 */
function clientBindings(text) {
    const statements = [];
    const foreign = [];
    const unaliased = new Set();
    const other = new Set();
    const patterns = [
        /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
        /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const fromClient = CLIENT_MODULE_PATH.test(match[2]);
            const names = new Set();
            for (const specifier of match[1].split(',')) {
                const [imported, local] = specifier.trim().split(/\s+as\s+|\s*:\s*/);
                if (!imported) {
                    continue;
                }
                if (fromClient) {
                    names.add(imported);
                    if (!local || local === imported) {
                        unaliased.add(imported);
                    }
                } else {
                    other.add(local || imported);
                }
            }
            const span = { start: match.index, end: match.index + match[0].length, names };
            (fromClient ? statements : foreign).push(span);
        }
    }
    return { statements, foreign, unaliased, other };
}

/**
 * Scanning
 */

/**
 * @typedef {object} Occurrence
 * @property {string} token Name as written
 * @property {number} start Offset of the first character
 * @property {number} end Offset after the last character
 * @property {'code'|'string'|'template'|'comment'|'regexp'|'css'|'text'} context What the name sits in
 * @property {string} [declared] `module` for a top-level function, class or constant, `import` for an import or re-export specifier
 * @property {boolean} [exported] The declaration is exported
 * @property {string} [position] `member`, `key` or `shorthand` for a name in property position
 * @property {boolean} [whole] The name is the whole content of its string
 */

function pushRuns(out, text, from, to, context) {
    for (const match of text.slice(from, to).matchAll(IDENTIFIER_RUN)) {
        let token = match[0];
        let start = from + match.index;
        // A single leading hyphen is a minus or a dash in prose; `--` starts a custom property.
        if (/^-[^-]/.test(token)) {
            token = token.slice(1);
            start += 1;
        }
        token = token.replace(/-+$/, '');
        if (token && hasStem(token)) {
            out.push({ token, start, end: start + token.length, context });
        }
    }
}

function scanScript(text) {
    const out = [];
    const comments = [];
    let tokens;
    try {
        tokens = [...acorn.tokenizer(text, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowHashBang: true,
            allowAwaitOutsideFunction: true,
            onComment: (block, content, start, end) => comments.push({ start, end }),
        })];
    } catch {
        return null;
    }
    for (const comment of comments) {
        pushRuns(out, text, comment.start, comment.end, 'comment');
    }
    let depth = 0;
    let importing = false;
    let exportingList = false;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const label = token.type.label;
        const previous = tokens[index - 1];
        const next = tokens[index + 1];
        if (label === '{' || label === '${') {
            depth++;
        } else if (label === '}') {
            depth--;
            exportingList = false;
        }
        if (label === 'import' && depth === 0 && next?.type.label !== '(' && next?.type.label !== '.') {
            importing = true;
        } else if (label === 'export' && depth === 0 && next?.type.label === '{') {
            exportingList = true;
        } else if (importing && (label === ';' || (label === 'string' && (previous?.value === 'from' || previous?.type.label === 'import')))) {
            importing = false;
        }
        if (label === 'string') {
            const before = out.length;
            pushRuns(out, text, token.start + 1, token.end - 1, 'string');
            for (const occurrence of out.slice(before)) {
                occurrence.whole = occurrence.token === text.slice(token.start + 1, token.end - 1);
            }
        } else if (label === 'template') {
            pushRuns(out, text, token.start, token.end, 'template');
        } else if (label === 'regexp') {
            pushRuns(out, text, token.start, token.end, 'regexp');
        } else if (label === 'name' && hasStem(token.value)) {
            const occurrence = { token: token.value, start: token.start, end: token.end, context: 'code' };
            const kind = previous?.type.keyword ?? previous?.type.label;
            if (importing || exportingList) {
                occurrence.declared = 'import';
            } else if (depth === 0 && ['function', 'class', 'const', 'let', 'var'].includes(kind)) {
                occurrence.declared = 'module';
                occurrence.exported = [tokens[index - 2], tokens[index - 3]].some(item => item?.type.label === 'export');
            } else if (depth === 0 && kind === '*' && tokens[index - 2]?.type.label === 'function') {
                occurrence.declared = 'module';
                occurrence.exported = [tokens[index - 3], tokens[index - 4]].some(item => item?.type.label === 'export');
            }
            const previousLabel = previous?.type.label;
            const nextLabel = next?.type.label;
            if (previousLabel === '.' || previousLabel === '?.') {
                occurrence.position = 'member';
            } else if (nextLabel === ':' && (previousLabel === '{' || previousLabel === ',')) {
                occurrence.position = 'key';
            } else if ((previousLabel === '{' || previousLabel === ',') && (nextLabel === ',' || nextLabel === '}') && !importing && !exportingList) {
                occurrence.position = 'shorthand';
            }
            out.push(occurrence);
        }
    }
    return out;
}

function scanStylesheet(text) {
    const out = [];
    let cursor = 0;
    for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
        pushRuns(out, text, cursor, match.index, 'css');
        pushRuns(out, text, match.index, match.index + match[0].length, 'comment');
        cursor = match.index + match[0].length;
    }
    pushRuns(out, text, cursor, text.length, 'css');
    return out;
}

/**
 * @param {string} file Path in the repository
 * @param {string} text Content
 * @returns {Occurrence[]} Every name in the file that holds an old stem, in file order
 */
function scanFile(file, text) {
    const extension = path.extname(file);
    let occurrences = null;
    if (['.js', '.mjs', '.cjs'].includes(extension)) {
        occurrences = scanScript(text);
        if (!occurrences) {
            console.warn(`warning: ${file} did not tokenize, scanned as plain text`);
        }
    } else if (extension === '.css') {
        occurrences = scanStylesheet(text);
    }
    if (!occurrences) {
        occurrences = [];
        pushRuns(occurrences, text, 0, text.length, 'text');
    }
    return occurrences.sort((a, b) => a.start - b.start);
}

function lineOf(text, offset) {
    let line = 1;
    for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
        line++;
    }
    return line;
}

function lineText(text, offset) {
    const start = text.lastIndexOf('\n', offset - 1) + 1;
    const end = text.indexOf('\n', offset);
    return text.slice(start, end === -1 ? undefined : end);
}

const ANY_NAME = /[A-Za-z_$][A-Za-z0-9_$-]*/g;

/**
 * Plan
 */

function fileMoves(files) {
    const moves = [];
    const existing = new Set(git(['ls-files', '-z']).split('\0'));
    for (const { file, role } of files) {
        if (role === 'importer') {
            continue;
        }
        const base = path.basename(file);
        const stem = base.slice(0, base.indexOf('.') === -1 ? undefined : base.indexOf('.'));
        if (!hasStem(stem)) {
            continue;
        }
        const nextStem = NAME_OVERRIDES[stem]?.next ?? mechanicalName(stem);
        const to = path.join(path.dirname(file), nextStem + base.slice(stem.length));
        moves.push({ from: file, to, stem, nextStem, collides: existing.has(to) });
    }
    return moves;
}

/**
 * The variables of a text-reading test that hold the source of a client module, and the position of
 * each `expect(variable)` call, so that an assertion about client source can be told from one about
 * server source.
 * @param {string} text Test source
 * @returns {{clientVars: Set<string>}} Variables
 */
function sourceReaderVariables(text) {
    const clientVars = new Set();
    for (const match of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*readConversationSource\(/g)) {
        clientVars.add(match[1]);
    }
    return { clientVars };
}

function assertionTarget(text, offset) {
    const window = text.slice(Math.max(0, offset - 600), offset);
    const calls = [...window.matchAll(/expect\((\w+)\)/g)];
    const last = calls[calls.length - 1];
    if (!last || window.slice(last.index).includes(';')) {
        return null;
    }
    return last[1];
}

/**
 * The names that a file binds or reads as a variable. A property of an object (`group.members`)
 * does not collide with a variable of the same spelling.
 * @param {string} file Path
 * @param {string} text Source
 * @returns {Set<string>} Names
 */
function boundNames(file, text) {
    if (path.extname(file) === '.css') {
        return new Set(text.replace(/\/\*[\s\S]*?\*\//g, '').match(ANY_NAME));
    }
    if (!['.js', '.mjs'].includes(path.extname(file))) {
        return new Set(text.match(ANY_NAME));
    }
    const names = new Set();
    try {
        const tokens = [...acorn.tokenizer(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true })];
        tokens.forEach((token, index) => {
            const previous = tokens[index - 1]?.type.label;
            const next = tokens[index + 1]?.type.label;
            if (token.type.label !== 'name' || previous === '.' || previous === '?.') {
                return;
            }
            if (next === ':' && (previous === '{' || previous === ',')) {
                return;
            }
            names.add(token.value);
        });
    } catch {
        return new Set(text.match(ANY_NAME));
    }
    return names;
}

const COMPOUND_REFERENCE_SHAPES = new Set(['camel', 'snake', 'mixed']);

/**
 * Whether one occurrence of a name is a reference to the identifier, and not wording or prose.
 * @returns {boolean} True when the occurrence is renamed
 */
function acceptOccurrence({ occurrence, token, file, role, allowBare, isUpstream, bindings, readers, exportNames, text }) {
    const { context } = occurrence;
    const shape = shapeOf(token);
    const policy = role === 'mixed' ? MIXED_FILE_POLICY[file] ?? 'bindings' : 'bindings';
    if (policy === 'except-server-imports' && (bindings.other.has(token) || bindings.foreign.some(item => occurrence.start >= item.start && occurrence.end <= item.end))) {
        return false;
    }
    if ((role === 'mixed' && policy !== 'except-server-imports') || role === 'importer') {
        const statement = bindings.statements.find(item => occurrence.start >= item.start && occurrence.end <= item.end);
        if (statement) {
            return statement.names.has(token);
        }
        if (readers.clientVars.size && context === 'code' && readers.clientVars.has(token)) {
            return true;
        }
        if (readers.clientVars.size && (context === 'string' || context === 'template')) {
            return readers.clientVars.has(assertionTarget(text, occurrence.start));
        }
        return context === 'code' && bindings.unaliased.has(token) && !bindings.other.has(token) && occurrence.declared !== 'module';
    }
    if (isUpstream && !exportNames.has(token)) {
        return false;
    }
    if (shape === 'single') {
        return context === 'code' && allowBare;
    }
    if (PROSE_LIKE_TOKENS.has(token)) {
        return false;
    }
    if (COMPOUND_REFERENCE_SHAPES.has(shape)) {
        return true;
    }
    // Kebab names are classes, data attributes, ids of actions or words of prose.
    return /^(?:sb-|data-|--)/.test(token) || DATA_VALUE_TOKENS.has(token);
}

function isFilePathReference(occurrence, text) {
    if (!['string', 'template', 'text', 'comment', 'css'].includes(occurrence.context)) {
        return false;
    }
    return /^\.(?:js|mjs|css|md)\b/.test(text.slice(occurrence.end, occurrence.end + 5));
}

/**
 * Finds the stored sites of the names in `STORED_SITE_RULES`.
 * @param {string} text Source of a script
 * @returns {Map<number, 'keep'|'expand'>} Offset of the name to what the rename does there
 */
function findStoredSites(text) {
    const sites = new Map();
    let ast = null;
    for (const sourceType of ['module', 'script']) {
        try {
            ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowAwaitOutsideFunction: true });
            break;
        } catch {
            ast = null;
        }
    }
    if (!ast) {
        return sites;
    }
    const ruleOf = name => (Object.hasOwn(STORED_SITE_RULES, name) ? STORED_SITE_RULES[name] : null);
    const keyOf = property => (property.key?.type === 'Identifier' && !property.computed ? property.key.name : property.key?.type === 'Literal' ? String(property.key.value) : null);
    const storedArguments = new Map();
    const visit = (node, parent) => {
        if (!node || typeof node.type !== 'string') {
            return;
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.arguments[0]?.type === 'ObjectExpression') {
            storedArguments.set(node.arguments[0], node.callee.name);
        }
        if (node.type === 'MemberExpression' && !node.computed && ruleOf(node.property.name)) {
            const rule = ruleOf(node.property.name);
            if (node.object.type === 'Identifier' && rule.owners.includes(node.object.name)) {
                sites.set(node.property.start, 'keep');
            }
        } else if (node.type === 'ObjectExpression') {
            const keys = node.properties.map(property => (property.type === 'Property' ? keyOf(property) : null)).filter(Boolean);
            for (const property of node.properties) {
                const rule = property.type === 'Property' ? ruleOf(keyOf(property)) : null;
                if (rule && !property.computed && (rule.literalMarkers.some(key => keys.includes(key)) || rule.calls.includes(storedArguments.get(node)))) {
                    sites.set(property.key.start, property.shorthand ? 'expand' : 'keep');
                }
            }
        } else if (node.type === 'ObjectPattern') {
            const source = parent?.type === 'VariableDeclarator' && parent.id === node && parent.init?.type === 'Identifier' ? parent.init.name : null;
            for (const property of node.properties) {
                const rule = property.type === 'Property' ? ruleOf(keyOf(property)) : null;
                if (rule && source && rule.owners.includes(source)) {
                    sites.set(property.key.start, property.shorthand ? 'expand' : 'keep');
                }
            }
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) {
                child.forEach(item => visit(item, node));
            } else if (child && typeof child.type === 'string') {
                visit(child, node);
            }
        }
    };
    visit(ast, null);
    return sites;
}

/**
 * A pattern for the names that a file outside the module uses to reach it: exported functions,
 * constants and classes, ids, classes and action ids. A local variable of the same spelling in
 * another file is no reason to change that file.
 * @param {{files: {file: string, text: string, role: FileRole}[]}} scope First scope
 * @returns {RegExp} Pattern
 */
function surfacePatternOf(scope) {
    const names = new Set(DATA_VALUE_TOKENS);
    for (const { file, text, role } of scope.files) {
        if (role !== 'primary') {
            continue;
        }
        for (const occurrence of scanFile(file, text)) {
            const { token } = occurrence;
            if (KEPT_TOKENS[token] || STORED_TOKENS[token] || shapeOf(token) === 'single') {
                continue;
            }
            if (occurrence.exported || occurrence.declared === 'module' || /^sb[-_]/.test(token)) {
                names.add(token);
            }
        }
    }
    const escaped = [...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?<![A-Za-z0-9_$-])(?:${escaped.join('|')})(?![A-Za-z0-9_$-])`);
}

/**
 * @param {{includeStored?: boolean}} options Options
 * @returns {object} The plan: moves, entries, edits of every file and the reports that the map needs
 */
function buildPlan({ includeStored = false } = {}) {
    const scope = collectScope(surfacePatternOf(collectScope()));
    const upstreamOrigin = loadUpstreamOriginFiles();
    const scanned = new Map();
    const records = new Map();
    for (const { file, text, role } of scope.files) {
        const occurrences = scanFile(file, text);
        scanned.set(file, occurrences);
        for (const occurrence of occurrences) {
            let record = records.get(occurrence.token);
            if (!record) {
                record = { primary: 0, declaredModule: 0, exported: false, declaredInTests: 0 };
                records.set(occurrence.token, record);
            }
            if (role === 'primary') {
                record.primary++;
                record.declaredModule += occurrence.declared === 'module' ? 1 : 0;
                if (occurrence.exported || (occurrence.declared === 'import' && occurrence.context === 'code')) {
                    record.exported = true;
                }
            } else if (occurrence.declared === 'module') {
                record.declaredInTests++;
            }
        }
    }

    const moves = fileMoves(scope.files);
    const moveByStem = new Map(moves.map(move => [move.stem, move]));
    const exportNames = new Set([...records].filter(([, record]) => record.exported || record.declaredModule).map(([token]) => token));

    /** @type {Map<string, Entry>} */
    const entries = new Map();
    for (const [token, record] of records) {
        const inDomain = record.primary > 0 || TEST_ONLY_TOKENS.has(token) || DATA_VALUE_TOKENS.has(token);
        if (!inDomain) {
            continue;
        }
        const override = NAME_OVERRIDES[token];
        if (KEPT_TOKENS[token]) {
            entries.set(token, { old: token, next: null, group: 'kept', status: 'decided', why: KEPT_TOKENS[token] });
        } else if (STORED_TOKENS[token]) {
            const stored = STORED_TOKENS[token];
            const renamed = includeStored && stored.next;
            entries.set(token, { old: token, next: renamed ? stored.next : null, group: renamed ? 'rename' : 'stored', status: 'decided', why: stored.why, storedNext: stored.next });
        } else {
            entries.set(token, { old: token, next: override?.next ?? mechanicalName(token), group: 'rename', status: override?.status ?? 'decided', why: override?.why });
        }
    }

    const edits = new Map();
    const heldBack = new Map();
    const siteRows = new Map();
    const fileRefs = new Map();
    const unclassified = new Map();
    const refusedInUpstream = new Map();
    const residue = new Map();
    for (const { file, text, role } of scope.files) {
        const base = path.basename(file);
        const allowBare = role === 'primary' || (role !== 'doc' && CONVERSATION_FILE_NAME.test(base)) || file === 'tests/helpers/surfaces/chat-conversation-steps.js';
        const isUpstream = upstreamOrigin.has(file);
        const bindings = role === 'mixed' || role === 'importer' ? clientBindings(text) : null;
        const readers = sourceReaderVariables(text);
        const sites = !includeStored && Object.keys(STORED_SITE_RULES).some(token => text.includes(token)) ? findStoredSites(text) : new Map();
        const fileEdits = [];
        for (const occurrence of scanned.get(file)) {
            const { token } = occurrence;
            const move = moveByStem.get(token);
            const entry = entries.get(token);
            let next = null;
            let editKind = 'name';
            if (move && isFilePathReference(occurrence, text) && (role !== 'mixed' || /readConversationSource\(|sillybunny-conversation/.test(lineText(text, occurrence.start)) || readers.clientVars.size) && role !== 'importer') {
                next = move.nextStem;
                editKind = 'path';
                const row = fileRefs.get(token) ?? { count: 0, files: new Map() };
                row.count++;
                row.files.set(file, (row.files.get(file) ?? 0) + 1);
                fileRefs.set(token, row);
            } else if (move && isFilePathReference(occurrence, text) && role === 'importer') {
                next = CLIENT_MODULE_PATH.test(lineText(text, occurrence.start)) ? move.nextStem : null;
                editKind = 'path';
            }
            const bare = renamesBareValue(occurrence, text);
            if (!next && bare && !isUpstream && role !== 'mixed' && role !== 'importer') {
                next = bare;
                editKind = 'value';
            } else if (!next && entry && entry.group !== 'kept') {
                const accepted = acceptOccurrence({ occurrence, token, file, role, allowBare, isUpstream, bindings, readers, exportNames, text });
                if (accepted && entry.group === 'rename') {
                    next = entry.next;
                    const accepted = ACCEPTED_COLLISIONS.some(item => item.token === token && item.file.test(file));
                    if (!accepted && BARE_FALLBACKS[token] && next === (NAME_OVERRIDES[token]?.next ?? SEGMENT_MAP[token]) && boundNames(file, text).has(next)) {
                        next = BARE_FALLBACKS[token];
                    }
                    const site = sites.get(occurrence.start);
                    if (site && Object.hasOwn(STORED_SITE_RULES, token)) {
                        const row = siteRows.get(token) ?? { keep: [], expand: [] };
                        row[site].push({ file, line: lineOf(text, occurrence.start), text: lineText(text, occurrence.start).trim() });
                        siteRows.set(token, row);
                        next = site === 'keep' ? null : `${token}: ${next}`;
                        editKind = site === 'keep' ? editKind : 'expand';
                    }
                } else if (accepted && entry.group === 'stored') {
                    const row = heldBack.get(token) ?? { count: 0, files: new Map() };
                    row.count++;
                    row.files.set(file, (row.files.get(file) ?? 0) + 1);
                    heldBack.set(token, row);
                } else if (!accepted && isUpstream && entry.group === 'rename' && shapeOf(token) !== 'single' && occurrence.context === 'code') {
                    const row = refusedInUpstream.get(file) ?? new Map();
                    row.set(token, (row.get(token) ?? 0) + 1);
                    refusedInUpstream.set(file, row);
                }
            }
            if (!next && !entry && !move && role !== 'importer' && role !== 'mixed' && occurrence.context !== 'comment' && shapeOf(token) !== 'single' && !PROSE_LIKE_TOKENS.has(token)) {
                const list = unclassified.get(token) ?? new Set();
                list.add(file);
                unclassified.set(token, list);
            }
            if (next) {
                fileEdits.push({ start: occurrence.start, end: occurrence.end, next, token, context: occurrence.context, kind: editKind });
            } else if (role !== 'importer') {
                const key = `${token}|${occurrence.context}|${role === 'primary' ? 'primary' : 'other'}`;
                residue.set(key, (residue.get(key) ?? 0) + 1);
            }
        }
        if (isUpstream && path.extname(file) === '.js') {
            const lines = new Set(fileEdits.map(edit => lineOf(text, edit.start)));
            for (const number of lines) {
                const source = text.split('\n')[number - 1];
                if (!source.includes('SillyBunny')) {
                    const lineEnd = text.split('\n').slice(0, number).join('\n').length;
                    fileEdits.push({ start: lineEnd, end: lineEnd, next: ` // SillyBunny: ${UPSTREAM_MARKER_WHY}`, token: '', context: 'marker', kind: 'marker' });
                }
            }
        }
        if (fileEdits.length) {
            edits.set(file, fileEdits);
        }
    }

    const used = new Map();
    for (const [file, fileEdits] of edits) {
        for (const edit of fileEdits) {
            if (edit.kind === 'marker') {
                continue;
            }
            const row = used.get(edit.token) ?? { count: 0, files: new Map() };
            row.count++;
            row.files.set(file, (row.files.get(file) ?? 0) + 1);
            used.set(edit.token, row);
        }
    }

    return { scope, scanned, records, entries, edits, used, heldBack, siteRows, fileRefs, moves, unclassified, upstreamOrigin, exportNames, refusedInUpstream, residue };
}

/**
 * Names that the rename would put where a variable of the same spelling stands in a file, and two
 * renames of one file that give one name.
 * @param {object} plan Plan
 * @returns {Map<string, string[]>} Old name to the files where its new name collides
 */
function findCollisions(plan) {
    const collisions = new Map();
    const add = (token, detail) => collisions.set(token, [...(collisions.get(token) ?? []), detail]);
    for (const [file, fileEdits] of plan.edits) {
        const text = plan.scope.files.find(item => item.file === file).text;
        const bound = boundNames(file, text);
        const renamedAway = new Set(fileEdits.map(edit => edit.token));
        const byNext = new Map();
        for (const edit of fileEdits) {
            if (['expand', 'marker'].includes(edit.kind) || plan.moves.some(move => move.stem === edit.token && move.nextStem === edit.next)) {
                continue;
            }
            const olds = byNext.get(edit.next) ?? new Set();
            olds.add(edit.token);
            byNext.set(edit.next, olds);
        }
        for (const [next, olds] of byNext) {
            for (const token of olds) {
                if (ACCEPTED_COLLISIONS.some(item => item.token === token && item.file.test(file))) {
                    continue;
                }
                if (olds.size > 1) {
                    add(token, `${file}: also the new name of ${[...olds].filter(item => item !== token).join(', ')}`);
                } else if (bound.has(next) && !renamedAway.has(next)) {
                    add(token, `${file}: \`${next}\` is already a name of the file`);
                }
            }
        }
    }
    return collisions;
}

function kindOfEntry(entry, record) {
    const token = entry.old;
    if (entry.group === 'stored') {
        return 'stored';
    }
    if (record?.declaredModule > 0) {
        return 'module';
    }
    if (record?.primary === 0 && (TEST_ONLY_TOKENS.has(token) || record?.declaredInTests > 0)) {
        return 'test';
    }
    if (token.startsWith('--')) {
        return 'cssvar';
    }
    if (/^data-/.test(token) || DATA_VALUE_TOKENS.has(token)) {
        return 'data';
    }
    if (/^sb_(?:conv|conversation)/.test(token)) {
        return 'id';
    }
    if (/^sb-/.test(token)) {
        return 'class';
    }
    return 'local';
}

/**
 * The map
 */

function groupRows(plan) {
    const rows = new Map();
    for (const [file, fileEdits] of plan.edits) {
        for (const edit of fileEdits) {
            if (['path', 'expand', 'marker'].includes(edit.kind)) {
                continue;
            }
            const key = `${edit.token}\0${edit.next}`;
            const row = rows.get(key) ?? { old: edit.token, next: edit.next, count: 0, files: new Map(), kinds: new Set() };
            row.count++;
            row.files.set(file, (row.files.get(file) ?? 0) + 1);
            row.kinds.add(edit.kind);
            rows.set(key, row);
        }
    }
    const collisions = findCollisions(plan);
    return [...rows.values()].map((row) => {
        const entry = plan.entries.get(row.old);
        const alternative = entry && row.next !== entry.next && !row.kinds.has('value');
        const value = row.kinds.has('value');
        return {
            ...row,
            kind: value ? 'data' : entry ? kindOfEntry(entry, plan.records.get(row.old)) : 'local',
            status: collisions.has(row.old) ? 'collision' : alternative || value ? 'proposed' : entry?.status ?? 'decided',
            why: collisions.has(row.old) ? collisions.get(row.old).join('; ') : value ? 'Page value of the layout (`pals`, `chat`, `settings`); S1 calls the first one `list`' : alternative ? `Per-file alternative: some files already bind \`${entry.next}\`. ${entry.why ?? ''}`.trim() : entry?.why,
        };
    }).sort((a, b) => a.old.localeCompare(b.old) || a.next.localeCompare(b.next));
}

function digestOf(plan) {
    const hash = crypto.createHash('sha256');
    for (const [file, fileEdits] of [...plan.edits].sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(`${file}\n`);
        for (const edit of fileEdits) {
            hash.update(`${edit.start}:${edit.end}:${edit.next}\n`);
        }
    }
    for (const move of plan.moves) {
        hash.update(`${move.from}>${move.to}\n`);
    }
    return hash.digest('hex');
}

function shortFiles(files, limit = 4) {
    const names = [...files.entries()].sort((a, b) => b[1] - a[1]).map(([file, count]) => `${file.replace('public/scripts/sillybunny-conversation/', '').replace(/^public\/css\//, 'css/').replace(/^tests\//, 't/')}${count > 1 ? ` x${count}` : ''}`);
    return names.length > limit ? `${names.slice(0, limit).join(', ')} +${names.length - limit}` : names.join(', ');
}

const cell = value => `\`${String(value)}\``.replace(/\|/g, '\\|');
const mark = status => (status === 'decided' ? '' : status === 'proposed' ? ' (proposed)' : ' (COLLISION)');

function table(headers, rows) {
    if (!rows.length) {
        return '_None._\n';
    }
    return `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`;
}

function nameTable(rows) {
    return table(['Old', 'New', 'Count', 'Files'], rows.map(row => [cell(row.old), cell(row.next) + mark(row.status), row.count, shortFiles(row.files)]));
}

function renderUpstreamLines(plan, files) {
    const lines = [];
    for (const file of files) {
        const fileEdits = plan.edits.get(file);
        const text = plan.scope.files.find(item => item.file === file).text;
        const byLine = new Map();
        for (const edit of fileEdits) {
            const number = lineOf(text, edit.start);
            byLine.set(number, [...(byLine.get(number) ?? []), edit]);
        }
        for (const [number, lineEdits] of byLine) {
            const original = text.split('\n')[number - 1];
            let changed = original;
            const lineStart = text.split('\n').slice(0, number - 1).join('\n').length + (number > 1 ? 1 : 0);
            for (const edit of [...lineEdits].sort((a, b) => b.start - a.start)) {
                changed = changed.slice(0, edit.start - lineStart) + edit.next + changed.slice(edit.end - lineStart);
            }
            lines.push(`- \`${file}:${number}\`\n  - \`${original.trim().slice(0, 170)}\`\n  - \`${changed.trim().slice(0, 170)}\``);
        }
    }
    return lines.length ? lines.join('\n') : '_None._';
}

function describeTextReaders(plan) {
    const rows = [];
    for (const { file, text, role } of plan.scope.files) {
        if (!/\.test\.js$/.test(file) || role === 'importer' || !/readFileSync|readFile\(|readConversationSource|readSource|loadFunctions|vm-source/.test(text)) {
            continue;
        }
        const fileEdits = (plan.edits.get(file) ?? []).filter(edit => edit.kind === 'path' || ['string', 'template', 'regexp'].includes(edit.context));
        if (!fileEdits.length) {
            continue;
        }
        const tokens = new Map();
        for (const edit of fileEdits) {
            tokens.set(edit.token, (tokens.get(edit.token) ?? 0) + 1);
        }
        const paths = fileEdits.filter(edit => edit.kind === 'path').length;
        rows.push([cell(file), paths, fileEdits.length - paths, [...tokens].slice(0, 6).map(([token, count]) => `${cell(token)}${count > 1 ? ` x${count}` : ''}`).join(', ') + (tokens.size > 6 ? `, +${tokens.size - 6}` : '')]);
    }
    return table(['Test', 'Path strings changed', 'Other string assertions changed', 'Names in them'], rows);
}

function renderSites(plan) {
    const lines = [];
    for (const [token, rule] of Object.entries(STORED_SITE_RULES)) {
        const row = plan.siteRows.get(token) ?? { keep: [], expand: [] };
        lines.push(`**${cell(token)}** (new name ${cell(rule.next)}): ${rule.why} Kept: ${row.keep.length} sites, expanded: ${row.expand.length}.`);
        for (const site of row.keep) {
            lines.push(`- kept: \`${site.file}:${site.line}\`  \`${site.text.slice(0, 120)}\``);
        }
        for (const site of row.expand) {
            lines.push(`- expanded: \`${site.file}:${site.line}\`  \`${site.text.slice(0, 120)}\``);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function renderOpenPoints(plan, rows) {
    const importers = [...plan.edits.keys()].filter(file => file.startsWith('src/'));
    const points = [
        `**Names that are stored at a few sites.** Split by site: \`branchId\` keeps the old spelling at ${(plan.siteRows.get('branchId')?.keep.length ?? 0)} reminder sites and ${plan.used.get('branchId')?.count ?? 0} other uses are renamed to \`chatId\`; \`threadAvatar\` keeps it at ${(plan.siteRows.get('threadAvatar')?.keep.length ?? 0)} sites and ${plan.used.get('threadAvatar')?.count ?? 0} uses become \`anchorAvatar\`. ${(plan.siteRows.get('branchId')?.expand.length ?? 0) + (plan.siteRows.get('threadAvatar')?.expand.length ?? 0)} stored shorthand sites were expanded (§10).`,
        `**Message lists called thread.** In ${Object.values(NAME_OVERRIDES).filter(item => /message list|list of seeded messages|stored message/.test(item.why)).length} proposals \`thread\` means the message list of a chat (\`getConversationThread\`, \`saveConversationThread\`, \`safeParseThread\`, the local \`thread\`, \`targetThread\`). The mechanical name would be \`getConversation\`, \`saveConversation\` and so on, which says "the conversation" for a list of messages. The map proposes \`...Messages\`.`,
        '**The accessor of one conversation entry.** `getConversationThreadStore` and its variable `threadStore` (172 uses) would become `getConversationStore` and `conversationStore`. `getConversationStore` is the existing accessor of the whole store in `context.js`, so the map proposes `getConversationRecord` and `conversationRecord`.',
        `**Server files that import client names.** ${importers.length} files under \`src/endpoints/\` (out of scope, rewritten or deleted by task 1T) import renamed names or module paths from the client. They change in the imported names, the uses of those names and the module paths only, so that the server still starts. Their own names (\`createConversationBranch\`, \`getConversationThreadKey\`, REST field names) stay. Section 14 lists the lines.`,
        '**Home-owned names stay.** `public/scripts/welcome-screen.js` (upstream-origin), `sillybunny-home/recent-chat.js` and `sillybunnyHome.html` keep `branchId`, `branchName`, `conversation_branch_id` and `data-conversation-branch-id`: they name Home recent chats and pins, which S2.8 moves to the conversation id. Only the two exported functions that `welcome-screen.js` calls change there.',
        '**Fixtures.** `tests/fixtures/copy-baseline.json` holds surface ids and selectors and is written sorted by its own writer; `apply` writes it again with that writer. Its test "only shrinks" compares the file with `HEAD`, so it fails until the rename is committed. `axe-baseline.json` and `settings-inventory.json` change selectors only.',
        '**Comments and prompts.** Prose in comments that uses the old words (counted in section 11) is not edited, and neither is the text of prompts. A comment that quotes a renamed identifier does change.',
        '**Tests that read source as text.** Section 15 lists the unit tests whose assertions quote renamed names or read renamed files. The REST tests (`sillybunny-conversation-api`, `-backend-save`) change only in the names they import from the client; `conversation-mode-scoped-profile` changes only in assertions about client source.',
    ];
    return points.map(point => `- ${point}`).join('\n');
}

function renderMap(plan, rows) {
    const byKind = kind => rows.filter(row => row.kind === kind);
    const head = git(['rev-parse', '--short', 'HEAD']).trim();
    const proposed = rows.filter(row => row.status !== 'decided');
    const collisions = rows.filter(row => row.status === 'collision');
    const totalEdits = [...plan.edits.values()].reduce((sum, list) => sum + list.length, 0);
    const sizes = [
        ['1 File names', plan.moves.length, [...plan.fileRefs.values()].reduce((sum, row) => sum + row.count, 0) + plan.moves.length],
        ['2 Exported and module-level names', byKind('module').length, byKind('module').reduce((sum, row) => sum + row.count, 0)],
        ['3 DOM ids', byKind('id').length, byKind('id').reduce((sum, row) => sum + row.count, 0)],
        ['4 CSS classes', byKind('class').length, byKind('class').reduce((sum, row) => sum + row.count, 0)],
        ['5 data- attributes, action ids, page and event values', byKind('data').length, byKind('data').reduce((sum, row) => sum + row.count, 0)],
        ['6 CSS custom properties', byKind('cssvar').length, 0],
        ['7 i18n keys', 0, 0],
        ['8 Test helper names', byKind('test').length, byKind('test').reduce((sum, row) => sum + row.count, 0)],
        ['9 Local names, parameters, properties and bare words', byKind('local').length, byKind('local').reduce((sum, row) => sum + row.count, 0)],
        ['10 Stored names, not renamed in this commit', Object.keys(STORED_TOKENS).length + Object.keys(STORED_SITE_RULES).length + STORED_NAMES_WITHOUT_STEM.length, [...plan.heldBack.values()].reduce((sum, row) => sum + row.count, 0) + [...plan.siteRows.values()].reduce((sum, row) => sum + row.keep.length, 0)],
        ['11 Kept', Object.keys(KEPT_TOKENS).length, 0],
    ];
    return `# Rename map: conversation mode internals

Generated by \`scripts/rename-conversation-identifiers.mjs inventory\` at \`${head}\` on ${new Date().toISOString().slice(0, 10)}. Step 1 only: nothing is applied. \`apply\` reads \`rename-map.json\` and refuses to run when a new scan gives another digest (\`${digestOf(plan).slice(0, 12)}\`).

The rule: a name is renamed when it holds one of the stems \`pals\`/\`pal\`, \`dm\`, \`partner\`, \`branch\` (noun) or \`thread\` (a conversation or its messages) as a word, by the S1 map: \`pals\` to \`list\`, \`pals rail\` to \`conversation list\`, \`pal\` and \`dm\` to \`conversation\`, \`partner\` to \`member\`, \`branch\` to \`chat\`, \`thread\` to \`conversation\`, and a repeated word is dropped. **proposed** marks a name that S1 does not decide or that the mechanical name would break. Wording (labels, prompts, toasts, prose in comments) is never renamed; bare words are renamed only as variables in code, in the module and in test files that are about conversation mode.

## Sizes

${table(['Table', 'Rows', 'Edits'], sizes)}
Total: ${totalEdits} edits in ${plan.edits.size} files, ${proposed.length} rows proposed, ${collisions.length} collisions.

## 1 File names

${table(['Old path', 'New path', 'Path strings that change', 'Files'], plan.moves.map(move => [cell(move.from), cell(move.to) + (move.collides ? ' (COLLISION: target exists)' : ''), plan.fileRefs.get(move.stem)?.count ?? 0, plan.fileRefs.get(move.stem) ? shortFiles(plan.fileRefs.get(move.stem).files, 5) : '']))}
\`git mv\` moves each file, so that history follows. The server file \`src/endpoints/conversation-threads.js\` is out of scope and keeps its name.

## 2 Exported and module-level functions, classes and constants

${nameTable(byKind('module'))}
## 3 DOM ids

${nameTable(byKind('id'))}
## 4 CSS classes

${nameTable(byKind('class'))}
## 5 \`data-\` attributes and their values, ids of actions, page and event values

${nameTable(byKind('data'))}
## 6 CSS custom properties

${nameTable(byKind('cssvar'))}
## 7 i18n keys

None. The locale files hold no identifier of this mode and are out of scope.

## 8 Test helper names (specs, surface registry steps, fixtures' names)

${nameTable(byKind('test'))}
## 9 Local names, parameters, properties and bare words

${nameTable(byKind('local'))}
## 10 Stored names, not renamed in this commit

These are properties or values in stored data (\`settings.json\`, localStorage, chat files). Tasks 1T and 1U write the new name; the script renames them with \`apply --include-stored\`. "Held back" counts every use of the spelling in the files that the rename changes.

${table(['Old', 'New (storage switch)', 'Held back', 'Files', 'Why'], Object.keys(STORED_TOKENS).sort().map((token) => { const row = plan.heldBack.get(token) ?? { count: 0, files: new Map() }; return [cell(token), STORED_TOKENS[token].next ? cell(STORED_TOKENS[token].next) : 'goes away', row.count, shortFiles(row.files, 3), STORED_TOKENS[token].why]; }))}
Stored sites of names that are internal everywhere else. Each keeps the old spelling; the other uses are renamed (table 9 and 2):

${renderSites(plan)}
Stored names that hold no old stem, so the scan does not list them, and that the plan renames or dissolves:

${table(['Old', 'New', 'Why'], STORED_NAMES_WITHOUT_STEM.map(item => [cell(item.old), item.next.startsWith('`') || item.next.includes(' ') ? item.next : cell(item.next), item.why]))}
## 11 Kept

${table(['Name', 'Why'], Object.entries(KEPT_TOKENS).map(([name, why]) => [cell(name), why]))}
Kept by rule, not by name: the old words as wording (labels such as "New DM", "Pals rail", "Branches"; titles, toasts, accessible names), the text of prompts that is sent to a model (\`[System directive: … DM … thread]\`), prose in comments, and the strings \`'partner'\` and \`'thread'\` (role values, key fallbacks, console messages). Counts by word and place:

${renderResidue(plan)}
## 12 Open points, names that S1 does not decide, collisions and per-file alternatives

${renderOpenPoints(plan, rows)}

${table(['Old', 'New', 'Why'], proposed.map(row => [cell(row.old), cell(row.next) + mark(row.status), row.why ?? '']))}
## 13 Upstream-origin lines that change

Upstream-origin files take only the names that are exports of the renamed modules, plus paths.

${renderUpstreamLines(plan, [...plan.edits.keys()].filter(file => plan.upstreamOrigin.has(file)))}

Names that these files also hold and that stay (the Home code keeps its own spelling):

${[...plan.refusedInUpstream].map(([file, names]) => `- \`${file}\`: ${[...names].map(([name, count]) => `${cell(name)} x${count}`).join(', ')}`).join('\n') || '_None._'}

## 14 Server files that import renamed client names (out of scope, one-line changes)

${renderUpstreamLines(plan, [...plan.edits.keys()].filter(file => file.startsWith('src/')))}

## 15 Unit tests that read a renamed file or its names as text

${describeTextReaders(plan)}
## 16 Left alone on purpose

Names with a stem that no rule renames, found in the files of the scope (not wording). Each is another feature's name or test data:

${[...plan.unclassified].sort(([a], [b]) => a.localeCompare(b)).map(([token, files]) => `- ${cell(token)}: ${[...files].map(file => file.replace('public/scripts/sillybunny-conversation/', '')).slice(0, 3).join(', ')}`).join('\n') || '_None._'}
`;
}

function renderResidue(plan) {
    const words = new Map();
    for (const [key, count] of plan.residue) {
        const [token, context, bucket] = key.split('|');
        if (shapeOf(token) !== 'single') {
            continue;
        }
        const word = token.toLowerCase();
        const row = words.get(word) ?? new Map();
        const label = `${bucket === 'primary' ? 'module' : 'other files'} ${context}`;
        row.set(label, (row.get(label) ?? 0) + count);
        words.set(word, row);
    }
    return table(['Word', 'Where it stays'], [...words].sort(([a], [b]) => a.localeCompare(b)).map(([word, places]) => [cell(word), [...places].sort().map(([label, count]) => `${label} ${count}`).join(', ')]));
}

function writeOutputs(plan, rows, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const markdown = renderMap(plan, rows);
    fs.writeFileSync(path.join(outDir, 'rename-map.md'), markdown);
    const json = {
        base: git(['rev-parse', 'HEAD']).trim(),
        includeStored: plan.includeStored,
        digest: digestOf(plan),
        moves: plan.moves.map(({ from, to }) => ({ from, to })),
        rows: rows.map(row => ({ old: row.old, new: row.next, kind: row.kind, status: row.status, count: row.count, files: Object.fromEntries(row.files) })),
    };
    fs.writeFileSync(path.join(outDir, 'rename-map.json'), `${JSON.stringify(json, null, 2)}\n`);
    return { markdown, json };
}

/**
 * Apply
 */

function applyPlan(plan) {
    for (const move of plan.moves) {
        if (move.collides) {
            throw new Error(`${move.to} exists already`);
        }
    }
    const moved = new Map(plan.moves.map(move => [move.from, move.to]));
    for (const move of plan.moves) {
        git(['mv', move.from, move.to]);
    }
    const changed = { name: 0, value: 0, path: 0, expand: 0, marker: 0 };
    for (const [file, fileEdits] of plan.edits) {
        const target = moved.get(file) ?? file;
        let text = readRepoFile(target);
        for (const edit of [...fileEdits].sort((a, b) => b.start - a.start)) {
            if (text.slice(edit.start, edit.end) !== edit.token) {
                throw new Error(`${file}: expected ${edit.token} at ${edit.start}`);
            }
            text = text.slice(0, edit.start) + edit.next + text.slice(edit.end);
            changed[edit.kind]++;
        }
        fs.writeFileSync(path.join(repoRoot, target), text);
    }
    return { moved: plan.moves.length, edits: changed, files: plan.edits.size };
}

// The copy baseline is held sorted by the rule of its own writer, and a renamed surface id moves a
// record, so the file is written again by that writer.
async function formatFixtures(plan) {
    if (!plan.edits.has('tests/fixtures/copy-baseline.json')) {
        return;
    }
    const helper = await import(pathToFileURL(path.join(repoRoot, 'tests/helpers/copy-baseline.js')).href);
    fs.writeFileSync(helper.COPY_BASELINE_PATH, helper.formatCopyBaseline(helper.readCopyBaseline()));
}

function parseArguments(argv) {
    const options = { includeStored: false, out: process.cwd(), map: null, allowDirty: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--include-stored') {
            options.includeStored = true;
        } else if (argument === '--allow-dirty') {
            options.allowDirty = true;
        } else if (argument === '--out') {
            options.out = path.resolve(argv[++index]);
        } else if (argument === '--map') {
            options.map = path.resolve(argv[++index]);
        } else {
            throw new Error(`unknown argument ${argument}`);
        }
    }
    return options;
}

async function main() {
    const [command = 'inventory', ...rest] = process.argv.slice(2);
    const options = parseArguments(rest);
    const plan = buildPlan({ includeStored: options.includeStored });
    plan.includeStored = options.includeStored;
    const rows = groupRows(plan);
    if (command === 'inventory') {
        writeOutputs(plan, rows, options.out);
        const collisions = rows.filter(row => row.status === 'collision');
        console.log(`${rows.length} names, ${plan.moves.length} files, ${[...plan.edits.values()].reduce((sum, list) => sum + list.length, 0)} edits in ${plan.edits.size} files, ${rows.filter(row => row.status === 'proposed').length} proposed, ${collisions.length} collisions`);
        console.log(`written to ${options.out}`);
        return;
    }
    if (command === 'apply') {
        if (!options.map) {
            throw new Error('apply needs --map <rename-map.json>');
        }
        const reviewed = JSON.parse(fs.readFileSync(options.map, 'utf8'));
        if (reviewed.digest !== digestOf(plan) || reviewed.includeStored !== options.includeStored) {
            throw new Error('the tree or the script no longer gives the reviewed map; run inventory again and review the difference');
        }
        if (rows.some(row => row.status === 'collision') || plan.moves.some(move => move.collides)) {
            throw new Error('the map has collisions');
        }
        if (!options.allowDirty && git(['status', '--porcelain']).trim()) {
            throw new Error('the working tree is not clean');
        }
        const result = applyPlan(plan);
        await formatFixtures(plan);
        console.log(JSON.stringify(result));
        return;
    }
    throw new Error(`unknown command ${command}`);
}

export { buildPlan, findCollisions, groupRows, hasStem, mechanicalName, shapeOf, lineOf, repoRoot };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
