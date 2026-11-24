import { fetchWithCsrfRetry } from '../csrf-token-refresh.js';
import { t } from '../i18n.js';
import { openMassDeleteChatDialog } from '../sillybunny-chat-dialogs.js';
import { openAlert } from '../sillybunny-editor/dialog.js';
import { registerSidePanel } from '../sillybunny-editor/side-panel.js';
import { isReservedChatName } from '../sillybunny-temporary-chat-state.js';
import { escapeRegex } from '../util/escape-regex.js';
import { refreshCsrfToken } from '../../script.js';

function countRegexMatches(value, regex) {
    const text = String(value ?? '');
    if (!text || !(regex instanceof RegExp)) {
        return 0;
    }

    regex.lastIndex = 0;
    return Array.from(text.matchAll(regex)).length;
}

function addChatSearchTextSegment(segments, value) {
    const normalizedValue = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalizedValue && !segments.includes(normalizedValue)) {
        segments.push(normalizedValue);
    }
}

function getChatSearchMessageText(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const segments = [];

    addChatSearchTextSegment(segments, message.extra?.display_text);
    addChatSearchTextSegment(segments, message.mes);
    addChatSearchTextSegment(segments, message.extra?.reasoning_display_text);
    addChatSearchTextSegment(segments, message.extra?.reasoning);

    return segments.join('\n');
}

function getChatSearchStatusText(totalMatches, renderedMatches) {
    if (!totalMatches) {
        return 'No matches';
    }

    if (renderedMatches > 0 && renderedMatches < totalMatches) {
        return `${renderedMatches}/${totalMatches} visible`;
    }

    if (!renderedMatches) {
        return `${totalMatches} hidden match${totalMatches === 1 ? '' : 'es'}`;
    }

    return `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`;
}

function getMassDeleteOlderThanDays(files, days, currentChatId) {
    const numericDays = Number(days);
    if (!Number.isFinite(numericDays) || numericDays <= 0) {
        return [];
    }

    const cutoff = Date.now() - (numericDays * 24 * 60 * 60 * 1000);
    return files.filter(chatFile => chatFile.fileName !== currentChatId && chatFile.sortTimestamp > 0 && chatFile.sortTimestamp < cutoff);
}

function sortChatFiles(files) {
    return [...files].sort((left, right) => {
        if (right.sortTimestamp !== left.sortTimestamp) {
            return right.sortTimestamp - left.sortTimestamp;
        }

        return left.fileName.localeCompare(right.fileName);
    });
}

async function waitForNextAnimationFrame() {
    await new Promise(resolve => window.requestAnimationFrame(resolve));
}

function releaseChatSearchApply(chatbarState, applyToken) {
    window.setTimeout(() => {
        if (applyToken === chatbarState.searchApplyToken) {
            chatbarState.isApplyingSearch = false;
        }
    }, 0);
}

export function createChatActionsSearchController({
    createElement,
    formatChatTokenEstimate,
    normalizeChatFileName,
    formatChatPreview,
    getChatSortTimestamp,
    formatChatTimestamp,
    getAuthorizedRequestHeadersOrNull,
    getRequestHeadersFromContext,
    getChatUiContext,
    getBottomChatBarState,
    getChatbarState,
    getChatSidebarRefs,
    getChatScriptModule,
    getSillyTavernContext,
    getChatScrollElement,
    getReducedMotionScrollBehavior,
    setButtonDisabled,
    setSearchStatusText,
    scheduleChatbarRefresh,
    scheduleBottomChatBarRefresh,
    scrollElementIntoManagedView,
    SB_CHAT_SEARCH_MARK_SELECTOR,
    SB_CHATBAR_SEARCH_DEBOUNCE,
}) {
    function describeChatName(chatName) {
        return isReservedChatName(chatName) ? t`Temporary Chat` : chatName;
    }

    function formatChatSelectorLabel(fileName, tokenEstimate = 0) {
        const tokenLabel = formatChatTokenEstimate(tokenEstimate);
        const displayName = describeChatName(fileName);
        return tokenLabel ? `${displayName} (${tokenLabel})` : displayName;
    }

    function normalizeChatInfo(chatInfo) {
        const rawFileName = chatInfo?.file_name ?? chatInfo?.id ?? chatInfo?.chat_id ?? chatInfo ?? '';
        const fileName = normalizeChatFileName(rawFileName);

        return {
            fileName,
            preview: formatChatPreview(chatInfo?.mes ?? chatInfo?.preview ?? chatInfo?.message ?? ''),
            lastMessage: chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? '',
            sortTimestamp: getChatSortTimestamp(chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? ''),
            chatItems: Number(chatInfo?.chat_items ?? chatInfo?.message_count ?? 0) || 0,
            tokenEstimate: Number(chatInfo?.token_estimate ?? chatInfo?.tokenEstimate ?? 0) || 0,
            fileSize: String(chatInfo?.file_size ?? '').trim(),
        };
    }

    async function fetchCharacterChatFiles(chatContext) {
        const avatarUrl = chatContext.character?.avatar;

        if (!avatarUrl) {
            return [];
        }

        try {
            const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
            if (!headers) {
                return [];
            }

            const response = await fetch('/api/characters/chats', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar_url: avatarUrl }),
            });

            if (!response.ok) {
                return [];
            }

            const data = await response.json();
            if (typeof data === 'object' && data?.error === true) {
                return [];
            }

            const chats = Array.isArray(data) ? data : Object.values(data ?? {});
            return sortChatFiles(chats.map(normalizeChatInfo).filter(chat => chat.fileName));
        } catch (error) {
            console.error('Failed to fetch character chats', error);
            return [];
        }
    }

    async function fetchGroupChatFiles(chatContext) {
        const groupChats = Array.isArray(chatContext.group?.chats) ? chatContext.group.chats : [];

        if (!groupChats.length) {
            return [];
        }

        try {
            const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
            if (!headers) {
                return [];
            }

            const chats = await Promise.all(groupChats.map(async chatId => {
                try {
                    const response = await fetchWithCsrfRetry('/api/chats/group/info', () => ({
                        method: 'POST',
                        headers: getRequestHeadersFromContext(chatContext.context),
                        body: JSON.stringify({ id: chatId }),
                    }), { refreshCsrfToken });

                    if (!response.ok) {
                        if (response.status === 404) {
                            return null;
                        }

                        return normalizeChatInfo({ file_name: chatId });
                    }

                    const chatInfo = normalizeChatInfo(await response.json());
                    return chatInfo.fileName ? chatInfo : normalizeChatInfo({ file_name: chatId });
                } catch {
                    return normalizeChatInfo({ file_name: chatId });
                }
            }));

            return sortChatFiles(chats.filter(chat => chat?.fileName));
        } catch (error) {
            console.error('Failed to fetch group chats', error);
            return [];
        }
    }

    async function getChatFilesForContext(chatContext = getChatUiContext()) {
        if (!chatContext.canBrowseChats) {
            return [];
        }

        return chatContext.group
            ? fetchGroupChatFiles(chatContext)
            : fetchCharacterChatFiles(chatContext);
    }

    async function openChatById(chatId) {
        const nextChatId = normalizeChatFileName(chatId);
        const chatContext = getChatUiContext();

        if (!nextChatId || !chatContext.context) {
            return;
        }

        if (nextChatId === chatContext.chatId) {
            return;
        }

        try {
            if (chatContext.group?.id) {
                await chatContext.context.openGroupChat?.(chatContext.group.id, nextChatId);
            } else {
                await chatContext.context.openCharacterChat?.(nextChatId);
            }
        } finally {
            scheduleChatbarRefresh(80);
        }
    }

    async function handleRenameChat() {
        const chatContext = getChatUiContext();
        const currentChatId = chatContext.chatId;

        if (!currentChatId || typeof chatContext.context?.renameChat !== 'function') {
            return;
        }

        const newChatName = await chatContext.context.Popup?.show?.input?.('Rename Chat', 'Enter a new chat name:', currentChatId);

        if (!newChatName || String(newChatName).trim() === currentChatId) {
            return;
        }

        try {
            await chatContext.context.renameChat(currentChatId, String(newChatName).trim());
        } catch {
            return;
        }
        scheduleChatbarRefresh(120);
    }

    async function handleDeleteChat() {
        const chatContext = getChatUiContext();

        if (!chatContext.chatId) {
            return;
        }

        const confirmed = await openAlert({
            heading: t`Delete Chat?`,
            body: t`This action cannot be undone`,
            responses: [
                { id: 'cancel', label: t`Cancel` },
                { id: 'delete', label: t`Delete`, appearance: 'destructive' },
            ],
        });
        if (confirmed !== 'delete') {
            return;
        }

        await chatContext.context?.executeSlashCommandsWithOptions?.('/delchat');
        scheduleChatbarRefresh(150);
    }

    function setBottomChatActionBusy(button, busy) {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        button.classList.toggle('is-busy', Boolean(busy));
        setButtonDisabled(button, Boolean(busy));
    }

    async function handleAutoNameChat() {
        const chatContext = getChatUiContext();
        const button = getBottomChatBarState().autoNameButton;

        if (!chatContext.hasChat) {
            return;
        }

        setBottomChatActionBusy(button, true);
        try {
            const { autoLabelCurrentChat } = await getChatScriptModule();
            if (typeof autoLabelCurrentChat !== 'function') {
                throw new Error('Chat auto-name helper is unavailable.');
            }

            await autoLabelCurrentChat();
            scheduleBottomChatBarRefresh(160);
        } catch (error) {
            console.error('[SillyBunny] Failed to auto-name current chat.', error);
            globalThis.toastr?.error?.(String(error?.message || error), 'Auto-name chat');
        } finally {
            setBottomChatActionBusy(button, false);
        }
    }

    function showBottomChatMassDeleteDialog(files, currentChatId) {
        return openMassDeleteChatDialog(files, currentChatId, {
            getOlderCount: days => getMassDeleteOlderThanDays(files, days, currentChatId).length,
            formatChatTimestamp,
        });
    }

    async function deleteChatFileForContext(chatContext, fileName, chatModule) {
        if (chatContext.group?.id) {
            const { deleteGroupChatByName } = await import('../group-chats.js');
            return deleteGroupChatByName(chatContext.group.id, fileName);
        }

        if (chatContext.context?.characterId !== undefined && chatContext.context?.characterId !== null) {
            await chatModule.deleteCharacterChatByName(chatContext.context.characterId, fileName);
            return true;
        }

        return false;
    }

    async function handleMassDeleteChats() {
        const chatContext = getChatUiContext();
        const button = getBottomChatBarState().massDeleteButton;

        if (!chatContext.canBrowseChats) {
            return;
        }

        setBottomChatActionBusy(button, true);
        try {
            const files = await getChatFilesForContext(chatContext);
            const deletableFiles = files.filter(chatFile => chatFile.fileName !== chatContext.chatId);
            if (!deletableFiles.length) {
                globalThis.toastr?.info?.('No saved chats can be deleted for this character or group', 'Mass delete chats');
                return;
            }

            const result = await showBottomChatMassDeleteDialog(files, chatContext.chatId);
            if (!result) {
                return;
            }

            const names = result.mode === 'older'
                ? getMassDeleteOlderThanDays(files, result.days, chatContext.chatId).map(chatFile => chatFile.fileName)
                : result.names;

            if (!names.length) {
                return;
            }

            const confirmed = await openAlert({
                heading: t`Delete Chats?`,
                body: t`Delete ${names.length} chat(s)? This cannot be undone.`,
                responses: [
                    { id: 'cancel', label: t`Cancel` },
                    { id: 'delete', label: t`Delete`, appearance: 'destructive' },
                ],
            });
            if (confirmed !== 'delete') {
                return;
            }

            const chatModule = await getChatScriptModule();
            for (const fileName of names) {
                await deleteChatFileForContext(chatContext, fileName, chatModule);
            }

            globalThis.toastr?.success?.(`Deleted ${names.length} chat(s)`, 'Mass delete chats');
            scheduleBottomChatBarRefresh(160);
            scheduleChatbarRefresh(160);
            await chatModule.displayPastChats?.();
        } catch (error) {
            console.error('[SillyBunny] Failed to mass delete chats.', error);
            globalThis.toastr?.error?.(String(error?.message || error), 'Mass delete chats');
        } finally {
            setBottomChatActionBusy(button, false);
        }
    }

    function createChatFileButton(chatFile, currentChatId, onSelect) {
        const button = createElement('button', {
            className: 'sb-chat-file',
            attrs: {
                type: 'button',
            },
        });

        const dateLabel = formatChatTimestamp(chatFile.lastMessage);
        button.classList.toggle('is-current', chatFile.fileName === currentChatId);
        button.innerHTML = `
        <div class="sb-chat-file-head">
            <strong>${describeChatName(chatFile.fileName)}</strong>
            <small>${dateLabel || ''}</small>
        </div>
        <span class="sb-chat-file-preview">${chatFile.preview}</span>
        <div class="sb-chat-file-meta">
            <small>${chatFile.chatItems ? `${chatFile.chatItems} msg` : ''}</small>
            <small>${chatFile.fileSize || ''}</small>
        </div>
    `;

        button.addEventListener('click', () => {
            void onSelect(chatFile.fileName);
        });

        return button;
    }

    function renderChatFiles(listRoot, files, currentChatId, { emptyTitle = 'No chats yet.', emptyBody = 'Start a chat to see it here.', onSelect } = {}) {
        if (!(listRoot instanceof HTMLElement)) {
            return;
        }

        listRoot.replaceChildren();

        if (!files.length) {
            const empty = createElement('div', { className: 'sb-chat-files-empty' });
            empty.append(createElement('strong', { text: emptyTitle }), createElement('p', { text: emptyBody }));
            listRoot.appendChild(empty);
            return;
        }

        for (const chatFile of files) {
            listRoot.appendChild(createChatFileButton(chatFile, currentChatId, onSelect));
        }
    }

    function buildChatSidebar() {
        const existingSidebar = getChatSidebarRefs();
        if (existingSidebar) {
            return existingSidebar;
        }

        const template = document.getElementById('generic_draggable_template');
        const movingDivs = document.getElementById('movingDivs');

        if (!(template instanceof HTMLTemplateElement) || !(movingDivs instanceof HTMLElement)) {
            return null;
        }

        const fragment = template.content.cloneNode(true);
        const root = fragment.querySelector('.draggable');
        const title = fragment.querySelector('.dragTitle');
        const closeButton = fragment.querySelector('.dragClose');

        if (!(root instanceof HTMLElement) || !(title instanceof HTMLElement) || !(closeButton instanceof HTMLElement)) {
            return null;
        }

        root.id = 'sb-chat-sidebar';
        root.classList.remove('draggable');
        root.classList.add('sb-chat-sidebar');
        root.style.top = 'calc(var(--sb-topbar-layout-offset) + 18px)';
        root.style.right = '16px';
        root.style.left = 'auto';
        root.style.bottom = 'auto';

        title.textContent = t`Recent Chats`;

        const body = createElement('div', { className: 'sb-chat-sidebar-body' });
        const list = createElement('div', { className: 'sb-chat-sidebar-list' });
        body.appendChild(list);
        root.appendChild(body);

        closeButton.addEventListener('click', () => setChatSidebarOpenState(false));

        movingDivs.appendChild(root);

        const controller = registerSidePanel({
            id: 'sb-chat-sidebar',
            element: root,
            title: t`Recent Chats`,
            defaultSide: 'left',
            onClose: () => { getChatbarState().sidebarOpen = false; },
        });
        getChatbarState().sidebar = { root, title, list, controller };
        return getChatbarState().sidebar;
    }

    function isChatSidebarOpen() {
        return Boolean(getChatbarState().sidebarOpen);
    }

    function setChatSidebarOpenState(shouldOpen, { opener = document.activeElement, restoreFocus = false } = {}) {
        const refs = buildChatSidebar();

        if (!refs?.root) {
            return;
        }

        const isOpen = Boolean(shouldOpen);
        getChatbarState().sidebarOpen = isOpen;
        refs.root.classList.toggle('sb-chat-sidebar-visible', isOpen);

        if (isOpen) {
            void refs.controller.open({ opener });
            scheduleChatbarRefresh(0);
        } else {
            refs.controller.close({ restoreFocus });
        }
    }

    function toggleChatSidebar() {
        const chatContext = getChatUiContext();
        if (!chatContext.canBrowseChats) {
            return;
        }

        setChatSidebarOpenState(!isChatSidebarOpen(), { restoreFocus: true });
    }

    function getSearchTerms(query = getChatbarState().searchQuery) {
        return String(query ?? '')
            .trim()
            .split(/\s+/)
            .map(term => term.trim())
            .filter(Boolean);
    }

    function createChatSearchRegex(terms = getSearchTerms()) {
        if (!terms.length) {
            return null;
        }

        return new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi');
    }

    function getChatSearchMatches(regex) {
        const context = getSillyTavernContext();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const matches = [];
        let totalMatches = 0;

        if (!(regex instanceof RegExp)) {
            return { matches, totalMatches };
        }

        chat.forEach((message, messageId) => {
            const count = countRegexMatches(getChatSearchMessageText(message), regex);
            if (!count) {
                return;
            }

            matches.push({ messageId, count, message });
            totalMatches += count;
        });

        return { matches, totalMatches };
    }

    function getChatMessageElement(messageId) {
        const chatRoot = getChatScrollElement();
        if (!(chatRoot instanceof HTMLElement) || !Number.isInteger(messageId)) {
            return null;
        }

        return chatRoot.querySelector(`.mes[mesid="${messageId}"]`);
    }

    async function ensureChatMessageRendered(messageId) {
        if (!Number.isInteger(messageId) || messageId < 0) {
            return null;
        }

        let messageElement = getChatMessageElement(messageId);
        if (messageElement instanceof HTMLElement) {
            return messageElement;
        }

        const context = getSillyTavernContext();
        const chatLength = Array.isArray(context?.chat) ? context.chat.length : 0;
        const renderedMessages = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
        const firstRenderedId = Number(renderedMessages.at(0)?.getAttribute('mesid') ?? NaN);
        const lastRenderedId = Number(renderedMessages.at(-1)?.getAttribute('mesid') ?? NaN);
        const chatModule = await getChatScriptModule().catch(() => null);
        const showMoreMessages = typeof context?.showMoreMessages === 'function'
            ? context.showMoreMessages
            : chatModule?.showMoreMessages;
        const showNewerMessages = typeof context?.showNewerMessages === 'function'
            ? context.showNewerMessages
            : chatModule?.showNewerMessages;
        const redisplayChat = typeof context?.redisplayChat === 'function'
            ? context.redisplayChat
            : chatModule?.redisplayChat;

        if (typeof showMoreMessages === 'function' && Number.isInteger(firstRenderedId) && messageId < firstRenderedId) {
            await showMoreMessages(firstRenderedId - messageId);
            await waitForNextAnimationFrame();
            messageElement = getChatMessageElement(messageId);
            if (messageElement instanceof HTMLElement) {
                return messageElement;
            }
        }

        if (typeof showNewerMessages === 'function' && Number.isInteger(lastRenderedId) && messageId > lastRenderedId) {
            await showNewerMessages(messageId - lastRenderedId);
            await waitForNextAnimationFrame();
            messageElement = getChatMessageElement(messageId);
            if (messageElement instanceof HTMLElement) {
                return messageElement;
            }
        }

        if (typeof redisplayChat === 'function' && chatLength > 0) {
            const fallbackStartIndex = Math.max(0, Math.min(messageId, chatLength - 1));
            if (!getChatMessageElement(fallbackStartIndex)) {
                getChatScrollElement()?.querySelectorAll('.mes, #show_more_messages, #show_newer_messages').forEach(element => element.remove());
            }

            await redisplayChat({ startIndex: fallbackStartIndex, fade: false });
            await waitForNextAnimationFrame();
            return getChatMessageElement(messageId);
        }

        return null;
    }

    function clearChatSearchHighlights() {
        for (const mark of document.querySelectorAll(SB_CHAT_SEARCH_MARK_SELECTOR)) {
            if (!(mark instanceof HTMLElement) || !mark.parentNode) {
                continue;
            }

            mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
        }

        document.querySelectorAll('#chat .sb-search-hit').forEach(element => {
            element.classList.remove('sb-search-hit');
        });
        document.getElementById('chat')?.normalize();
        setSearchStatusText('');
    }

    function highlightMessageText(root, regex) {
        if (!(root instanceof HTMLElement)) {
            return { count: 0, firstMatch: null };
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue?.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                const parent = node.parentElement;
                if (!parent
                    || parent.closest(SB_CHAT_SEARCH_MARK_SELECTOR)
                    || parent.closest('.mes_buttons, .extraMesButtons, .mes_edit_buttons, .mes_reasoning_actions, .mes_bias, .mes_avatar, .avatar, .timestamp, .tokenCounterDisplay, .mesIDDisplay, .swipes-counter')) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        let count = 0;
        let firstMatch = null;

        for (const textNode of textNodes) {
            const textValue = textNode.nodeValue ?? '';
            regex.lastIndex = 0;

            if (!regex.test(textValue)) {
                continue;
            }

            regex.lastIndex = 0;
            const fragment = document.createDocumentFragment();
            let previousIndex = 0;

            for (const match of textValue.matchAll(regex)) {
                const matchValue = match[0];
                const matchIndex = match.index ?? 0;

                if (!matchValue) {
                    continue;
                }

                fragment.append(textValue.slice(previousIndex, matchIndex));

                const mark = createElement('mark', {
                    className: 'sb-chat-search-hit',
                    text: matchValue,
                    attrs: {
                        'data-sb-chat-search': 'true',
                    },
                });

                if (!firstMatch) {
                    firstMatch = mark;
                }

                fragment.appendChild(mark);
                previousIndex = matchIndex + matchValue.length;
                count += 1;
            }

            fragment.append(textValue.slice(previousIndex));
            textNode.parentNode?.replaceChild(fragment, textNode);
        }

        return { count, firstMatch };
    }

    async function applyChatSearchHighlights({ scrollToFirst = false } = {}) {
        const chatbarState = getChatbarState();
        const terms = getSearchTerms();
        const applyToken = ++chatbarState.searchApplyToken;

        chatbarState.pendingSearchScroll = false;
        clearTimeout(chatbarState.searchTimer);
        chatbarState.isApplyingSearch = true;
        clearChatSearchHighlights();

        if (!terms.length || !getChatUiContext().hasChat) {
            chatbarState.isApplyingSearch = false;
            return;
        }

        const regex = createChatSearchRegex(terms);
        if (!(regex instanceof RegExp)) {
            chatbarState.isApplyingSearch = false;
            return;
        }

        const searchMatches = getChatSearchMatches(regex);
        const firstMatchId = searchMatches.matches[0]?.messageId;

        if (scrollToFirst && Number.isInteger(firstMatchId)) {
            setSearchStatusText('Loading match…');

            try {
                await ensureChatMessageRendered(firstMatchId);
            } catch (error) {
                console.warn('[SillyBunny] Failed to reveal chat search match.', error);
            }

            if (applyToken !== chatbarState.searchApplyToken) {
                chatbarState.isApplyingSearch = false;
                return;
            }
        }

        let renderedMatches = 0;
        let firstMatch = null;

        try {
            for (const node of document.querySelectorAll('#chat .mes_text')) {
                const result = highlightMessageText(node, regex);
                renderedMatches += result.count;
                firstMatch ??= result.firstMatch;
            }
        } finally {
            releaseChatSearchApply(chatbarState, applyToken);
        }

        const totalMatches = Math.max(searchMatches.totalMatches, renderedMatches);
        setSearchStatusText(getChatSearchStatusText(totalMatches, renderedMatches));

        if (scrollToFirst && firstMatch instanceof HTMLElement) {
            scrollElementIntoManagedView(firstMatch, {
                block: 'center',
                behavior: getReducedMotionScrollBehavior(),
            });
        } else if (scrollToFirst && Number.isInteger(firstMatchId)) {
            const messageElement = getChatMessageElement(firstMatchId);
            if (messageElement instanceof HTMLElement) {
                messageElement.classList.add('sb-search-hit');
                window.setTimeout(() => messageElement.classList.remove('sb-search-hit'), 2400);
                scrollElementIntoManagedView(messageElement, {
                    block: 'center',
                    behavior: getReducedMotionScrollBehavior(),
                });
            }
        }
    }

    function scheduleChatSearchHighlight({ scrollToFirst = false } = {}) {
        const chatbarState = getChatbarState();
        chatbarState.pendingSearchScroll = chatbarState.pendingSearchScroll || scrollToFirst;

        clearTimeout(chatbarState.searchTimer);
        chatbarState.searchTimer = window.setTimeout(() => {
            const shouldScroll = chatbarState.pendingSearchScroll;
            chatbarState.pendingSearchScroll = false;
            void applyChatSearchHighlights({ scrollToFirst: shouldScroll });
        }, SB_CHATBAR_SEARCH_DEBOUNCE);
    }

    return {
        describeChatName,
        formatChatSelectorLabel,
        normalizeChatInfo,
        getChatFilesForContext,
        openChatById,
        handleRenameChat,
        handleDeleteChat,
        handleAutoNameChat,
        handleMassDeleteChats,
        renderChatFiles,
        buildChatSidebar,
        isChatSidebarOpen,
        setChatSidebarOpenState,
        toggleChatSidebar,
        getSearchTerms,
        clearChatSearchHighlights,
        applyChatSearchHighlights,
        scheduleChatSearchHighlight,
    };
}
