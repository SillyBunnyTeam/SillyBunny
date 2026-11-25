import { createButtonRow, createSwitchRow, createTextAreaField } from '../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../sillybunny-editor/select-row.js';
import { world_names } from '../../../world-info.js';
import { confirmConversationAction, promptConversationText } from '../../dialogs.js';
import { ensureConversationChatLoaded, getConversationMessages } from '../../conversation-store.js';
import { updateConversationMemorySummary } from '../../prompt.js';
import { clearConversationMemorySummary, getConversationMemorySummary, saveConversationMemorySummary } from '../../settings-store.js';
import { GEECHAN_DEFAULT_PROMPT, conversationData, readSettings, requireView, writeSetting } from '../access.js';
import { identityOf } from '../actions.js';
import { getPageTitle } from '../details-logic.js';
import { createGroup, createPage, el, watchConversation } from '../page-kit.js';

const EXPAND_LABEL = 'Expand the Editor';

function createLorebookSelect(value) {
    const select = el('select');
    const none = el('option', '', 'Character default (no override)');
    none.value = '';
    select.append(none);
    const names = Array.isArray(world_names) ? [...world_names] : [];
    if (value && !names.includes(value)) {
        names.push(value);
    }
    for (const name of names) {
        const option = el('option', '', name);
        option.value = name;
        select.append(option);
    }
    select.value = value;
    return select;
}

/**
 * The memory summary of the open chat: a note that the model writes for continuity, and that the user can write, refresh
 * or clear. It is in the header of the chat file, so these actions need the chat loaded.
 */
function createMemoryRows(conversationId) {
    const where = () => {
        const view = requireView(conversationId);
        const { avatar, groupId } = identityOf(view);
        return { avatar, options: { groupId, personaId: view.personaId }, view };
    };
    const summary = createTextAreaField({
        label: 'Conversation Memory',
        field: 'memory-summary',
        rows: 5,
        expand: false,
        placeholder: 'No memory summary yet. Refresh the memory to write one now, or keep chatting and it updates by itself.',
    });
    summary.row.querySelector('textarea')?.setAttribute('readonly', '');
    const caption = el('small', 'ds-row-subtitle ds-row-textarea__caption');
    summary.row.append(caption);

    const draw = () => {
        const { avatar, options, view } = where();
        const chat = view.chats.find(item => item.id === view.activeChatId);
        summary.setValue(avatar ? getConversationMemorySummary(avatar, options) : '');
        const count = chat?.messageCount ?? 0;
        caption.textContent = `${chat?.name || 'This chat'} has ${count} ${count === 1 ? 'message' : 'messages'}`;
    };

    const withLoadedChat = async (task) => {
        const { avatar, options } = where();
        try {
            await ensureConversationChatLoaded(avatar, options);
            await task(avatar, options);
        } catch (error) {
            console.error('Conversation Mode: the memory could not be changed', error);
            globalThis.toastr?.error?.('The memory could not be changed');
        }
        draw();
    };
    const create = createButtonRow({
        label: 'Create Memory',
        icon: 'plus',
        field: 'create-memory',
        onActivate: () => void withLoadedChat(async (avatar, options) => {
            const text = await promptConversationText({ title: 'Memory Summary', text: 'Enter or override the memory summary for this Conversation', defaultValue: getConversationMemorySummary(avatar, options), rows: 6 });
            if (typeof text === 'string') {
                saveConversationMemorySummary(avatar, text.trim(), getConversationMessages(avatar, options).length, options);
                globalThis.toastr?.success?.('Conversation memory updated');
            }
        }),
    });
    const refresh = createButtonRow({
        label: 'Refresh Memory',
        icon: 'rotate',
        field: 'refresh-memory',
        onActivate: () => void withLoadedChat((avatar, options) => updateConversationMemorySummary(avatar, { force: true, notify: true, ...options })),
    });
    const clear = createButtonRow({
        label: 'Clear Memory',
        icon: 'eraser',
        danger: true,
        field: 'clear-memory',
        onActivate: () => void withLoadedChat(async (avatar, options) => {
            if (await confirmConversationAction({ title: 'Clear the memory summary?', text: 'This does not delete chat messages', confirmLabel: 'Clear' }) && clearConversationMemorySummary(avatar, options)) {
                globalThis.toastr?.success?.('Conversation memory cleared');
            }
        }),
    });
    void withLoadedChat(() => {});
    return { rows: [summary, create, refresh, clear], draw };
}

/** The prompt, the context a reply is built from, and the memory. Every row saves as it changes. */
export function buildAdvanced({ conversationId, nav }) {
    const view = requireView(conversationId);
    const settings = readSettings(view);
    const { page, clamp } = createPage('sb-details-page--settings');
    const save = (key, value) => writeSetting(requireView(conversationId), key, value);

    const prompt = createTextAreaField({
        label: 'System Prompt',
        field: 'system-prompt',
        value: settings.geechan_chatroom_prompt,
        placeholder: 'Type the chatroom system prompt here…',
        rows: 3,
        expandLabel: EXPAND_LABEL,
        onChange: value => save('geechan_chatroom_prompt', value),
    });
    const resetPrompt = createButtonRow({
        label: 'Reset to Default',
        icon: 'rotate-left',
        field: 'reset-prompt',
        onActivate: () => {
            prompt.setValue(GEECHAN_DEFAULT_PROMPT);
            save('geechan_chatroom_prompt', GEECHAN_DEFAULT_PROMPT);
            globalThis.toastr?.success?.('System prompt reset to default Geechan preset');
        },
    });
    const authorsNote = createTextAreaField({
        label: 'Author’s Note',
        field: 'authors-note',
        value: settings.authors_note,
        placeholder: '[Author’s Note: Keep responses short, direct, and conversational as if chatting in a DM.]',
        rows: 2,
        expandLabel: EXPAND_LABEL,
        onChange: value => save('authors_note', value),
    });
    const lorebook = createSelectRow({
        select: createLorebookSelect(settings.lorebook_override),
        label: 'Lorebook Override',
        field: 'lorebook-override',
        onChange: value => save('lorebook_override', value),
    });
    const related = createSwitchRow({
        label: view.kind === 'group' ? 'Remember Direct Conversations Here' : 'Remember Groups Here',
        field: 'include-related-memory',
        checked: settings.include_related_memory,
        onChange: value => save('include_related_memory', value),
    });
    const reactions = createSwitchRow({
        label: 'React to Current Roleplay',
        field: 'roleplay-reactions',
        checked: settings.roleplay_reactions,
        onChange: value => save('roleplay_reactions', value),
    });
    const polisher = createSwitchRow({
        label: 'Prose Polisher',
        field: 'prose-polisher',
        checked: settings.prose_polisher,
        onChange: value => save('prose_polisher', value),
    });
    const memory = createMemoryRows(conversationId);
    memory.draw();

    clamp.append(
        createGroup({ title: 'Prompt', rows: [prompt, resetPrompt, authorsNote], field: 'prompt' }).section,
        createGroup({ title: 'Context', rows: [lorebook, related, reactions], field: 'context' }).section,
        createGroup({ title: 'Replies', rows: [polisher], field: 'replies' }).section,
        createGroup({ title: 'Memory', rows: memory.rows, field: 'memory' }).section,
    );

    const signature = current => JSON.stringify([current.activeChatId, current.chats.map(chat => [chat.id, chat.name, chat.messageCount])]);
    const stopMemory = conversationData.subscribe((event) => {
        if (event.type === 'chat' && event.address?.conversationId === conversationId) {
            memory.draw();
        }
    });
    const stop = watchConversation(conversationId, signature, { onChange: memory.draw, onGone: () => nav.gone() });
    return {
        title: getPageTitle('advanced'),
        content: page,
        dispose() {
            stop();
            stopMemory();
        },
    };
}
