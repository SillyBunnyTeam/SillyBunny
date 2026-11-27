import { lodash } from '../lib.js';
import { addOneMessage, chat, displayVersion, eventSource, event_types, setSendButtonState, system_avatar, systemUserName } from '../script.js';
import { t } from './i18n.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { getSlashCommandsHelp } from './slash-commands.js';
import { SlashCommandBrowser } from './slash-commands/SlashCommandBrowser.js';
import { MacroBrowser, getMacrosHelp } from './macros/engine/MacroBrowser.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';

/** @type {Record<string, ChatMessage>} */
export const system_messages = {};
/** @type {ChatMessage[]} */
export const SAFETY_CHAT = [];

// SillyBunny: defer template fetches out of pre-settings startup; hydrate in parallel on idle or lazily on demand.
const SYSTEM_MESSAGE_TEMPLATE_SPECS = Object.freeze({
    help: { templateId: 'help', getData: () => ({}) },
    formatting: { templateId: 'formatting', getData: () => ({}) },
    welcome: { templateId: 'welcome', getData: () => ({ displayVersion }) },
    welcome_prompt: { templateId: 'welcomePrompt', getData: () => ({}) },
    assistant_note: { templateId: 'assistantNote', getData: () => ({}) },
});
const hydratedSystemMessageTypes = new Set();
let systemMessageHydrationPromise = null;

function hydrateSystemMessageSync(type) {
    if (hydratedSystemMessageTypes.has(type)) {
        return;
    }
    const spec = SYSTEM_MESSAGE_TEMPLATE_SPECS[type];
    if (!spec || !system_messages[type]) {
        return;
    }
    system_messages[type].mes = renderTemplate(spec.templateId, spec.getData()) ?? '';
    hydratedSystemMessageTypes.add(type);
}

export function ensureSystemMessagesHydrated() {
    if (systemMessageHydrationPromise) {
        return systemMessageHydrationPromise;
    }

    systemMessageHydrationPromise = Promise.all(
        Object.entries(SYSTEM_MESSAGE_TEMPLATE_SPECS).map(async ([type, spec]) => {
            if (hydratedSystemMessageTypes.has(type) || !system_messages[type]) {
                return;
            }
            const rendered = await renderTemplateAsync(spec.templateId, spec.getData());
            if (!hydratedSystemMessageTypes.has(type) && system_messages[type]) {
                system_messages[type].mes = rendered ?? '';
                hydratedSystemMessageTypes.add(type);
            }
        }),
    ).then(() => undefined).catch((error) => {
        systemMessageHydrationPromise = null;
        console.warn('Failed to prewarm system message templates.', error);
    });

    return systemMessageHydrationPromise;
}

/**
 * @enum {string} System message types
 */
export const system_message_types = {
    HELP: 'help',
    WELCOME: 'welcome',
    EMPTY: 'empty',
    GENERIC: 'generic',
    NARRATOR: 'narrator',
    COMMENT: 'comment',
    SLASH_COMMANDS: 'slash_commands',
    FORMATTING: 'formatting',
    // SillyBunny: the HOTKEYS type and its template are removed, because the Keyboard Shortcuts window is the one shortcut overview.
    MACROS: 'macros',
    WELCOME_PROMPT: 'welcome_prompt',
    ASSISTANT_NOTE: 'assistant_note',
    ASSISTANT_MESSAGE: 'assistant_message',
};

export async function initSystemMessages() {
    hydratedSystemMessageTypes.clear();
    systemMessageHydrationPromise = null;
    /** @type {ChatMessage} */
    const defaultMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_user: false,
        is_system: true,
        extra: { swipeable: false },
    };
    /** @type {Record<string, ChatMessage>} */
    const result = {
        /** @type {ChatMessage} */
        help: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        slash_commands: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        formatting: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        macros: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
        }),
        /** @type {ChatMessage} */
        welcome: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
            extra: {
                uses_system_ui: true,
            },
        }),
        /** @type {ChatMessage} */
        empty: lodash.merge(structuredClone(defaultMessage), {
            mes: 'No one hears you. <b>Hint&#58;</b> add more members to the group!',
        }),
        /** @type {ChatMessage} */
        generic: lodash.merge(structuredClone(defaultMessage), {
            mes: 'Generic system message. User `text` parameter to override the contents',
        }),
        /** @type {ChatMessage} */
        welcome_prompt: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
        /** @type {ChatMessage} */
        assistant_note: lodash.merge(structuredClone(defaultMessage), {
            mes: '',
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
    };

    Object.assign(system_messages, result);

    /** @type {ChatMessage} */
    const safetyMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_system: true,
        is_user: false,
        send_date: getMessageTimeStamp(),
        mes: t`You deleted a character/chat and arrived back here for safety reasons! Pick another character!`,
    };
    SAFETY_CHAT.splice(0, SAFETY_CHAT.length, safetyMessage);

    // SillyBunny: prewarm templates in parallel during post-APP_READY idle instead of blocking startup with 5 serial XHRs.
    if (eventSource && event_types?.APP_READY) {
        eventSource.once(event_types.APP_READY, () => {
            if (typeof globalThis.requestIdleCallback === 'function') {
                globalThis.requestIdleCallback(() => { void ensureSystemMessagesHydrated(); }, { timeout: 3000 });
            } else {
                globalThis.setTimeout(() => { void ensureSystemMessagesHydrated(); }, 500);
            }
        });
    }
}


/**
 * Gets a system message by type.
 * By default system messages are not swipeable.
 * This can be overridden by setting extra.swipeable to true.
 * @param {string} type Type of system message
 * @param {string} [text] Text to be sent
 * @param {ChatMessageExtra} [extra] Additional data to be added to the message
 * @returns {ChatMessage} System message object
 */
export function getSystemMessageByType(type, text, extra = {}) {
    if (!text) {
        hydrateSystemMessageSync(type);
    }
    const systemMessage = system_messages[type];

    if (!systemMessage) {
        return;
    }

    const newMessage = { ...systemMessage, send_date: getMessageTimeStamp() };

    if (text) {
        newMessage.mes = text;
    }

    if (type === system_message_types.SLASH_COMMANDS) {
        newMessage.mes = getSlashCommandsHelp();
    }

    if (type === system_message_types.MACROS) {
        newMessage.mes = getMacrosHelp();
    }

    if (!newMessage.extra || typeof newMessage.extra !== 'object') {
        newMessage.extra = {};
    }

    newMessage.extra = Object.assign(newMessage.extra, extra);
    newMessage.extra.type = type;
    return newMessage;
}

/**
 * Sends a system message to the chat.
 * @param {string} type Type of system message
 * @param {string} [text] Text to be sent
 * @param {ChatMessageExtra} [extra] Additional data to be added to the message
 */
export function sendSystemMessage(type, text, extra = {}) {
    const newMessage = getSystemMessageByType(type, text, extra);
    chat.push(newMessage);
    addOneMessage(newMessage);
    setSendButtonState(false);
    if (type === system_message_types.SLASH_COMMANDS) {
        const browser = new SlashCommandBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-slashHelp');
        const parent = spinner.parentElement;
        spinner.remove();
        browser.renderInto(parent);
        browser.search.focus({ preventScroll: true });
    }

    if (type === system_message_types.MACROS) {
        const browser = new MacroBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-macroHelp');
        if (spinner) {
            const parent = spinner.parentElement;
            spinner.remove();
            browser.renderInto(parent);
            browser.searchInput?.focus({ preventScroll: true });
        }
    }
}
