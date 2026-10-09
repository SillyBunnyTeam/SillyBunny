import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { EventEmitter } from '../../public/lib/eventemitter.js';
import { event_types } from '../../public/scripts/events.js';
import { createGroupTurnRouting, getRoutedReplyStatus } from '../../public/scripts/group-turn-routing.js';

export const groupChatsSource = readFileSync(new URL('../../public/scripts/group-chats.js', import.meta.url), 'utf8');
export const groupChatsAst = parse(groupChatsSource, { ecmaVersion: 'latest', sourceType: 'module' });

// Module state of group-chats.js that the loaded functions read and write.
const stateNames = [
    'GROUP_SPEAKER_CONTROLS_HIDDEN_KEY',
    'selectedGroupSpeakerAvatar',
    'groupSpeakerControlsInitialized',
    'activeGroupTypingName',
    'groupSpeakerAvatarRenderKey',
    'is_group_generating',
    'group_generation_id',
    'groupChatQueueOrder',
    'group_activation_strategy',
    'GROUP_MEMBER_MODELS_KEY',
    'openGroupId',
    'groupTurnRouting',
    'groupTurnRoutingApi',
];

/**
 * A minimal jQuery stand-in for the speaker bar and the composer: it keeps the rendered avatar buttons,
 * which of them is highlighted, and the composer's text.
 */
function createPage(handlers, composer) {
    let items = [];
    const wrap = item => ({
        length: 1,
        data: key => key === 'avatar' ? item.avatar : undefined,
        attr(name, value) {
            if (name === 'data-avatar') item.avatar = value;
            return this;
        },
        toggleClass(name, enabled) {
            if (name === 'selected') item.selected = Boolean(enabled);
            return this;
        },
        append() { return this; },
    });
    const container = {
        length: 1,
        on: (event, selector, handler) => { handlers[`${event} ${selector}`] = handler; },
        toggleClass() { return this; },
        find: selector => selector === '.group_speaker_list'
            ? { empty: () => { items = []; return { append: button => items.push(button.item) }; } }
            : { each: callback => items.forEach(item => callback.call(item)) },
    };
    const textarea = {
        length: 1,
        0: { dispatchEvent() {} },
        val(value) {
            if (value === undefined) return composer.value;
            composer.value = String(value);
            return this;
        },
    };
    const $ = target => {
        if (target === '#group_speaker_controls') {
            return container;
        }
        if (target === '#send_textarea') {
            return textarea;
        }
        if (target === '#group_speaker_controls .group_speaker_avatar') {
            return { removeClass: () => items.forEach(item => { item.selected = false; }) };
        }
        if (target === '<button type="button" class="group_speaker_avatar"></button>') {
            const item = { avatar: '', selected: false };
            return { ...wrap(item), item };
        }
        if (typeof target === 'string' && target.startsWith('<')) {
            return { attr() { return this; }, text() { return this; } };
        }
        if (target && typeof target === 'object' && 'avatar' in target) {
            return wrap(target);
        }
        return { length: 0, on() { return this; }, val: () => '' };
    };
    return { $, highlighted: () => items.filter(item => item.selected).map(item => item.avatar) };
}

/**
 * Loads group-chats.js's real functions and module state into a sandbox with an open group, its speaker bar and
 * the composer. Bob wrote the last message. Generate records which member each group reply was asked of and, for
 * a new reply, adds that member's message to the chat. `log` lists the user message and each reply in order.
 * @param {object} [options]
 * @param {string[]} [options.exclude] Functions to leave out so a test can stand in for them
 */
export function createGroupChatsRuntime({ exclude = [] } = {}) {
    const handlers = {};
    const composer = { value: '' };
    const page = createPage(handlers, composer);
    const eventSource = new EventEmitter();
    const changes = [];
    const generations = [];
    const generationOptions = [];
    const log = [];
    eventSource.on(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => changes.push(avatar));
    const noop = () => {};
    const runtime = vm.createContext({
        $: page.$,
        document: { body: { classList: { toggle: noop } } },
        accountStorage: { getItem: () => null },
        getThumbnailUrl: (type, file) => file,
        eventSource,
        event_types,
        selected_group: 'group-1',
        groups: [{ id: 'group-1', chat_id: 'chat-1', members: ['alice.png', 'bob.png', 'carol.png', 'ghost.png'], disabled_members: ['carol.png'] }],
        characters: [
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'bob.png' },
            { name: 'Carol', avatar: 'carol.png' },
            { name: 'Dave', avatar: 'dave.png' },
        ],
        chat: [{ name: 'Bob', original_avatar: 'bob.png', mes: 'Hello there.', is_user: false }],
        online_status: 'connected',
        menu_type: 'group_edit',
        power_user: {},
        system_message_types: { NARRATOR: 'narrator' },
        AbortSignal,
        Event,
        toastr: { warning: noop, error: noop },
        Generate: async (type, options = {}) => {
            const character = runtime.characters[runtime.this_chid];
            generations.push({ type, avatar: character?.avatar });
            generationOptions.push(options);
            log.push(`${type} reply by ${character?.avatar}`);
            if (type === 'normal') {
                runtime.chat.push({ name: character.name, original_avatar: character.avatar, mes: `${character.name} reply`, is_user: false });
            }
        },
        sendMessageAsUser: async text => {
            runtime.chat.push({ name: 'User', mes: text, is_user: true });
            log.push(`user message: ${text}`);
        },
        saveChatConditional: async () => true,
        deleteLastMessage: async () => { runtime.chat.pop(); },
        setExternalAbortController: noop,
        AbortController,
        getBiasStrings: () => ({ messageBias: '' }),
        requestAnimationFrame: callback => callback(),
        ToolManager: { canPerformToolCalls: () => false },
        // Natural order's helpers from utils.js; shuffle keeps group order.
        extractAllWords: value => [...String(value ?? '').matchAll(/\b\w+\b/gim)].map(match => match[0].toLowerCase()),
        shuffle: array => array,
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        talkativeness_default: 0.5,
        createGroupTurnRouting,
        getRoutedReplyStatus,
        setCharacterId: chid => { runtime.this_chid = chid; },
        setCharacterName: noop,
        setSendButtonState: noop,
        hideSwipeButtons: noop,
        showSwipeButtons: noop,
        activateSendButtons: noop,
        deactivateSendButtons: noop,
        unshallowCharacter: async () => {},
    });
    const declarations = groupChatsAst.body.map(node => node.declaration ?? node);
    const state = declarations.filter(node => node.type === 'VariableDeclaration'
        && node.declarations.some(declaration => stateNames.includes(declaration.id.name)));
    const functions = declarations.filter(node => node.type === 'FunctionDeclaration' && !exclude.includes(node.id.name));
    vm.runInContext([...state, ...functions].map(node => groupChatsSource.slice(node.start, node.end)).join('\n'), runtime);
    return { runtime, changes, handlers, generations, generationOptions, log, composer, eventSource, bar: page };
}
