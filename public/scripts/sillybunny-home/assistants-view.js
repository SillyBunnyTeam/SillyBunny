import { t } from '../i18n.js';
import { getLastChatMode } from '../sillybunny-chat-mode-memory.js';
import { createArtPlaceholder } from './art.js';
import { markCopyPlaceholder } from './copy.js';
import { buildAssistantMenuSections, openAssistantMenu } from './menu.js';

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
function createActionButton(className, { name, title, disabled = false, onActivate }) {
    const button = createElement('button', className);
    button.type = 'button';
    button.setAttribute('aria-label', name);
    if (title) {
        button.title = title;
    }
    button.disabled = disabled;
    button.addEventListener('click', onActivate);
    return button;
}

/**
 * A footer control shows its icon always and its label when the footer has room for both labels. The tooltip
 * carries the full name for the icon-only form and for a label that is cut short.
 */
function createFootButton({ icon, label, name, title, disabled, onActivate }) {
    const button = createActionButton('sbHomeFootButton', { name, title, disabled, onActivate });
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
function createCardAction({ name, title, disabled, subtitleId, onActivate }) {
    const button = createActionButton('sbHomeCardOpen', { name, title, disabled, onActivate });
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

/**
 * The art is a box that stands where artwork will go, unless the card of the character is the art: then the box holds
 * its thumbnail.
 */
function createCardArt({ art }, getThumbnailUrl) {
    const box = createElement('div', 'sbHomeCardArt');
    box.dataset.sbHomeRegion = 'assistant-art';
    const picture = createArtPlaceholder(art.name);
    if (art.avatar) {
        const image = document.createElement('img');
        image.src = getThumbnailUrl(art.avatar);
        image.alt = '';
        image.decoding = 'async';
        picture.replaceChildren(image);
    }
    box.append(picture);
    return box;
}

/**
 * A card whose file is missing or deleted has nothing to open, so its controls are disabled and it shows no menu.
 */
function createAssistantCard(card, panel, { actions, getThumbnailUrl }) {
    const titleId = `sb-home-${card.key}-title`;
    const subtitleId = `sb-home-${card.key}-sub`;
    const disabled = card.state !== 'available';
    const menuActions = { newChatInMode: mode => void actions.newChatInMode(card, mode) };

    const element = createElement('article', 'sbHomeCard');
    element.dataset.sbHomeKey = card.key;

    const footer = createElement('div', 'sbHomeCardFooter');
    footer.append(
        createFootButton({
            icon: 'fa-solid fa-plus',
            label: t`Start New Chat`,
            name: t`Start new chat with ${card.name}`,
            title: t`Start New Chat With ${card.name}`,
            disabled,
            onActivate: () => void actions.newChat(card),
        }),
        createFootButton({
            icon: 'fa-solid fa-hourglass-half',
            label: t`Temporary Chat`,
            name: t`Temporary Chat with ${card.name}`,
            title: t`Temporary Chat With ${card.name}`,
            disabled,
            onActivate: () => void actions.temporaryChat(card),
        }),
    );

    if (buildAssistantMenuSections({ lastMode: getLastChatMode(), actions: menuActions, state: card.state }).length > 0) {
        const menuButton = createMenuButton(`sb-home-${card.key}-menu`);
        // Reads as "Assistant Menu Reisen": the button's own name, then the card's title.
        menuButton.setAttribute('aria-labelledby', `${menuButton.id} ${titleId}`);
        menuButton.addEventListener('click', (event) => {
            openAssistantMenu(menuButton, { lastMode: getLastChatMode(), actions: menuActions, state: card.state }, { keyboard: event.detail === 0, bounds: panel });
        });
        footer.append(menuButton);
    }

    element.append(
        createCardAction({
            name: t`New chat with ${card.name}`,
            title: t`New Chat With ${card.name}`,
            disabled,
            subtitleId,
            onActivate: () => void actions.newChat(card),
        }),
        createCardArt(card, getThumbnailUrl),
        createCardText({ name: card.name, titleId, subtitleId, slot: card.slot }),
        footer,
    );
    return element;
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
 * Fills the Assistants section: a grid with a card for each assistant and a More Assistants card. The cards are read
 * again on every call, so a render of Home shows the library as it is.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} options
 * @param {() => void} options.openMoreAssistants Opens the Bundled Extras window at its Assistants group.
 * @param {() => import('./assistant-cards.js').AssistantCard[]} options.getCards
 * @param {ReturnType<typeof import('./assistant-actions.js').createAssistantActions>} options.actions
 * @param {(avatar: string) => string} options.getThumbnailUrl The URL of the thumbnail of a character's card.
 */
export function mountAssistants(panel, { openMoreAssistants, getCards, actions, getThumbnailUrl }) {
    const grid = panel.querySelector('[data-sb-home-list="assistants"]');
    if (!grid) {
        return;
    }

    grid.replaceChildren(...getCards().map(card => createAssistantCard(card, panel, { actions, getThumbnailUrl })), createMoreCard(openMoreAssistants));
}
