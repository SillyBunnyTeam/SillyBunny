/**
 * The chat family. Chat is not a family of windows: it is the one surface of the product that is always there, so it is
 * registered as entries with states.
 *
 * - The Roleplay transcript, once per chat style that the Appearance settings offer. Each shows the 60-message chat of the
 *   `chat-long` need and has the states of its message rows: the expanded row (above 768px, where the setting has an effect),
 *   the edit row at the middle and at the end of the chat, reasoning, a table and a code block, and the swipe controls of
 *   the last message. The Document style hides the action row on every message but the last, so it has a state for that
 *   row. The Flat style, which is the default, also has the edit row at the start of the chat, the deletion mode, a
 *   narrator message, a long message and an image message.
 * - The control that loads older messages, on the `chat-very-long` need, which is longer than the render window.
 * - The generating state, with the stop control and with the error toast of a failed generation.
 * - The composer, with its two button rails, in each form: empty, with text, in several lines, with an attachment, with a
 *   rail open, disconnected and connected, and with the bottom chat bar hidden. The composer with the Quick Reply bar is its own entry.
 * - The bottom chat bar, which is a row of controls on a desktop window and a chip with an actions sheet on a phone.
 * - The group chat: the speaker controls and the transcript with several speakers, with the speaker bar hidden.
 * - Conversation mode: the timeline with its message toolbar, editor, search and chats, the details window, and the composer.
 *
 * Message timestamps, token counts and generation timers differ between runs, so each entry masks them.
 *
 * The generation is a mocked request that is held open or answered with an error. So the family has the stop control and
 * the error toast, but no streaming reply and no regeneration: both need the text of a model, which the audit server does
 * not have, and a streamed reply changes on every frame.
 */

import { FIXTURES } from './fixture-data.js';
import {
    CHAT_STYLES, attachFile, editMessage, hideBottomBar, hideGroupSpeakerBar, isPaged, markChatDirty, message, openAuditGroupChat, openBottomBarSearch,
    openChatFile, openDeleteMode, openReasoning, resetBottomBar, resetChatUi, resetComposer, scrollToMessage, scrollToOlderMessagesControl, setChatStyle, setConnection,
    setExpandMessageActions, startGeneration, stopGeneration,
} from './chat-steps.js';
import {
    DETAILS_WINDOW, MESSAGE_INDEX, addConversationChats, chatMessage, closeConversationDetails, conversationMessage, conversationMessageId, editConversationMessageById,
    openConversation, openConversationDetailsAt, openConversationPicker, setConversationConnection, showConversationPage,
} from './chat-conversation-steps.js';
import { AUDIT_FOLDERS, openLegacyToggle, PICKER_ROOT, showAuditConversationFolders } from './menu-steps.js';
import { settle } from './steps.js';
import { viewportById, viewportsFor } from '../surface-matrix.js';
import { TOAST_SELECTOR } from '../toasts.js';

const SCRIPTS = 'public/scripts';
const CSS = 'public/css';
const SHELL = '#sheld';
const LONG = FIXTURES['chat-long'];
const VERY_LONG = FIXTURES['chat-very-long'];
const CHAT = FIXTURES.chat;
const GROUP_CHAT = FIXTURES['group-chat'];

/** The first message of a chat, whatever the chat holds. */
const FIRST_MESSAGE = 0;
/** The first message of the group chat from a member other than the audit character, and that member's avatar. */
const MEMBER_TURN = GROUP_CHAT.turns.findIndex(turn => turn.speaker !== null && turn.speaker !== FIXTURES.character.avatar);
const MEMBER_AVATAR = GROUP_CHAT.turns[MEMBER_TURN].speaker;

/**
 * Where a state exists, by what the app's own rules depend on. A state with `where` gets the `viewports` that meet it:
 * `wide` is above 768px, where the shell and the message actions leave their mobile rules (`(min-width: 769px)`); `paged`
 * is the mobile layout, up to 768px; `hover` is a fine pointer, which is what `(hover: hover)` matches in the matrix.
 */
const WHERE = {
    wide: viewport => viewport.width > 768,
    paged: viewport => viewport.width <= 768,
    hover: viewport => viewport.pointer === 'fine',
};

/** @param {any} surface An entry whose states may name `where`. */
function withViewports(surface) {
    if (!surface.states) {
        return surface;
    }
    const applicable = viewportsFor(surface);
    return {
        ...surface,
        states: surface.states.map(({ where, ...state }) => (where
            ? { ...state, viewports: applicable.filter(id => WHERE[where](viewportById(id))) }
            : state)),
    };
}

/** The message of the long chat that the transcript rests on, so that a row with reasoning and its neighbours are in view. */
const REST = LONG.reasoningIndex - 1;
/** A message in the middle of the long chat, so that both of its Move buttons are enabled. */
const MIDDLE = LONG.reasoningIndex + 1;
/** The last message of the long chat: the one that shows swipe controls, and the end of the chat for the edit row. */
const LAST = LONG.lastSwipesIndex;

const TRANSCRIPT_MASKS = ['#chat .timestamp', '#chat .mes_timer', '#chat .tokenCounterDisplay', '#sb-bottom-chat-select'];

const TRANSCRIPT_SOURCES = [
    `${SCRIPTS}/sillybunny-message-actions.js`, `${CSS}/sillybunny-message-actions.css`, `${CSS}/sillybunny-chat-styles.css`, 'public/style.css',
];

/**
 * The controls of an edit row that a window shows: Cancel and Confirm lead; a phone keeps the rest behind the menu button, a
 * desktop window inline, with the Move buttons that the message can use (`edge` names the one that the theme hides at the
 * start or the end of the chat).
 */
const editRow = (id, ctx, edge) => [
    `${message(id)} .edit_textarea`, `${message(id)} .mes_edit_cancel`, `${message(id)} .mes_edit_done`,
    ...(isPaged(ctx)
        ? [`${message(id)} .sb-mes-edit-more`]
        : ['up', 'down'].filter(way => way !== edge).map(way => `${message(id)} .mes_edit_${way}:not(.disabled)`)),
];

/** The states of a transcript entry. The edge edit rows and the message shapes are only on the default style. */
function transcriptStates(style) {
    // The Document style hides the action row of every message but the last, so its row states use that message.
    const documentStyle = style.id === 'document';
    const row = documentStyle ? LAST : MIDDLE;
    const states = [
        ...(documentStyle ? [{
            id: 'action-row-last',
            async open(page) {
                await scrollToMessage(page, LAST, 'end');
            },
            ready: [`${message(LAST)} .mes_buttons .mes_edit`, `${message(LAST)} .mes_buttons .extraMesButtonsHint`],
        }] : []),
        {
            id: 'expanded-row',
            where: 'wide',
            async open(page) {
                await setExpandMessageActions(page, true);
                await scrollToMessage(page, row, 'center');
            },
            // A phone keeps Edit and the menu button whatever the setting says.
            ready: [`${message(row)} .mes_buttons .mes_delete`],
        },
        ...(documentStyle ? [] : [{
            id: 'edit-row-middle',
            async open(page) {
                await editMessage(page, MIDDLE);
            },
            ready: ctx => editRow(MIDDLE, ctx),
        }]),
        {
            id: 'edit-row-last',
            async open(page) {
                await editMessage(page, LAST);
            },
            ready: ctx => editRow(LAST, ctx, 'down'),
        },
        {
            id: 'reasoning-expanded',
            async open(page) {
                await openReasoning(page, LONG.reasoningIndex);
            },
            ready: [`${message(LONG.reasoningIndex)} .mes_reasoning_details[open] .mes_reasoning`],
        },
        {
            id: 'code-table',
            async open(page) {
                await scrollToMessage(page, LONG.codeIndex);
            },
            ready: [`${message(LONG.codeIndex)} .mes_text table`, `${message(LONG.codeIndex)} .mes_text pre`],
        },
    ];
    if (style.id === 'flat') {
        states.push(
            {
                id: 'edit-row-first',
                async open(page) {
                    await editMessage(page, FIRST_MESSAGE);
                },
                ready: ctx => editRow(FIRST_MESSAGE, ctx, 'up'),
            },
            {
                id: 'delete-mode',
                open: openDeleteMode,
                ready: ['#dialogue_del_mes_ok', '#dialogue_del_mes_cancel', `${message(REST)} .sb-selection-check`],
            },
            {
                id: 'narrator-message',
                async open(page) {
                    await scrollToMessage(page, LONG.narratorIndex, 'center');
                },
                ready: [`${message(LONG.narratorIndex)}[is_system="true"] .mes_text`],
            },
            {
                id: 'long-message',
                async open(page) {
                    await scrollToMessage(page, LONG.longIndex);
                },
                ready: [`${message(LONG.longIndex)} .mes_text`],
            },
            {
                id: 'image-message',
                async open(page) {
                    await scrollToMessage(page, LONG.imageIndex);
                },
                ready: [`${message(LONG.imageIndex)} .mes_media_wrapper img`],
            },
        );
    }
    // Only the last message of a character shows its swipe controls.
    states.push({
        id: 'swipes',
        async open(page) {
            await scrollToMessage(page, LAST, 'end');
        },
        ready: [`${message(LAST)} .swipe_left`, `${message(LAST)} .swipe_right`, `${message(LAST)} .swipes-counter`],
    });
    return states;
}

/** One entry of the Roleplay transcript, in one of the chat styles. */
function transcript(style) {
    return {
        id: `chat.roleplay.${style.id}`,
        family: 'chat',
        owner: 'A',
        upstreamMarkup: true,
        title: `Roleplay chat: ${style.label} style`,
        root: SHELL,
        // The action row is not part of this: the Document style hides it on every message but the last.
        ready: [`${message(LONG.reasoningIndex)} .mes_reasoning_summary`, '#send_textarea'],
        async open(page) {
            await openChatFile(page, LONG.file);
            await resetChatUi(page);
            await setChatStyle(page, style);
            await scrollToMessage(page, REST);
        },
        states: transcriptStates(style),
        masks: TRANSCRIPT_MASKS,
        needs: ['character', 'chat', 'chat-long'],
        sources: TRANSCRIPT_SOURCES,
        ...(style === CHAT_STYLES[0] && { primaryFlow: true }),
    };
}

/** Opens the short chat of the audit character with an empty, disconnected composer and no menu open. */
async function openComposer(page) {
    await openChatFile(page, CHAT.file);
    await resetChatUi(page);
    await resetComposer(page);
    await setConnection(page, false);
}

const COMPOSER_TEXT = 'A short message for the composer.';
const COMPOSER_LINES = Array.from({ length: 6 }, (_, number) => `Line ${number + 1} of a longer message.`).join('\n');

/** @param {string} text */
const typeIntoComposer = text => async (page) => {
    await page.locator('#send_textarea').fill(text);
    await settle(page);
};

/** Offline the app only marks Send disabled and keeps showing it, and an empty entry shows its placeholder. */
const CONNECTED_READY = ['#send_but:not(.disabled)'];
const TEXT_READY = ['#send_textarea:not(:placeholder-shown)'];

const COMPOSER_SOURCES = ['public/index.html', 'public/script.js', `${SCRIPTS}/RossAscends-mods.js`, 'public/style.css', `${CSS}/sillybunny-theme.css`];

/** The Conversation composer offline keeps Send disabled, and an empty entry shows its placeholder. */
const CONVERSATION_SENDABLE = '#sb_conversation_send:enabled';
const CONVERSATION_TEXT = '#sb_conversation_input:not(:placeholder-shown)';

/** The toolbar of the message of the thread that has a reaction, while the pointer is over it. */
const HOVERED_TOOLBAR = `${conversationMessage(MESSAGE_INDEX.reacted)}:hover .sb-conversation-message-actions`;

/** The round avatars of the header, the Pals rail and the rail footer are cut from a downscaled picture, and the status dots on them are small circles: their edge pixels differ by a few levels between runs. */
const CONVERSATION_AVATAR_MASKS = ['.sb-conversation-participant-avatar', '.sb-conversation-status-dot', '#sb_conversation_rail_footer .sb-conversation-persona-button'];

const CONVERSATION_MASKS = [
    '.sb-conversation-message-time', '.sb-conversation-day-divider', '.sb-conversation-message-receipt', '.sb-conversation-header-status', '.sb-conversation-list-item-preview', ...CONVERSATION_AVATAR_MASKS,
];

const CONVERSATION_SOURCES = [
    `${SCRIPTS}/sillybunny-conversation/timeline-render.js`, `${SCRIPTS}/sillybunny-conversation/chrome.js`, `${SCRIPTS}/sillybunny-conversation/interface.js`,
    `${SCRIPTS}/sillybunny-message-actions.js`, `${CSS}/sillybunny-conversation.css`,
];

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    ...CHAT_STYLES.map(transcript),
    {
        id: 'chat.roleplay.show-more',
        family: 'chat',
        owner: 'A',
        upstreamMarkup: true,
        title: 'Roleplay chat: control that loads older messages',
        root: SHELL,
        ready: ['#show_more_messages', `${message(VERY_LONG.hidden)} .mes_text`, '#send_textarea'],
        async open(page) {
            await openChatFile(page, VERY_LONG.file);
            await resetChatUi(page);
            await scrollToOlderMessagesControl(page);
        },
        masks: TRANSCRIPT_MASKS,
        needs: ['character', 'chat', 'chat-very-long'],
        sources: ['public/script.js', ...TRANSCRIPT_SOURCES],
    },
    {
        id: 'chat.roleplay.generating',
        family: 'chat',
        owner: 'A',
        upstreamMarkup: true,
        title: 'Roleplay chat: generating (stop control)',
        root: SHELL,
        ready: ['#mes_stop', '#chat > .mes.last_mes', '#send_textarea'],
        async open(page) {
            await openChatFile(page, CHAT.file);
            await resetChatUi(page);
            await resetComposer(page);
            // Sending the first message completes a step of Getting Started, whose success toast comes at a moment that differs between
            // boots, or after the capture. A mask cannot make a capture with the toast equal to one without it, so the toast is not shown.
            await page.addStyleTag({ content: `${TOAST_SELECTOR}.toast-success { display: none !important; }` });
            await startGeneration(page, 'hold');
        },
        states: [{
            id: 'error-toast',
            async open(page) {
                // The surface's own generation left a user message in the chat; start from the saved chat again.
                await stopGeneration(page);
                await markChatDirty(page);
                await openChatFile(page, CHAT.file);
                await resetComposer(page);
                await startGeneration(page, 'error');
            },
            ready: [`${TOAST_SELECTOR}.toast-error`],
        }],
        masks: TRANSCRIPT_MASKS,
        needs: ['character', 'chat'],
        sources: ['public/script.js', ...TRANSCRIPT_SOURCES],
        primaryFlow: true,
    },
    {
        id: 'chat.composer.roleplay',
        family: 'chat',
        owner: 'A',
        upstreamMarkup: true,
        title: 'Composer (entry and the two button rails)',
        root: '#send_form',
        ready: ['#send_textarea', '#options_button'],
        open: openComposer,
        states: [
            { id: 'text-disconnected', open: typeIntoComposer(COMPOSER_TEXT), ready: TEXT_READY },
            { id: 'connected', async open(page) { await setConnection(page, true); }, ready: CONNECTED_READY },
            {
                id: 'connected-text',
                async open(page) {
                    await setConnection(page, true);
                    await typeIntoComposer(COMPOSER_TEXT)(page);
                },
                ready: [...CONNECTED_READY, ...TEXT_READY],
            },
            {
                id: 'multi-line',
                async open(page) {
                    await setConnection(page, true);
                    await typeIntoComposer(COMPOSER_LINES)(page);
                },
                ready: [...CONNECTED_READY, ...TEXT_READY],
            },
            {
                id: 'attachment',
                async open(page) {
                    await setConnection(page, true);
                    await attachFile(page);
                },
                ready: [...CONNECTED_READY, '#file_form .file_name'],
            },
            {
                id: 'left-rail-open',
                async open(page) {
                    await openLegacyToggle(page, '#options_button', '#options');
                },
                ready: ['#options', '#options_button'],
            },
            {
                id: 'right-rail-open',
                async open(page) {
                    await openLegacyToggle(page, '#extensionsMenuButton', '#extensionsMenu');
                },
                ready: ['#extensionsMenu', '#extensionsMenuButton'],
            },
            {
                id: 'bottom-bar-hidden',
                open: hideBottomBar,
                ready: ['#options', '#option_toggle_bottom_bar span:text-is("Show Bottom Bar")'],
            },
        ],
        masks: TRANSCRIPT_MASKS,
        needs: ['character', 'chat'],
        sources: COMPOSER_SOURCES,
        primaryFlow: true,
    },
    {
        id: 'chat.composer.quick-replies',
        family: 'chat',
        owner: 'B',
        title: 'Composer with the Quick Reply bar',
        root: '#send_form',
        ready: ['#send_textarea', '#qr--bar .qr--button'],
        async open(page) {
            await openComposer(page);
            // A phone folds the bar into the tray that the chat bar's toggle opens, and a desktop window shows the bar in place.
            const toggle = page.locator('.sb-bottom-chat-tray-toggle');
            if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') {
                await toggle.click();
                await settle(page);
            }
        },
        states: [{
            id: 'connected',
            async open(page) {
                await setConnection(page, true);
            },
            ready: CONNECTED_READY,
        }],
        masks: TRANSCRIPT_MASKS,
        needs: ['character', 'chat', 'quick-replies'],
        sources: [`${SCRIPTS}/extensions/quick-reply/index.js`, `${SCRIPTS}/sillybunny-mobile-bottom-bar.js`, ...COMPOSER_SOURCES],
    },
    {
        id: 'chat.bottom-bar',
        family: 'chat',
        owner: 'A',
        title: 'Bottom chat bar (chat picker and chat actions)',
        root: '#sb-bottom-chat-bar',
        // A phone folds the picker and the actions into a chip and a sheet; a desktop window shows them in the bar.
        ready: ctx => (isPaged(ctx)
            ? ['#sb-bottom-chat-bar .sb-bottom-chat-chip']
            : ['#sb-bottom-chat-select', '#sb-bottom-chat-bar .sb-bottom-chat-management-actions']),
        async open(page) {
            await openChatFile(page, CHAT.file);
            await resetChatUi(page);
            await resetBottomBar(page);
        },
        states: [{
            id: 'search-open',
            async open(page, ctx) {
                await openBottomBarSearch(page, ctx);
            },
            // The field is shown at rest on a desktop window, so what it holds proves the state.
            ready: ['#sb-bottom-chat-search:not(:placeholder-shown)'],
        }],
        // The search status counts matches as the search goes through the chat, so it is caught at different counts.
        masks: [...TRANSCRIPT_MASKS, '#sb-bottom-chat-bar .sb-bottom-chat-chip-label', '#sb-bottom-chat-bar .sb-bottom-chat-search-status'],
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-mobile-bottom-bar.js`, `${SCRIPTS}/sillybunny-tabs.js`, `${CSS}/sillybunny-tabs.css`],
        primaryFlow: true,
    },
    {
        id: 'chat.group.speaker-controls',
        family: 'chat',
        owner: 'A',
        title: 'Group chat: speaker controls',
        root: '#group_speaker_controls',
        ready: ['#group_speaker_controls .group_speaker_avatar', '#group_speaker_now', '#group_speaker_hide'],
        async open(page) {
            await openAuditGroupChat(page);
            await resetChatUi(page);
            await page.evaluate(() => {
                window.$('#group_speaker_controls .group_speaker_avatar.selected').trigger('click');
                window.$('#group_typing_indicator').addClass('displayNone').text('');
                window.$('#group_speaker_controls').removeClass('is-typing');
            });
            await settle(page);
        },
        states: [
            {
                id: 'speaker-selected',
                async open(page) {
                    await page.locator(`#group_speaker_controls .group_speaker_avatar[data-avatar="${MEMBER_AVATAR}"]`).click();
                    await page.locator('#group_speaker_controls .group_speaker_avatar.selected').waitFor({ state: 'visible' });
                    await settle(page);
                },
                ready: [`#group_speaker_controls .group_speaker_avatar.selected[data-avatar="${MEMBER_AVATAR}"]`],
            },
            {
                // The indicator is built by a generation round of the group, and a send would add a message to the saved group
                // chat, which the page cannot load again; so the markup of `setGroupTypingIndicator` is set here instead.
                id: 'typing',
                async open(page) {
                    await page.evaluate((name) => {
                        window.$('#group_typing_indicator').text(`${name} is typing...`).removeClass('displayNone');
                        window.$('#group_speaker_controls').addClass('is-typing');
                    }, FIXTURES.character.name);
                    await settle(page);
                },
                ready: ['#group_speaker_controls.is-typing #group_typing_indicator:not(.displayNone)'],
            },
        ],
        masks: TRANSCRIPT_MASKS,
        needs: ['group', 'group-chat'],
        sources: [`${SCRIPTS}/group-chats.js`, 'public/index.html', 'public/style.css'],
    },
    {
        id: 'chat.group.transcript',
        family: 'chat',
        owner: 'A',
        upstreamMarkup: true,
        title: 'Group chat: transcript with several speakers',
        root: SHELL,
        ready: [`${message(MEMBER_TURN)} .mes_buttons`, '#group_speaker_controls', '#send_textarea'],
        async open(page) {
            await openAuditGroupChat(page);
            await resetChatUi(page);
            await scrollToMessage(page, FIRST_MESSAGE);
        },
        states: [{
            id: 'speaker-bar-hidden',
            open: hideGroupSpeakerBar,
            ready: ['#extensionsMenu', 'body.groupSpeakerControlsHidden #wand_group_speaker_controls'],
        }],
        masks: TRANSCRIPT_MASKS,
        needs: ['group', 'group-chat'],
        sources: [`${SCRIPTS}/group-chats.js`, ...TRANSCRIPT_SOURCES],
    },
    {
        id: 'chat.conversation.timeline',
        family: 'chat',
        owner: 'A',
        title: 'Conversation mode: timeline (split view, or the chat page of a phone)',
        root: SHELL,
        // The timeline rests on its last message, so the first one may be out of view.
        ready: ctx => [
            '#sb_conversation_header', conversationMessage(MESSAGE_INDEX.last), '#sb_conversation_form',
            ...(isPaged(ctx) ? [] : ['#sb_conversation_list .sb-conversation-list-item']),
        ],
        open: openConversation,
        states: [
            {
                // The toolbar is at opacity 0 until the pointer is over its message (`(hover: hover)`); a phone shows a menu trigger at rest.
                id: 'hover-message-toolbar',
                where: 'hover',
                async open(page) {
                    await page.locator(conversationMessage(MESSAGE_INDEX.reacted)).hover();
                    await settle(page);
                },
                ready: [`${HOVERED_TOOLBAR} .sb-conversation-message-menu`],
            },
            {
                id: 'hover-message-toolbar-expanded',
                where: 'hover',
                async open(page) {
                    await setExpandMessageActions(page, true);
                    await page.locator(conversationMessage(MESSAGE_INDEX.reacted)).hover();
                    await settle(page);
                },
                ready: [`${HOVERED_TOOLBAR} .sb-conversation-message-action[data-sb-conversation-action="delete-message"]`],
            },
            {
                id: 'inline-editor',
                async open(page) {
                    await editConversationMessageById(page, MESSAGE_INDEX.ownLong);
                },
                ready: ['.sb-conversation-message.is-editing .sb-conversation-message-edit-textarea', '.sb-conversation-message.is-editing .sb-conversation-message-edit-save'],
            },
            {
                id: 'search-open',
                async open(page) {
                    await page.locator('[data-sb-conversation-action="toggle-search"]').click();
                    await page.locator('#sb_conversation_tools .sb-conversation-search-entry').waitFor({ state: 'visible' });
                    await settle(page);
                },
                ready: ['#sb_conversation_tools .sb-conversation-search-entry'],
            },
            {
                // A wide window shows the rail beside the chat at rest; only the mobile layout (`(max-width: 768px)`) has it as a page.
                id: 'conversations-page',
                where: 'paged',
                async open(page) {
                    await showConversationPage(page, 'list');
                },
                ready: ['#sb_conversation_list .sb-conversation-list-item', '#sb_conversation_list_search'],
            },
            {
                // The headings of the folders are buttons of the list: one open with its rows, one closed (a badge shows there when its rows are unread).
                id: 'list-with-folders',
                async open(page) {
                    await showConversationPage(page, 'list');
                    await showAuditConversationFolders(page);
                },
                ready: [
                    `#sb_conversation_list_items [data-section="folder:${AUDIT_FOLDERS[0].id}"] .sb-conversation-list-heading-button[aria-expanded="true"]`,
                    `#sb_conversation_list_items [data-section="folder:${AUDIT_FOLDERS[1].id}"] .sb-conversation-list-heading-button[aria-expanded="false"]`,
                ],
            },
            {
                id: 'persona-picker',
                async open(page) {
                    await openConversationPicker(page, { toggle: 'togglePersonaPicker', root: '#sb_conversation_persona_picker:not([hidden])' });
                },
                ready: ['#sb_conversation_persona_picker:not([hidden])'],
            },
            {
                id: 'new-conversation-picker',
                async open(page) {
                    await openConversationPicker(page, { toggle: 'toggleStartDirectConversationPicker', root: PICKER_ROOT });
                },
                ready: [PICKER_ROOT, '.sb-picker__option'],
            },
            {
                id: 'chats',
                async open(page) {
                    await addConversationChats(page);
                },
                ready: [chatMessage(0, 0)],
            },
        ],
        masks: CONVERSATION_MASKS,
        needs: ['character'],
        sources: CONVERSATION_SOURCES,
    },
    {
        id: 'chat.conversation.details',
        family: 'chat',
        owner: 'A',
        overlay: true,
        title: 'Conversation mode: the details window of a direct conversation, and Preferences (a modal window at the Dialog tier; a bottom sheet on a phone)',
        root: DETAILS_WINDOW,
        ready: [`${DETAILS_WINDOW} .sb-details-page--general`, `${DETAILS_WINDOW} .sb-details-hero__name`],
        async open(page) {
            await openConversation(page);
            await openConversationDetailsAt(page, 'general');
        },
        close: closeConversationDetails,
        states: [
            ...['chats', 'media', 'files', 'pinned', 'behaviour', 'advanced'].map(id => ({
                id,
                async open(page) {
                    await openConversationDetailsAt(page, id);
                },
                ready: [`${DETAILS_WINDOW} .sb-details-frame--${id} .sb-details-page`],
            })),
            // Selection mode on the window's own header, with one item chosen, on the pages whose audit thread has items to choose.
            ...['chats', 'media', 'pinned'].map(id => ({
                id: `${id}-selecting`,
                async open(page) {
                    await openConversationDetailsAt(page, id);
                    const frame = page.locator(`${DETAILS_WINDOW} .sb-details-frame--${id}`);
                    await frame.getByRole('button', { name: 'Select', exact: true }).click();
                    await frame.locator('[data-sb-list-key]').first().click();
                    await settle(page, { root: DETAILS_WINDOW });
                },
                ready: [`${DETAILS_WINDOW} .sb-details-frame--${id} .sb-dialog__header.is-selection-mode`, `${DETAILS_WINDOW} .sb-details-frame--${id} .sb-selection-action-bar button:not([disabled])`],
            })),
            {
                id: 'profile',
                async open(page) {
                    await openConversationDetailsAt(page, 'profile');
                },
                ready: [`${DETAILS_WINDOW} .sb-details-frame--profile .sb-details-hero__name`],
            },
            {
                id: 'preferences',
                async open(page) {
                    await openConversationDetailsAt(page, 'preferences');
                },
                ready: [`${DETAILS_WINDOW} .sb-details-page--settings`],
            },
        ],
        // The rows of the Chats page and the reminders print dates and times that depend on the day of the run.
        masks: [`${DETAILS_WINDOW} .ds-entity-row__subtitle`, `${DETAILS_WINDOW} .sb-details-hero__subtitle`, `${DETAILS_WINDOW} .sb-details-avatar`],
        needs: ['character'],
        sources: [
            `${SCRIPTS}/sillybunny-conversation/details/window.js`, `${SCRIPTS}/sillybunny-conversation/details/pages/general.js`, `${SCRIPTS}/sillybunny-conversation/details/pages/chats.js`,
            `${SCRIPTS}/sillybunny-conversation/details/pages/behaviour.js`, `${SCRIPTS}/sillybunny-conversation/details/pages/advanced.js`, `${SCRIPTS}/sillybunny-conversation/details/pages/profile.js`,
            `${SCRIPTS}/sillybunny-conversation/details/pages/preferences.js`, `${CSS}/sillybunny-conversation-details.css`,
            `${SCRIPTS}/sillybunny-conversation/details/pages/shared.js`, `${SCRIPTS}/sillybunny-conversation/details/bulk-selection.js`, `${SCRIPTS}/sillybunny-conversation/details/bulk-actions.js`,
        ],
    },
    {
        id: 'chat.conversation.composer',
        family: 'chat',
        owner: 'A',
        title: 'Conversation mode: composer',
        root: '#sb_conversation_form',
        ready: ['#sb_conversation_input', '#sb_conversation_send'],
        open: openConversation,
        states: [
            { id: 'connected', async open(page) { await setConversationConnection(page, true); }, ready: [CONVERSATION_SENDABLE] },
            {
                id: 'text',
                async open(page) {
                    await setConversationConnection(page, true);
                    await page.locator('#sb_conversation_input').fill(COMPOSER_TEXT);
                    await settle(page);
                },
                ready: [CONVERSATION_SENDABLE, CONVERSATION_TEXT],
            },
            {
                id: 'multi-line',
                async open(page) {
                    await setConversationConnection(page, true);
                    await page.locator('#sb_conversation_input').fill(COMPOSER_LINES);
                    await settle(page);
                },
                ready: [CONVERSATION_SENDABLE, CONVERSATION_TEXT],
            },
            {
                id: 'attachment',
                async open(page) {
                    await setConversationConnection(page, true);
                    await page.locator('#sb_conversation_file_input').setInputFiles({
                        name: 'audit-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes for the audit chat.'),
                    });
                    await page.locator('#sb_conversation_attachment_preview:not([hidden])').waitFor({ state: 'visible' });
                    await settle(page);
                },
                ready: ['#sb_conversation_attachment_preview:not([hidden])', CONVERSATION_SENDABLE],
            },
            {
                id: 'reply',
                async open(page) {
                    await setConversationConnection(page, true);
                    await page.evaluate(async (id) => {
                        const timeline = await import('/scripts/sillybunny-conversation/timeline-render.js');
                        timeline.replyToConversationMessage(id);
                    }, conversationMessageId(MESSAGE_INDEX.reacted));
                    await page.locator('#sb_conversation_reply_preview:not([hidden])').waitFor({ state: 'visible' });
                    await settle(page);
                },
                ready: ['#sb_conversation_reply_preview:not([hidden])', CONVERSATION_SENDABLE],
            },
            {
                // The chooser is a popover or a sheet outside the composer. The shortcut opens it at every width: from the Emoji button, or from the "+" button where the Emoji button is folded away.
                id: 'emoji-chooser',
                root: '.sb-action-popover:has(.sb-emoji-chooser), .sb-action-sheet:has(.sb-emoji-chooser)',
                async open(page) {
                    await page.locator('#sb_conversation_input').focus();
                    await page.keyboard.press('Control+Period');
                    await page.locator('.sb-emoji-chooser .sb-emoji-cell').first().waitFor({ state: 'visible' });
                    await page.waitForFunction(() => document.fonts.check('20px "SB Emoji"', '😀'));
                    await settle(page);
                },
                ready: ['.sb-emoji-chooser .sb-emoji-search-entry', '.sb-emoji-chooser .sb-emoji-categories'],
            },
        ],
        masks: CONVERSATION_MASKS,
        needs: ['character'],
        sources: [
            `${SCRIPTS}/sillybunny-conversation/timeline-render.js`, `${SCRIPTS}/sillybunny-conversation/chrome.js`, `${SCRIPTS}/sillybunny-conversation/attachments.js`, `${CSS}/sillybunny-conversation.css`,
            `${SCRIPTS}/sillybunny-conversation/emoji/emoji-chooser.js`, `${SCRIPTS}/sillybunny-conversation/emoji/emoji-chooser-view.js`, `${CSS}/sillybunny-emoji-chooser.css`,
        ],
    },
].map(withViewports);
