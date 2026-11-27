import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { JSDOM } from 'jsdom';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readPublic = relPath => readFileSync(path.join(repoRoot, 'public', relPath), 'utf8');

/**
 * Best wall time of each run over several interleaved repetitions. The minimum
 * drops garbage collection pauses and scheduler noise, and interleaving makes a
 * burst of machine load hit both runs, so the ratio of the two times reflects
 * how the work grows with the input and not how busy the machine is.
 * @param {() => void} runSmall
 * @param {() => void} runLarge
 * @returns {{ smallMs: number, largeMs: number }}
 */
function bestTimesMs(runSmall, runLarge, repetitions = 9) {
    const time = run => {
        const start = performance.now();
        run();
        return performance.now() - start;
    };
    let smallMs = Infinity;
    let largeMs = Infinity;
    for (let repetition = 0; repetition < repetitions; repetition++) {
        smallMs = Math.min(smallMs, time(runSmall));
        largeMs = Math.min(largeMs, time(runLarge));
    }
    return { smallMs, largeMs };
}

// A fourfold input takes about fourfold time when the work is linear and about
// sixteenfold when it is quadratic, so this limit sits between the two.
const MAX_LINEAR_GROWTH_FOR_4X_INPUT = 8;

// Seed minimal localStorage so i18n module load stays quiet in Node Jest.
if (!global.localStorage) {
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

// Shared mock state for modules that depend on browser-boot singletons.
const mockExtensionSettings = {};
const mockCharacters = [];
const mockGroups = [];
const mockPowerUser = {
    stscript: {
        autocomplete: {
            state: 1,
            showInAllMacroFields: false,
        },
    },
    experimental_macro_engine: false,
};
const mockAutoCompleteTargets = [];
const mockFindMacroAtCursor = jest.fn(() => null);
const mockFindUnclosedScopes = jest.fn(() => []);
const mockSaveSettingsDebounced = jest.fn();

await jest.unstable_mockModule('../public/lib.js', () => ({
    hljs: {
        BACKSLASH_ESCAPE: {},
        QUOTE_STRING_MODE: {},
        registerLanguage: jest.fn(),
        highlight: jest.fn(() => ({ value: '' })),
    },
    morphdom: jest.fn(),
    DOMPurify: { sanitize: value => value },
    Popper: { createPopper: jest.fn() },
    Readability: class FakeReadability {},
    isProbablyReaderable: jest.fn(() => false),
    lodash: {},
    Fuse: class FakeFuse {},
    localforage: {},
    Handlebars: {},
    css: {},
    Bowser: { getParser: () => ({ getResult: () => ({}) }) },
    DiffMatchPatch: class FakeDmp {},
    SVGInject: jest.fn(),
    showdown: {},
    markdownit: jest.fn(),
    markdownItEmoji: jest.fn(),
    markdownItCjkFriendly: jest.fn(),
    moment: jest.fn(() => ({ format: () => '' })),
    seedrandom: jest.fn(),
    droll: {},
    slideToggle: jest.fn(),
    chalk: {},
    yaml: {},
    chevrotain: {},
    gzipSync: jest.fn(),
    gzip: jest.fn(),
    sha256: jest.fn(() => ''),
    initLibraryShims: jest.fn(),
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: mockCharacters,
    chat: [],
    default_user_avatar: 'img/user-default.png',
    eventSource: { on: jest.fn(), emit: jest.fn(), removeListener: jest.fn() },
    event_types: { APP_READY: 'app_ready', CHAT_CHANGED: 'chat_changed' },
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn((_type, file) => `/thumb/${file}`),
    is_send_press: false,
    messageFormatting: jest.fn(text => text),
    name1: 'User',
    saveSettingsDebounced: mockSaveSettingsDebounced,
    substituteParams: jest.fn(text => text),
    this_chid: 0,
}));

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: mockExtensionSettings,
    saveMetadataDebounced: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    editGroup: jest.fn(),
    groups: mockGroups,
    selected_group: null,
}));

await jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    user_avatar: 'persona-a.png',
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: mockPowerUser,
    registerDebugFunction: jest.fn(),
    fuzzySearchCharacters: jest.fn(() => []),
    fuzzySearchGroups: jest.fn(() => []),
    loadMovingUIState: jest.fn(),
    playMessageSound: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(pointer: coarse)',
    getRevealScrollTop: jest.fn(() => 0),
    positionPopover: jest.fn(),
    openActionMenu: jest.fn(),
    openPopover: jest.fn(),
    closeActionMenu: jest.fn(),
    isActionMenuOpen: jest.fn(() => false),
    getActionMenuTrigger: jest.fn(() => null),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => null,
    getConversationChats: () => [],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona-a.png',
    getConversationRecord: () => null,
    getCurrentCharAvatar: () => '',
    getCurrentCharName: () => '',
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: {
        resolve: jest.fn(() => null),
        branchChat: jest.fn(),
    },
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    addConversationReminder: jest.fn(),
    buildConversationMessageReplyReference: jest.fn(),
    getConversationAttachmentSummary: jest.fn(() => ''),
    getConversationSeenAt: jest.fn(() => 0),
    getConversationMessages: jest.fn(() => []),
    saveConversationMessages: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    getConversationMessageAvatar: jest.fn(() => ''),
    getConversationMessageReceipt: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    escapeRegExp: s => String(s || ''),
    getCharacterMentionHandles: () => [],
    parseAvatarList: () => [],
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => mockCharacters.find(c => c.avatar === avatar) ?? null,
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-deletion.js', () => ({
    dropQueueItemsOfDeletedMessages: jest.fn(),
    removeChatMessages: jest.fn(() => []),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pin-events-ui.js', () => ({
    createPinnedMark: jest.fn(() => ({})),
    detachPinEventRows: jest.fn(() => ({ rows: new Map(), focused: null })),
    placePinEventRows: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reactions-ui.js', () => ({
    createReactionChips: jest.fn(() => null),
    createToolbarReactionButtons: jest.fn(() => []),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-key.js', () => ({
    buildConversationRenderKey: (...parts) => parts.join('|'),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/screen-target.js', () => ({
    getConversationRenderChatId: () => '',
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/safe-url.js', () => ({
    toSafeAttachmentUrl: value => value || '',
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-editor/status-page.js', () => ({
    createStatusPage: values => ({ element: { classList: { add: jest.fn() }, values } }),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getPrimaryTypingParticipant: () => null,
    stripPreviewText: value => String(value || ''),
    updateLastPreviewFromConversation: jest.fn(),
    withTypingParticipant: async (_c, fn) => fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({
    promptConversationText: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    commitCharacterReplyCommands: jest.fn(),
    extractCharacterReplyCommands: jest.fn(() => ({ text: '', commands: [] })),
    generateConversationRaw: jest.fn(),
    generateSelfieFromContext: jest.fn(),
    getCharacterReplyCommandMetadata: jest.fn(() => ({})),
    reportConversationGenerationError: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    buildConversationPromptMessages: jest.fn(() => []),
    buildConversationSystemPrompt: jest.fn(() => ''),
    renderConversationAttachments: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleConversationListRender: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/tts.js', () => ({
    narrateConversationMessage: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/world-info.js', () => ({
    getConversationWorldInfo: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-slash-commands.js', () => ({
    appendConversationOocNote: jest.fn(),
    handleConversationSlashAction: jest.fn(),
    parseConversationReminderArgs: jest.fn(),
    parseConversationSlashCommand: jest.fn(),
    quickConversationSummarize: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    updateSecretDisplay: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/sillybunny-settings-macros.js', () => ({
    formatSettingsMacroExamples: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    world_names: [],
}));

await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: class FakePopup {},
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: fn => fn,
    debounceAsync: fn => fn,
    delay: async () => {},
    escapeRegex: s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    flashHighlight: jest.fn(),
    getSortableDelay: () => 0,
    showFontAwesomePicker: jest.fn(async () => null),
    uuidv4: () => '00000000-0000-4000-8000-000000000000',
}));

await jest.unstable_mockModule('../public/scripts/extensions/quick-reply/src/QuickReply.js', () => ({
    QuickReply: class FakeQuickReply {
        static from(props) { return Object.assign(new this(), props); }
    },
}));

await jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({
    executeSlashCommandsOnChatInput: jest.fn(async () => ({ pipe: '' })),
    executeSlashCommandsWithOptions: jest.fn(async () => ({ pipe: '' })),
    setSlashCommandAutoComplete: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/autocomplete/AutoComplete.js', () => ({
    AUTOCOMPLETE_STATE: { DISABLED: 0, ALL: 1, MIN_LENGTH: 2 },
    AutoComplete: class FakeAutoComplete {
        constructor(textarea) {
            mockAutoCompleteTargets.push(textarea);
            this.domWrap = { dataset: {} };
            this.detailsWrap = { dataset: {} };
        }
    },
}));

await jest.unstable_mockModule('../public/scripts/autocomplete/MacroAutoCompleteHelper.js', () => ({
    findMacroAtCursor: mockFindMacroAtCursor,
    findUnclosedScopes: mockFindUnclosedScopes,
    getMacroAutoCompleteAt: jest.fn(),
}));

const {
    resolveCssLengthPx,
    shouldIgnoreLayoutResizeEntries,
} = await import('../public/scripts/sillybunny-editor/side-panel.js');

const {
    createOffscreenMessageTracker,
    OFFSCREEN_MESSAGE_SIZED_CLASS,
} = await import('../public/scripts/chat-render-lifecycle/offscreen-messages.js');

const {
    bindConversationMessageMenuTimeline,
    registerMessageMenuReactions,
} = await import('../public/scripts/sillybunny-conversation/message-menu.js');

const {
    buildConversationReceiptMap,
} = await import('../public/scripts/sillybunny-conversation/timeline-render.js');

const { executeSlashCommandsWithOptions } = await import('../public/scripts/slash-commands.js');
const { SlashCommand } = await import('../public/scripts/slash-commands/SlashCommand.js');
const { SlashCommandAbortController } = await import('../public/scripts/slash-commands/SlashCommandAbortController.js');
const { ARGUMENT_TYPE, SlashCommandArgument } = await import('../public/scripts/slash-commands/SlashCommandArgument.js');
const { PARSER_FLAG, SlashCommandParser } = await import('../public/scripts/slash-commands/SlashCommandParser.js');
const { SlashCommandScope } = await import('../public/scripts/slash-commands/SlashCommandScope.js');
const { QuickReplySet } = await import('../public/scripts/extensions/quick-reply/src/QuickReplySet.js');

const {
    MACRO_AUTOCOMPLETE_MODE,
    processMacroAutoCompleteMutations,
    shouldActivateMacroAutocomplete,
} = await import('../public/scripts/autocomplete/MacroAutoComplete.js');

const {
    createEditorSession,
    DIRTY_DEBOUNCE_MS,
    DRAFT_INTERVAL_MS,
} = await import('../public/scripts/sillybunny-editor/session.js');

const {
    applyListChange,
    captureListChange,
} = await import('../public/scripts/sillybunny-motion.js');

const {
    disconnectExtensionSettingsObservers,
    reconnectExtensionSettingsObservers,
    watchExtensionSettings,
} = await import('../public/scripts/sillybunny-settings-presentation.js');

const { TabManager } = await import('../public/scripts/extensions/third-party/ChatCompletionTabs/components/tab-manager.js');

const originalGlobals = {
    document: global.document,
    window: global.window,
    HTMLElement: global.HTMLElement,
    Element: global.Element,
    MutationObserver: global.MutationObserver,
    localStorage: global.localStorage,
    fetch: global.fetch,
    scheduler: global.scheduler,
    $: global.$,
};

afterEach(() => {
    jest.clearAllMocks();
    mockCharacters.length = 0;
    mockGroups.length = 0;
    mockPowerUser.stscript.autocomplete.state = 1;
    mockPowerUser.stscript.autocomplete.showInAllMacroFields = false;
    global.document = originalGlobals.document;
    global.window = originalGlobals.window;
    global.HTMLElement = originalGlobals.HTMLElement;
    global.Element = originalGlobals.Element;
    global.MutationObserver = originalGlobals.MutationObserver;
    global.localStorage = originalGlobals.localStorage;
    global.fetch = originalGlobals.fetch;
    global.scheduler = originalGlobals.scheduler;
    global.$ = originalGlobals.$;
});

describe('Workstream 1: side-panel dock smoothness & offscreen content-visibility protection', () => {
    test('resolveCssLengthPx evaluates units, calc/min/max/clamp, and var() without DOM probe appends', () => {
        const customProps = new Map([
            ['--sheldWidth', 'min(62vw, 900px)'],
            ['--sb-gutter', '2rem'],
        ]);
        const metrics = {
            viewportWidth: 1440,
            viewportHeight: 900,
            rootFontSize: 16,
            readVar: name => customProps.get(name) ?? '',
        };

        expect(resolveCssLengthPx('480px', metrics)).toBe(480);
        expect(resolveCssLengthPx('50vw', metrics)).toBe(720);
        expect(resolveCssLengthPx('50%', metrics)).toBe(720);
        expect(resolveCssLengthPx('2.5rem', metrics)).toBe(40);
        expect(resolveCssLengthPx('calc(100vw - 4rem)', metrics)).toBe(1376);
        expect(resolveCssLengthPx('var(--sheldWidth)', metrics)).toBeCloseTo(892.8, 3);
        expect(resolveCssLengthPx('clamp(320px, var(--sb-gutter) + 400px, 600px)', metrics)).toBe(432);
        expect(resolveCssLengthPx('max(300px, min(50vw, 600px))', metrics)).toBe(600);

        const source = readPublic('scripts/sillybunny-editor/side-panel.js');
        expect(source).not.toMatch(/documentElement\.append\(/);
    });

    test('shouldIgnoreLayoutResizeEntries suppresses ResizeObserver ticks during dock transition and composer-only docked resizes', () => {
        const chatShell = {
            attributes: new Set(['data-sb-dock-moving']),
            hasAttribute(name) { return this.attributes.has(name); },
        };
        const composer = { id: 'form_sheld' };
        const bodyClasses = new Set(['sb-has-docked-panel']);
        const body = { classList: { contains: name => bodyClasses.has(name) } };

        // While #sheld[data-sb-dock-moving] is active, ignore #sheld RO ticks.
        expect(shouldIgnoreLayoutResizeEntries([{ target: chatShell }], { chatShell, body })).toBe(true);

        // Once settled, #sheld resize triggers layout, while #form_sheld-only resize is ignored in docked mode.
        chatShell.attributes.delete('data-sb-dock-moving');
        expect(shouldIgnoreLayoutResizeEntries([{ target: chatShell }], { chatShell, body })).toBe(false);
        expect(shouldIgnoreLayoutResizeEntries([{ target: composer }], { chatShell, body })).toBe(true);

        // In sheet mode, #form_sheld resize must NOT be ignored.
        bodyClasses.add('sb-has-side-panel-sheet');
        expect(shouldIgnoreLayoutResizeEntries([{ target: composer }], { chatShell, body })).toBe(false);
    });

    test('offscreen-messages pauses .sb-mes-sized invalidation during data-sb-dock-moving and flushes once after transitionend', () => {
        const listeners = new Map();
        const attrs = new Set();
        const transitionHost = {
            hasAttribute: name => attrs.has(name),
            addEventListener: (type, fn) => {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(fn);
            },
            removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
            dispatch(type, event) {
                for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
            },
        };

        let containerWidth = 800;
        const sizedClasses = new Set(['mes', OFFSCREEN_MESSAGE_SIZED_CLASS]);
        const msg = {
            classList: {
                add: c => sizedClasses.add(c),
                remove: c => sizedClasses.delete(c),
                contains: c => sizedClasses.has(c),
            },
            getBoundingClientRect: () => ({ height: 120 }),
        };
        const container = {
            get clientWidth() { return containerWidth; },
            getBoundingClientRect: () => ({ width: containerWidth }),
            querySelectorAll: () => [msg],
            closest: () => transitionHost,
        };

        const observers = [];
        class FakeRO {
            constructor(cb) { this.cb = cb; observers.push(this); }
            observe() {}
            unobserve() {}
            disconnect() {}
        }

        const scheduledTimers = [];
        const tracker = createOffscreenMessageTracker({
            container,
            transitionHost,
            ResizeObserverImpl: FakeRO,
            setTimeoutImpl: (fn, ms) => {
                const handle = { fn, ms, cleared: false };
                scheduledTimers.push(handle);
                return handle;
            },
            clearTimeoutImpl: handle => { if (handle) handle.cleared = true; },
            widthSettleMs: 120,
        });

        // Initial baseline container observation at 800px.
        observers[1].cb([{ target: container, contentRect: { width: 800 } }]);
        expect(sizedClasses.has(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);

        // Container width changes mid-dock transition -> must NOT clear .sb-mes-sized yet.
        attrs.add('data-sb-dock-moving');
        containerWidth = 620;
        observers[1].cb([{ target: container, contentRect: { width: 700 } }]);
        expect(sizedClasses.has(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);

        // Transition completes on width -> invalidation flushes ONCE at final settled width (620px).
        attrs.delete('data-sb-dock-moving');
        transitionHost.dispatch('transitionend', { target: transitionHost, propertyName: 'width' });
        expect(sizedClasses.has(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);

        // Re-mark and trigger a dock transition that ends back at the same width (<1px delta) -> no redundant invalidation.
        sizedClasses.add(OFFSCREEN_MESSAGE_SIZED_CLASS);
        attrs.add('data-sb-dock-moving');
        containerWidth = 620.4;
        observers[1].cb([{ target: container, contentRect: { width: 620.4 } }]);
        attrs.delete('data-sb-dock-moving');
        transitionHost.dispatch('transitionend', { target: transitionHost, propertyName: 'width' });
        expect(sizedClasses.has(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);

        tracker.dispose();
    });
});

describe('Workstream 2: Conversation Mode O(N) receipts, delegated hover & cross-tab worker lock', () => {
    test('buildConversationReceiptMap matches O(N^2) semantics and its time grows linearly with the message count', () => {
        const messages = [
            { id: 'u1', role: 'user', created_at: 1000 },
            { id: 'c1', role: 'character', created_at: 2000 },
            { id: 'u2', role: 'user', created_at: 3000 },
            { id: 's1', role: 'system', created_at: 3500 },
            { id: 'u3', role: 'user', created_at: 5000 },
        ];
        const map = buildConversationReceiptMap(messages, 4000);
        expect(map.get('u1')).toBe('Seen'); // followed by character reply c1
        expect(map.get('c1')).toBe(''); // non-user message
        expect(map.get('u2')).toBe('Seen'); // created_at <= seenAt (4000)
        expect(map.get('s1')).toBe(''); // system message
        expect(map.get('u3')).toBe('Delivered'); // created_at > seenAt and no reply after

        const buildThread = count => Array.from({ length: count }, (_, i) => ({
            id: `m-${i}`,
            role: i % 2 === 0 ? 'user' : 'character',
            created_at: 1000 + i,
        }));
        const smallThread = buildThread(20000);
        const largeThread = buildThread(80000);
        const largeMap = buildConversationReceiptMap(largeThread, 0);
        expect(largeMap.size).toBe(80000);
        expect(largeMap.get('m-0')).toBe('Seen');
        expect(largeMap.get('m-79998')).toBe('Seen');
        expect(largeMap.get('m-79999')).toBe('');

        buildConversationReceiptMap(smallThread, 0);
        const { smallMs, largeMs } = bestTimesMs(
            () => buildConversationReceiptMap(smallThread, 0),
            () => buildConversationReceiptMap(largeThread, 0),
        );
        expect(largeMs / smallMs).toBeLessThan(MAX_LINEAR_GROWTH_FOR_4X_INPUT);

        const timelineSrc = readPublic('scripts/sillybunny-conversation/timeline-render.js');
        expect(timelineSrc).toContain('getCachedEffectiveStatus');
        expect(timelineSrc).toContain('insertConversationDayDividers(timeline, messages, nodeById)');
        expect(timelineSrc).toContain('sb-conversation-timeline-mounted');
        expect(timelineSrc).toContain('updateMessageReactionsInPlace');
        expect(timelineSrc).toContain('placePinEventRows');
    });

    test('message-menu.js delegates hover/focus on #sb_conversation_timeline, deduplicates pointerover, and syncs toolbar reactions', () => {
        const source = readPublic('scripts/sillybunny-conversation/message-menu.js');
        expect(source).not.toMatch(/document\.addEventListener\(\s*['"]pointerover['"]/);
        expect(source).not.toMatch(/document\.addEventListener\(\s*['"]focusin['"]/);
        expect(source).toContain('export function bindConversationMessageMenuTimeline');
        expect(source).toContain('lastHoveredItem');
        expect(source).toContain('syncToolbarQuickRow(item)');

        class FakeElement {
            constructor() {
                this.dataset = {};
                this.attrs = new Map();
                this.listeners = new Map();
            }
            addEventListener(type, fn) {
                if (!this.listeners.has(type)) this.listeners.set(type, []);
                this.listeners.get(type).push(fn);
            }
            dispatch(type, event) {
                for (const fn of this.listeners.get(type) ?? []) fn(event);
            }
            hasAttribute(name) { return this.attrs.has(name); }
            toggleAttribute(name, force) {
                if (force) this.attrs.set(name, '');
                else this.attrs.delete(name);
            }
            closest() { return null; }
            querySelector() { return null; }
        }
        class FakeHTMLElement extends FakeElement {}
        global.Element = FakeElement;
        global.HTMLElement = FakeHTMLElement;
        global.document = { body: { classList: { contains: () => false } } };

        const makeMessageItem = (id) => {
            const item = new FakeHTMLElement();
            item.id = id;
            item.dataset = { messageId: id, showHeader: 'true' };
            const toolbarMeasure = jest.fn(() => ({ left: 100, right: 200, width: 100 }));
            const toolbar = new FakeHTMLElement();
            toolbar.getBoundingClientRect = toolbarMeasure;
            const metaChild = { getBoundingClientRect: () => ({ left: 10, right: 50, width: 40 }) };
            const meta = new FakeHTMLElement();
            meta.children = [metaChild];
            item.closest = selector => (selector === '.sb-conversation-message' ? item : null);
            item.querySelector = (selector) => {
                if (selector === '.sb-conversation-message-actions') return toolbar;
                if (selector === '.sb-conversation-message-meta') return meta;
                return null;
            };
            const innerTarget = new FakeHTMLElement();
            innerTarget.closest = selector => (selector === '.sb-conversation-message' ? item : null);
            return { item, innerTarget, toolbarMeasure };
        };

        const syncToolbarReactions = jest.fn();
        const bindReactionChips = jest.fn();
        registerMessageMenuReactions({
            buildMenuReactions: () => [],
            syncToolbarReactions,
            bindReactionChips,
        });
        expect(bindReactionChips).toHaveBeenCalledTimes(1);

        const timeline = new FakeHTMLElement();
        bindConversationMessageMenuTimeline(timeline);
        expect(timeline.dataset.sbConversationMenuBound).toBe('1');

        const first = makeMessageItem('m1');
        const second = makeMessageItem('m2');

        // Repeated pointerover inside the same message deduplicates toolbar sync and layout measurement.
        timeline.dispatch('pointerover', { target: first.innerTarget });
        timeline.dispatch('pointerover', { target: first.innerTarget });
        expect(syncToolbarReactions).toHaveBeenCalledTimes(1);
        expect(syncToolbarReactions).toHaveBeenLastCalledWith(first.item);
        expect(first.toolbarMeasure).toHaveBeenCalledTimes(1);

        // Moving to a second message syncs both quick row and clearance for the new item.
        timeline.dispatch('pointerover', { target: second.innerTarget });
        expect(syncToolbarReactions).toHaveBeenCalledTimes(2);
        expect(syncToolbarReactions).toHaveBeenLastCalledWith(second.item);
        expect(second.toolbarMeasure).toHaveBeenCalledTimes(1);

        // Keyboard focusin also syncs toolbar reactions and meta clearance.
        timeline.dispatch('focusin', { target: first.innerTarget });
        expect(syncToolbarReactions).toHaveBeenCalledTimes(3);
        expect(syncToolbarReactions).toHaveBeenLastCalledWith(first.item);
    });

    test('auto-engine.js gates background worker ticks via createWorkerLock and createWorkerRunner', () => {
        const source = readPublic('scripts/sillybunny-conversation/auto-engine.js');
        expect(source).toContain('import { createWorkerLock } from \'./worker-lock.js\'');
        expect(source).toContain('import { createWorkerRunner } from \'./worker-runner.js\'');
        expect(source).toContain('createWorkerRunner({');
        expect(source).toContain('lock: createWorkerLock()');
    });
});

describe('Workstream 3: O(N) STScript parser benchmark, Quick Reply run isolation, and MacroAutoComplete wiring', () => {
    test('parses piped STScript commands with embedded macro pipes in time that grows linearly with the command count', () => {
        if (!SlashCommandParser.commands.echo) {
            SlashCommandParser.addCommandObjectUnsafe(SlashCommand.fromProps({
                name: 'echo',
                callback: (_args, value) => String(value ?? ''),
            }));
        }

        const buildScript = count => Array.from({ length: count }, (_, i) => (
            i % 50 === 0
                ? `/echo {{random::alpha|beta|gamma}} item ${i}`
                : `/echo item ${i}`
        )).join(' | ');
        const smallScript = buildScript(1000);
        const largeScript = buildScript(4000);
        const parser = new SlashCommandParser();

        const closure = parser.parse(largeScript);
        expect(closure.executorList).toHaveLength(4000);
        expect(closure.executorList[0].unnamedArgumentList[0].value).toBe('{{random::alpha|beta|gamma}} item 0');
        expect(closure.executorList[3999].unnamedArgumentList[0].value).toBe('item 3999');

        // Warm up the JIT on both sizes so tier-up cost does not land in the first measurement.
        parser.parse(smallScript);
        parser.parse(smallScript);
        const { smallMs, largeMs } = bestTimesMs(
            () => parser.parse(smallScript),
            () => parser.parse(largeScript),
        );
        expect(largeMs / smallMs).toBeLessThan(MAX_LINEAR_GROWTH_FOR_4X_INPUT);
    });

    test('incremental isInsideMacroBraces and zero-slice testSymbol preserve split-brace and escaping edge cases', () => {
        if (!SlashCommandParser.commands.echo) {
            SlashCommandParser.addCommandObjectUnsafe(SlashCommand.fromProps({
                name: 'echo',
                callback: (_args, value) => String(value ?? ''),
            }));
        }

        const parser = new SlashCommandParser();
        // Split closing brace before pipe inside macro: `{{foo}|bar}}` stays inside macro!
        const c1 = parser.parse('/echo {{foo}|bar}} | /echo after');
        expect(c1.executorList).toHaveLength(2);
        expect(c1.executorList[0].unnamedArgumentList[0].value).toBe('{{foo}|bar}}');
        expect(c1.executorList[1].unnamedArgumentList[0].value).toBe('after');

        // Strict escaping with backslash sequences before pipe.
        const c2 = parser.parse('/echo a \\| b \\\\| /echo c', true, { [PARSER_FLAG.STRICT_ESCAPING]: true });
        expect(c2.executorList).toHaveLength(2);
        expect(c2.executorList[0].unnamedArgumentList[0].value).toBe('a | b \\');
        expect(c2.executorList[1].unnamedArgumentList[0].value).toBe('c');
    });

    test('addCommandObjectUnsafe defers Error.stack parsing until metadata properties are actually read', () => {
        let prepareCalls = 0;
        const originalPrepare = Error.prepareStackTrace;
        Error.prepareStackTrace = (err, stack) => {
            prepareCalls++;
            return originalPrepare
                ? originalPrepare(err, stack)
                : stack.map(frame => `    at ${frame.toString()}`).join('\n');
        };

        const cmdName = `perf_lazy_meta_${Date.now()}`;
        const cmd = SlashCommand.fromProps({ name: cmdName, callback: () => '' });
        try {
            SlashCommandParser.addCommandObjectUnsafe(cmd);

            // Registration defines lazy getters and must NOT eagerly format Error.stack!
            expect(prepareCalls).toBe(0);
            expect(typeof Object.getOwnPropertyDescriptor(cmd, 'source')?.get).toBe('function');

            // First read of .source resolves once and memoizes onto a plain own data property.
            const firstSource = cmd.source;
            expect(typeof firstSource).toBe('string');
            expect(prepareCalls).toBe(1);
            expect(Object.getOwnPropertyDescriptor(cmd, 'source')?.get).toBeUndefined();
            expect(cmd.isExtension).toBe(false);
            expect(cmd.isThirdParty).toBe(false);
            expect(prepareCalls).toBe(1);
        } finally {
            Error.prepareStackTrace = originalPrepare;
            delete SlashCommandParser.commands[cmdName];
        }
    });

    test('overlapping Quick Reply runs of the same script keep their own closures, scopes and abort controllers', async () => {
        const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));
        const textArgument = () => [SlashCommandArgument.fromProps({
            description: 'text',
            typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.CLOSURE],
        })];
        const log = [];
        const gates = [];
        const commandNames = ['qrtestsetv', 'qrtestrec', 'qrtestdefer', 'qrtestwait'];
        const addCommand = props => SlashCommandParser.addCommandObjectUnsafe(SlashCommand.fromProps({ callback: async () => '', ...props }));
        addCommand({
            name: 'qrtestsetv',
            unnamedArgumentList: textArgument(),
            callback: async (args, value) => {
                args._scope.letVariable(args.key, value);
                return '';
            },
        });
        addCommand({
            name: 'qrtestrec',
            unnamedArgumentList: textArgument(),
            callback: async (_args, value) => {
                log.push(String(value));
                return String(value);
            },
        });
        addCommand({
            name: 'qrtestdefer',
            unnamedArgumentList: textArgument(),
            callback: async (_args, closure) => {
                await new Promise(resolve => gates.push(resolve));
                return (await closure.execute())?.pipe ?? '';
            },
        });
        addCommand({
            name: 'qrtestwait',
            unnamedArgumentList: textArgument(),
            callback: async () => {
                await new Promise(resolve => gates.push(resolve));
                return '';
            },
        });

        // Same shape as executeSlashCommandsWithOptions: every run parses its own closure tree.
        const parser = new SlashCommandParser();
        executeSlashCommandsWithOptions.mockImplementation(async (text, options = {}) => {
            const closure = parser.parse(text, true, options.parserFlags ?? null, options.abortController ?? new SlashCommandAbortController());
            closure.scope.parent = options.scope;
            closure.source = options.source;
            return closure.execute();
        });
        global.document = { querySelector: () => ({ value: '', focus: () => {} }) };

        const quickReplySet = new QuickReplySet({ name: 'Overlap' });
        const runQuickReply = (message, who, abortController = null) => {
            const scope = new SlashCommandScope();
            scope.setMacro('arg::who', who);
            const qr = { message, label: 'Run', abortController, updateEditorProgress: () => {} };
            const executionOptions = abortController ? { abortController } : {};
            return quickReplySet.executeWithOptions(qr, { isRun: true, scope, executionOptions });
        };

        try {
            // Run B starts while run A waits inside its deferred closure: each body must read its own scope.
            const variableScript = '/qrtestsetv key=who {{arg::who}} | /qrtestdefer {: /qrtestrec {{var::who}} :}';
            const runA = runQuickReply(variableScript, 'A');
            await nextTick();
            const runB = runQuickReply(variableScript, 'B');
            await nextTick();
            expect(gates).toHaveLength(2);
            gates.splice(0).forEach(open => open());
            await Promise.all([runA, runB]);
            expect(log).toEqual(['A', 'B']);

            // Aborting run A must not reach run B's closure, and run A's body must not run.
            log.length = 0;
            const abortScript = '/qrtestwait go | /qrtestdefer {: /qrtestrec ran-{{arg::who}} :}';
            const abortA = new SlashCommandAbortController();
            const abortB = new SlashCommandAbortController();
            const abortedRun = runQuickReply(abortScript, 'A', abortA);
            await nextTick();
            const otherRun = runQuickReply(abortScript, 'B', abortB);
            await nextTick();
            gates.splice(0).forEach(open => open());
            await nextTick();
            abortA.abort('stop A');
            gates.splice(0).forEach(open => open());
            await Promise.allSettled([abortedRun, otherRun]);
            expect(log).toEqual(['ran-B']);
        } finally {
            gates.splice(0).forEach(open => open());
            executeSlashCommandsWithOptions.mockImplementation(async () => ({ pipe: '' }));
            for (const name of commandNames) {
                delete SlashCommandParser.commands[name];
            }
        }
    });

    test('a command removed from the registry is unknown to the next Quick Reply run of the same script', async () => {
        const calls = [];
        SlashCommandParser.addCommandObjectUnsafe(SlashCommand.fromProps({
            name: 'qrtestgone',
            callback: async (_args, value) => {
                calls.push(String(value));
                return '';
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'text', typeList: [ARGUMENT_TYPE.STRING] })],
        }));
        const parser = new SlashCommandParser();
        executeSlashCommandsWithOptions.mockImplementation(async (text, options = {}) => {
            const closure = parser.parse(text, true, options.parserFlags ?? null, new SlashCommandAbortController());
            closure.scope.parent = options.scope;
            return closure.execute();
        });
        global.document = { querySelector: () => ({ value: '', focus: () => {} }) };
        const quickReplySet = new QuickReplySet({ name: 'Removal' });
        const runScript = () => quickReplySet.executeWithOptions(
            { message: '/qrtestgone x', label: 'Run', updateEditorProgress: () => {} },
            { isRun: true, scope: new SlashCommandScope() },
        );

        try {
            await runScript();
            expect(calls).toEqual(['x']);
            delete SlashCommandParser.commands.qrtestgone;
            await expect(runScript()).rejects.toThrow(/Unknown command/);
            expect(calls).toEqual(['x']);
        } finally {
            executeSlashCommandsWithOptions.mockImplementation(async () => ({ pipe: '' }));
            delete SlashCommandParser.commands.qrtestgone;
        }
    });

    test('MacroAutoComplete gates MacroParser calls on shouldShowNormally && text.includes("{{")', () => {
        // Default: showInAllMacroFields=false -> must short-circuit before findMacroAtCursor/findUnclosedScopes.
        expect(shouldActivateMacroAutocomplete('{{user}} hello', 8, { isForced: false, autocompleteMode: MACRO_AUTOCOMPLETE_MODE.DEFAULT })).toBe(false);
        expect(mockFindMacroAtCursor).not.toHaveBeenCalled();
        expect(mockFindUnclosedScopes).not.toHaveBeenCalled();

        // Enabled mode, plain prose without '{{' -> must short-circuit without parsing!
        mockPowerUser.stscript.autocomplete.showInAllMacroFields = true;
        expect(shouldActivateMacroAutocomplete('Plain narrative text without macros.', 20)).toBe(false);
        expect(mockFindMacroAtCursor).not.toHaveBeenCalled();
        expect(mockFindUnclosedScopes).not.toHaveBeenCalled();

        // Enabled mode WITH '{{' -> proceeds to macro check.
        expect(shouldActivateMacroAutocomplete('Hello {{', 8)).toBe(true);
    });

    test('MacroAutoComplete observer wires data-macros inputs added inside message text and skips prose', async () => {
        const dom = new JSDOM(`<!doctype html><body>
            <div id="chat"><div class="mes"><div class="mes_block">
                <div class="mes_text"></div>
                <div class="mes_reasoning"></div>
            </div></div></div>
            <div id="elsewhere"></div>
        </body>`);
        const { window } = dom;
        Object.assign(global, {
            window,
            document: window.document,
            Element: window.Element,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLInputElement: window.HTMLInputElement,
        });
        const observer = new window.MutationObserver(processMacroAutoCompleteMutations);
        observer.observe(window.document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-macros'],
        });
        const flush = () => new Promise(resolve => setTimeout(resolve, 0));
        const mesText = window.document.querySelector('#chat .mes_text');
        const mesReasoning = window.document.querySelector('#chat .mes_reasoning');
        mockAutoCompleteTargets.length = 0;

        try {
            // messageEdit() appends this textarea straight into .mes_text.
            const editTextarea = window.document.createElement('textarea');
            editTextarea.id = 'curEditTextarea';
            editTextarea.dataset.macros = '';
            mesText.append(editTextarea);
            await flush();
            expect(mockAutoCompleteTargets).toEqual([editTextarea]);

            // A real input inside a wrapper that is added to message text is found as well.
            const wrapper = window.document.createElement('div');
            const nestedInput = window.document.createElement('input');
            nestedInput.dataset.macros = 'true';
            wrapper.append(nestedInput);
            mesReasoning.append(wrapper);
            await flush();
            expect(mockAutoCompleteTargets).toEqual([editTextarea, nestedInput]);

            // An existing field in message text that gains data-macros later is wired too.
            const lateTextarea = window.document.createElement('textarea');
            mesText.append(lateTextarea);
            await flush();
            lateTextarea.dataset.macros = '';
            await flush();
            expect(mockAutoCompleteTargets).toEqual([editTextarea, nestedInput, lateTextarea]);

            // Prose churn adds no field and wires nothing.
            const paragraph = window.document.createElement('p');
            paragraph.innerHTML = 'Some <em>formatted</em> <span>reply</span> text';
            mesText.append(paragraph, window.document.createTextNode(' more'));
            await flush();
            expect(mockAutoCompleteTargets).toHaveLength(3);

            // The same field outside message text is wired as before.
            const otherTextarea = window.document.createElement('textarea');
            otherTextarea.dataset.macros = '';
            window.document.getElementById('elsewhere').append(otherTextarea);
            await flush();
            expect(mockAutoCompleteTargets).toHaveLength(4);
            expect(mockAutoCompleteTargets[3]).toBe(otherTextarea);
        } finally {
            observer.disconnect();
            delete global.HTMLTextAreaElement;
            delete global.HTMLInputElement;
        }
    });
});

describe('Workstream 4: editor session, picker windowing, list-focus cleanup, motion batching, QuickReply & CSS fixes', () => {
    test('session.js schedules zero intervals when clean and arms a single one-shot draft timer only on edits', () => {
        let model = { name: 'Alice' };
        let snapshotCalls = 0;
        const setIntervalSpy = jest.fn(() => 999);
        const clearIntervalSpy = jest.fn();
        const timeouts = new Map();
        let nextTimeoutId = 1;
        const timers = {
            setInterval: setIntervalSpy,
            clearInterval: clearIntervalSpy,
            setTimeout: jest.fn((fn, ms) => {
                const id = nextTimeoutId++;
                timeouts.set(id, { fn, ms });
                return id;
            }),
            clearTimeout: jest.fn(id => timeouts.delete(id)),
        };
        const drafts = { read: jest.fn(() => null), write: jest.fn(), remove: jest.fn() };
        const session = createEditorSession({
            captureSnapshot: () => { snapshotCalls++; return { ...model }; },
            restoreSnapshot: s => { model = { ...s }; },
            persist: async () => {},
            drafts,
            timers,
        });

        session.open({ mode: 'edit', entityId: 'alice.png' });
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(timeouts.size).toBe(0);

        const callsAfterOpen = snapshotCalls;
        expect(drafts.write).not.toHaveBeenCalled();
        expect(snapshotCalls).toBe(callsAfterOpen);

        // Editing arms one-shot dirty debounce (300ms) + one-shot draft timer (5000ms).
        model.name = 'Alice Updated';
        session.changed();
        const scheduledMs = [...timeouts.values()].map(t => t.ms).sort((a, b) => a - b);
        expect(scheduledMs).toEqual([DIRTY_DEBOUNCE_MS, DRAFT_INTERVAL_MS]);

        // Fire the 5s draft timeout once -> writes draft and does NOT reschedule itself.
        const draftEntry = [...timeouts.entries()].find(([, v]) => v.ms === DRAFT_INTERVAL_MS);
        timeouts.delete(draftEntry[0]);
        draftEntry[1].fn();
        expect(drafts.write).toHaveBeenCalledTimes(1);
        expect([...timeouts.values()].some(v => v.ms === DRAFT_INTERVAL_MS)).toBe(false);

        // Another edit re-arms the one-shot draft timer; markSaved cancels it cleanly.
        model.name = 'Alice v3';
        session.changed();
        expect([...timeouts.values()].some(v => v.ms === DRAFT_INTERVAL_MS)).toBe(true);
        session.markSaved();
        expect([...timeouts.values()].some(v => v.ms === DRAFT_INTERVAL_MS)).toBe(false);
        session.close();
    });

    test('sillybunny-motion.js separates layout reads from writes in captureListChange and applyListChange', () => {
        const events = [];
        class FakeHTMLElement {
            constructor(id, top) {
                this.id = id;
                this.dataset = { id };
                this.isConnected = true;
                this.inert = false;
                this._top = top;
                this.style = {
                    getPropertyValue: () => '',
                    getPropertyPriority: () => '',
                    setProperty: () => {},
                    removeProperty: () => {},
                };
            }
            getBoundingClientRect() {
                events.push(`read:${this.id}`);
                return { left: 0, top: this._top, width: 200, height: 40 };
            }
            animate() {
                events.push(`write:animate:${this.id}`);
                return { cancel() {}, finished: new Promise(() => {}) };
            }
        }
        global.HTMLElement = FakeHTMLElement;
        global.window = { matchMedia: () => ({ matches: false }) };
        global.document = { body: { classList: { contains: () => false } } };

        const items = [
            new FakeHTMLElement('a', 0),
            new FakeHTMLElement('b', 40),
            new FakeHTMLElement('c', 80),
        ];
        const container = new FakeHTMLElement('list', 0);
        container.querySelectorAll = () => items;

        const snap = captureListChange(container);
        events.length = 0;

        // Reorder items and move positions.
        items[0]._top = 80;
        items[2]._top = 0;
        applyListChange(snap);

        const firstWriteIdx = events.findIndex(e => e.startsWith('write:'));
        const lastReadIdx = events.reduce((acc, e, idx) => (e.startsWith('read:') ? idx : acc), -1);
        expect(firstWriteIdx).toBeGreaterThan(-1);
        expect(lastReadIdx).toBeGreaterThan(-1);
        // Every getBoundingClientRect read MUST finish before the first animation write!
        expect(lastReadIdx).toBeLessThan(firstWriteIdx);
    });

    test('watchExtensionSettings observers disconnect on close and reconnect on reopen', () => {
        const createdObservers = [];
        class FakeHTMLElement {
            constructor() {
                this.isConnected = true;
                this.dataset = {};
                this.id = '';
            }
            querySelectorAll() { return []; }
            addEventListener() {}
        }
        class FakeMO {
            constructor(cb) {
                this.cb = cb;
                this.observing = false;
                this.disconnectCount = 0;
                this.observeCount = 0;
                createdObservers.push(this);
            }
            observe() { this.observing = true; this.observeCount++; }
            disconnect() { this.observing = false; this.disconnectCount++; }
            takeRecords() { return []; }
        }
        global.HTMLElement = FakeHTMLElement;
        global.MutationObserver = FakeMO;

        const scope = new FakeHTMLElement();
        watchExtensionSettings(scope);
        expect(createdObservers).toHaveLength(1);
        expect(createdObservers[0].observing).toBe(true);

        disconnectExtensionSettingsObservers();
        expect(createdObservers[0].observing).toBe(false);
        expect(createdObservers[0].disconnectCount).toBe(1);

        reconnectExtensionSettingsObservers();
        expect(createdObservers[0].observing).toBe(true);
        expect(createdObservers[0].observeCount).toBe(2);

        // Leave clean paused=false state.
        scope.isConnected = false;
        reconnectExtensionSettingsObservers();
    });

    test('picker windowing, folder/tag focus cleanup, settings panel memoization, agent-list visibility gate, QuickReply & CSS hazards', () => {
        const pickerSrc = readPublic('scripts/sillybunny-editor/picker.js');
        expect(pickerSrc).toContain('RETAINED_ROWS_LIMIT');
        expect(pickerSrc).toContain('renderPagedOptions');
        expect(pickerSrc).toContain('reconcileChildren');

        const folderSrc = readPublic('scripts/sillybunny-folder-manager.js');
        expect(folderSrc).toContain('focusHandle.destroy()');
        expect(folderSrc).toContain('createDocumentFragment');

        const tagSrc = readPublic('scripts/sillybunny-tag-manager.js');
        expect(tagSrc).toContain('memberFocusHandle?.destroy()');
        expect(tagSrc).toContain('focusHandle.destroy()');
        expect(tagSrc).toContain('new Set(Object.entries(state.tagMap)');
        expect(tagSrc).toContain('createDocumentFragment');

        const tabsSrc = readPublic('scripts/sillybunny-tabs.js');
        expect(tabsSrc).toContain('sbNormalizedSettingsPanels');
        expect(tabsSrc).toContain('disconnectExtensionSettingsObservers()');
        expect(tabsSrc).toContain('reconnectExtensionSettingsObservers()');

        const agentSrc = readPublic('scripts/extensions/in-chat-agents/ui/agent-list.js');
        expect(agentSrc).toContain('dirtyWhileHidden');
        expect(agentSrc).toContain('!controller.isVisible()');

        const qrJs = readPublic('scripts/extensions/quick-reply/src/QuickReply.js');
        expect(qrJs).toContain('loadQrEditorTemplateHtml');
        expect(qrJs).toContain('sb-qr-modal-editor-popup');
        expect(qrJs).toContain('inputOgMo.disconnect()');
        expect(qrJs).toContain('this.cloneObserver?.disconnect()');
        expect(qrJs).not.toContain('updateSyntaxLoop');

        const qrCss = readPublic('scripts/extensions/quick-reply/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(qrCss).not.toContain(':has(#qr--modalEditor');
        expect(qrCss).toContain('.sb-qr-modal-editor-popup');
        expect(qrCss).toContain('-webkit-backdrop-filter: unset;');
        expect(qrCss).toContain('backdrop-filter: unset;');

        const archiveSrc = readPublic('scripts/extensions/sillybunny-chats-archive/index.js');
        expect(archiveSrc).toContain('isButtonMounted');
        expect(archiveSrc).toContain('observer.observe(buttonContainer, { childList: true })');

        const brandsCss = readPublic('css/brands.min.css');
        expect(brandsCss).toContain('font-display:swap');
        expect(brandsCss).not.toContain('font-display:block');
    });
});

describe('Workstream 5: cold-load pollers, structuredClone polyfill gate, and i18n scheduler.yield() chunking', () => {
    test('zero setInterval pollers remain in BunnyPresetTools, ChatCompletionTabs, and extensions.js menu watcher', () => {
        const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

        const bptSrc = stripComments(readPublic('scripts/extensions/third-party/BunnyPresetTools/content.js'));
        expect(bptSrc).not.toMatch(/setInterval\s*\(\s*bootstrap/);
        expect(bptSrc).toContain('stopBootstrapMountObserver');

        const tabMgrSrc = stripComments(readPublic('scripts/extensions/third-party/ChatCompletionTabs/components/tab-manager.js'));
        expect(tabMgrSrc).not.toMatch(/setInterval\s*\(/);

        const extSrc = stripComments(readPublic('scripts/extensions.js'));
        expect(extSrc).not.toMatch(/setInterval\s*\(\s*showHideExtensionsMenu/);
        expect(extSrc).toContain('extensionsMenuObserver?.disconnect()');
    });

    test('TabManager uses event lifecycle hooks without creating any setInterval and tears down on destroy', () => {
        const onSpy = jest.fn();
        const removeListenerSpy = jest.fn();
        const setIntervalSpy = jest.spyOn(global, 'setInterval');
        global.SillyTavern = {
            getContext: () => ({
                eventSource: { on: onSpy, removeListener: removeListenerSpy },
                eventTypes: {
                    APP_READY: 'app_ready',
                    SETTINGS_LOADED_AFTER: 'settings_loaded_after',
                    MAIN_API_CHANGED: 'main_api_changed',
                    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
                },
            }),
        };
        global.document = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            querySelector: () => null,
            querySelectorAll: () => [],
        };

        const manager = new TabManager({
            containerSelector: '#test',
            tabs: { a: { label: 'A', icon: '', contentSelectors: [] } },
            checkCondition: () => false,
        });

        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(onSpy).toHaveBeenCalledTimes(4);

        manager.destroy();
        expect(removeListenerSpy).toHaveBeenCalledTimes(4);
        expect(global.document.removeEventListener).toHaveBeenCalledTimes(1);
        setIntervalSpy.mockRestore();
        delete global.SillyTavern;
    });

    test('structured-clone monkey-patch skips static import when native structuredClone exists', async () => {
        const src = readPublic('lib/structured-clone/monkey-patch.js');
        expect(src).not.toMatch(/^\s*import\s+structuredClone/m);
        expect(src).toContain('await import(\'./index.js\')');

        // Executing the module when native structuredClone exists leaves native function intact.
        const nativeRef = global.structuredClone;
        await import('../public/lib/structured-clone/monkey-patch.js');
        expect(global.structuredClone).toBe(nativeRef);
    });

    test('i18n.js keeps var TDZ guards, synchronous applyLocale, and cooperatively chunks hidden DOM with scheduler.yield()', async () => {
        const i18nSrc = readPublic('scripts/i18n.js');
        expect(i18nSrc).toMatch(/\bvar\s+langs;/);
        expect(i18nSrc).toMatch(/\bvar\s+localeData;/);
        expect(i18nSrc).toMatch(/\bvar\s+trackMissingDynamicTranslate\s*=\s*null;/);
        expect(i18nSrc).toContain('export function applyLocale(');
        expect(i18nSrc).toContain('globalThis.scheduler?.yield');

        // Exercise real initLocales() -> applyLocaleChunked() with 2 visible + 250 hidden elements.
        const storage = new Map([['language', 'es']]);
        global.localStorage = {
            getItem: k => storage.get(k) ?? null,
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: k => storage.delete(k),
        };
        const makeEl = (key, hidden) => ({
            attrs: new Map([['data-i18n', key]]),
            textContent: key,
            style: { display: hidden ? 'none' : '' },
            getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
            setAttribute(name, val) { this.attrs.set(name, val); },
            closest: () => (hidden ? {} : null),
        });
        const visibleEls = [makeEl('hello', false), makeEl('world', false)];
        const hiddenEls = Array.from({ length: 250 }, (_, i) => makeEl(`item_${i}`, true));
        const allEls = [...visibleEls, ...hiddenEls];

        const localeMap = { hello: 'hola', world: 'mundo' };
        for (let i = 0; i < 250; i++) localeMap[`item_${i}`] = `elemento_${i}`;

        const yieldSpy = jest.fn(async () => {});
        global.scheduler = { yield: yieldSpy };
        global.fetch = jest.fn(async url => ({
            ok: true,
            json: async () => (String(url).includes('lang.json') ? [{ lang: 'es', display: 'Español' }] : localeMap),
        }));
        global.$ = () => ({
            find: () => ({
                filter: () => ({
                    append: () => {},
                    each: () => {},
                    on: () => {},
                    val: () => {},
                }),
            }),
        });
        global.document = {
            documentElement: { lang: '' },
            querySelectorAll: () => allEls,
            createElement: () => ({}),
        };

        const i18nMod = await import(`../public/scripts/i18n.js?chunked_test=${Date.now()}`);
        await i18nMod.initLocales();

        // All visible and hidden elements translated, and scheduler.yield() was called between hidden chunks!
        expect(visibleEls[0].textContent).toBe('hola');
        expect(visibleEls[1].textContent).toBe('mundo');
        expect(hiddenEls[0].textContent).toBe('elemento_0');
        expect(hiddenEls[249].textContent).toBe('elemento_249');
        expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

        // Also test applyLocaleChunked directly with custom chunkSize.
        const customYields = [];
        const directResult = await i18nMod.applyLocaleChunked(
            { querySelectorAll: () => allEls },
            { chunkSize: 100, yieldToMain: async () => { customYields.push(1); } },
        );
        expect(directResult).toEqual({ visibleCount: 2, hiddenCount: 250, yields: 3 });
        expect(customYields).toHaveLength(3);
    });
});
