import { t } from '../i18n.js';
import { getLastChatMode } from '../sillybunny-chat-mode-memory.js';
import { createExpanderRow, createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { createArtPlaceholder } from './art.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';
import { openAssistantMenu } from './menu.js';
import { PLACEHOLDER_ASSISTANTS, PLACEHOLDER_MORE_ASSISTANTS } from './placeholder-assistants.js';
import { stubAction } from './stubs.js';

/**
 * The source is set when the row is first shown. A browser fetches a lazy image inside a closed
 * details element anyway, and the portrait is far larger than its thumbnail.
 */
function createPortrait(src) {
    const image = document.createElement('img');
    image.className = 'sbHomeAssistantPortrait';
    image.dataset.src = src;
    image.alt = '';
    image.width = 64;
    image.height = 64;
    image.loading = 'lazy';
    image.decoding = 'async';
    return image;
}

function createMenuButton(menuId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = menuId;
    button.className = 'sbHomeRowMenu';
    button.title = t`Assistant Menu`;
    button.setAttribute('aria-label', t`Assistant Menu`);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-ellipsis-vertical fa-fw';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    return button;
}

/**
 * The row is the activation target, and buttons cannot nest, so an overlay button covers the row
 * under the menu button, as in a Recent Chats row. The row's own text names and describes it.
 */
function createOpenButton(titleId, subtitleId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sbHomeRowOpen';
    button.setAttribute('aria-labelledby', titleId);
    button.setAttribute('aria-describedby', subtitleId);
    return button;
}

function loadPortraits(container) {
    container.querySelectorAll('img[data-src]').forEach((image) => {
        image.src = image.dataset.src;
        delete image.dataset.src;
    });
}

/** The menu opens, and its items do nothing yet. */
const STUB_ACTIONS = Object.freeze({
    newChat: stubAction('assistant.new-chat'),
    temporaryChat: stubAction('assistant.temporary-chat'),
    openInMode: stubAction('assistant.open-in-mode'),
});

function createAssistantRow(assistant, panel) {
    const prefix = assistant.portrait ? createPortrait(assistant.portrait) : createArtPlaceholder(assistant.art);
    const titleId = `sb-home-assistant-${assistant.id}-title`;
    const subtitleId = `sb-home-assistant-${assistant.id}-sub`;
    const menuButton = createMenuButton(`sb-home-assistant-${assistant.id}-menu`);
    const openButton = createOpenButton(titleId, subtitleId);
    const activate = stubAction('assistant.activate');

    const controller = createRow({
        label: assistant.name,
        subtitle: COPY_PLACEHOLDER,
        field: `assistant-${assistant.id}`,
        prefix,
        suffix: menuButton,
    });
    markRowSubtitle(controller, assistant.slot);
    controller.row.querySelector('.ds-row-label').id = titleId;
    controller.row.querySelector('.ds-row-subtitle').id = subtitleId;
    // Reads as "Assistant Menu Reisen": the button's own name, then the row's title.
    menuButton.setAttribute('aria-labelledby', `${menuButton.id} ${titleId}`);
    controller.row.classList.add('sbHomeAssistantRow');
    controller.row.dataset.sbStub = 'true';
    controller.row.prepend(openButton);

    openButton.addEventListener('click', () => activate());
    menuButton.addEventListener('click', (event) => {
        openAssistantMenu(
            menuButton,
            { lastMode: getLastChatMode(), actions: STUB_ACTIONS },
            { keyboard: event.detail === 0, bounds: panel },
        );
    });
    return controller;
}

/**
 * Fills the Assistants section: a boxed list of rows and a collapsed row with the rest.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 */
export function mountAssistants(panel) {
    const section = panel.querySelector('[data-sb-home-region="assistants"]');
    const list = section?.querySelector('[data-sb-home-list="assistants"]');
    if (!list) {
        return;
    }

    const more = createExpanderRow({
        label: t`More Assistants`,
        field: 'assistants-more',
        children: PLACEHOLDER_MORE_ASSISTANTS.map(assistant => createAssistantRow(assistant, panel)),
        onToggle: open => open && loadPortraits(more.content),
    });
    const rows = [...PLACEHOLDER_ASSISTANTS.map(assistant => createAssistantRow(assistant, panel)), more];
    list.replaceChildren(createPrefGroup({ field: 'assistants-group', rows }).section);
}
