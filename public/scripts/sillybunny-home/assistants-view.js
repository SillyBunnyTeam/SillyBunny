import { t } from '../i18n.js';
import { getLastChatMode } from '../sillybunny-chat-mode-memory.js';
import { createArtPlaceholder } from './art.js';
import { markCopyPlaceholder } from './copy.js';
import { openAssistantMenu } from './menu.js';
import { getHomeAssistants } from './assistant-registry.js';
import { stubAction } from './stubs.js';

const STUB_MARKER = 'true';
const MORE_SUBTITLE_SLOT = 'AS-MORE-SUB';

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}

function createIcon(classes) {
    const icon = document.createElement('i');
    icon.className = classes;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

/**
 * The accessible name is a sentence. The `title` is the tooltip, which is header-capitalised, so each one is a
 * translatable string of its own with the assistant's name in it.
 */
function createActionButton(className, { name, title, stub, onActivate }) {
    const button = createElement('button', className);
    button.type = 'button';
    button.setAttribute('aria-label', name);
    if (title) {
        button.title = title;
    }
    if (stub) {
        button.dataset.sbStub = STUB_MARKER;
    }
    button.addEventListener('click', onActivate);
    return button;
}

/**
 * A footer control shows its icon always and its label when the footer has room for both labels. The tooltip
 * carries the full name for the icon-only form and for a label that is cut short.
 */
function createFootButton({ icon, label, name, title, onActivate }) {
    const button = createActionButton('sbHomeFootButton', { name, title, stub: true, onActivate });
    button.append(createIcon(`${icon} fa-fw`), createElement('span', 'sbHomeFootLabel', label));
    return button;
}

function createMenuButton(id) {
    const button = createElement('button', 'sbHomeRowMenu');
    button.type = 'button';
    button.id = id;
    button.title = t`Assistant Menu`;
    button.setAttribute('aria-label', t`Assistant Menu`);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.append(createIcon('fa-solid fa-ellipsis-vertical fa-fw'));
    return button;
}

/**
 * The card is the activation target, and buttons cannot nest, so an overlay button covers the card behind
 * the footer, as in a Recent Chats row. The card's own text describes it.
 */
function createCardAction({ name, title, stub, subtitleId, onActivate }) {
    const button = createActionButton('sbHomeCardOpen', { name, title, stub, onActivate });
    button.setAttribute('aria-describedby', subtitleId);
    return button;
}

function createCardText({ name, titleId, subtitleId, slot }) {
    const text = createElement('div', 'sbHomeCardText');
    const title = createElement('strong', 'sbHomeCardName', name);
    title.id = titleId;
    const subtitle = markCopyPlaceholder(createElement('span', 'sbHomeCardSub'), slot);
    subtitle.id = subtitleId;
    text.append(title, subtitle);
    return text;
}

function createAssistantCard(assistant, panel) {
    const titleId = `sb-home-assistant-${assistant.id}-title`;
    const subtitleId = `sb-home-assistant-${assistant.id}-sub`;
    const startNewChat = stubAction('assistant.new-chat');
    const temporaryChat = stubAction('assistant.temporary-chat');
    const menuActions = { newChatInMode: stubAction('assistant.new-chat-in-mode') };

    const card = createElement('article', 'sbHomeCard');
    card.dataset.sbHomeKey = `assistant-${assistant.id}`;

    const art = createElement('div', 'sbHomeCardArt');
    art.dataset.sbHomeRegion = 'assistant-art';
    art.append(createArtPlaceholder(assistant.art));

    const menuButton = createMenuButton(`sb-home-assistant-${assistant.id}-menu`);
    // Reads as "Assistant Menu Reisen": the button's own name, then the card's title.
    menuButton.setAttribute('aria-labelledby', `${menuButton.id} ${titleId}`);
    menuButton.addEventListener('click', (event) => {
        openAssistantMenu(menuButton, { lastMode: getLastChatMode(), actions: menuActions }, { keyboard: event.detail === 0, bounds: panel });
    });

    const footer = createElement('div', 'sbHomeCardFooter');
    footer.append(
        createFootButton({
            icon: 'fa-solid fa-plus',
            label: t`Start New Chat`,
            name: t`Start new chat with ${assistant.name}`,
            title: t`Start New Chat With ${assistant.name}`,
            onActivate: startNewChat,
        }),
        createFootButton({
            icon: 'fa-solid fa-hourglass-half',
            label: t`Temporary Chat`,
            name: t`Temporary Chat with ${assistant.name}`,
            title: t`Temporary Chat With ${assistant.name}`,
            onActivate: temporaryChat,
        }),
        menuButton,
    );

    card.append(
        createCardAction({
            name: t`New chat with ${assistant.name}`,
            title: t`New Chat With ${assistant.name}`,
            stub: true,
            subtitleId,
            onActivate: startNewChat,
        }),
        art,
        createCardText({ name: assistant.name, titleId, subtitleId, slot: assistant.slot }),
        footer,
    );
    return card;
}

/** A card without a footer. In a narrow grid it is a short row, and the chevron shows that it opens something. */
function createMoreCard(openMoreAssistants) {
    const titleId = 'sb-home-assistants-more-title';
    const subtitleId = 'sb-home-assistants-more-sub';
    const card = createElement('article', 'sbHomeCard sbHomeCard--more');
    card.dataset.sbHomeKey = 'assistants-more';

    const icon = createElement('div', 'sbHomeMoreIcon');
    icon.setAttribute('aria-hidden', 'true');
    icon.append(createIcon('fa-solid fa-user-plus'));

    // Safari does not focus a button on click, and the window returns focus to the element that had it.
    const action = createCardAction({
        name: t`More Assistants`,
        subtitleId,
        onActivate: () => {
            action.focus({ preventScroll: true });
            openMoreAssistants();
        },
    });
    card.append(
        action,
        icon,
        createCardText({ name: t`More Assistants`, titleId, subtitleId, slot: MORE_SUBTITLE_SLOT }),
        createIcon('fa-solid fa-chevron-right sbHomeMoreChevron'),
    );
    return card;
}

/**
 * Fills the Assistants section: a grid with a card for each assistant and a More Assistants card.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} options
 * @param {() => void} options.openMoreAssistants Opens the Bundled Extras window at its Assistants group.
 */
export function mountAssistants(panel, { openMoreAssistants }) {
    const grid = panel.querySelector('[data-sb-home-list="assistants"]');
    if (!grid) {
        return;
    }

    grid.replaceChildren(...getHomeAssistants().map(assistant => createAssistantCard(assistant, panel)), createMoreCard(openMoreAssistants));
}
