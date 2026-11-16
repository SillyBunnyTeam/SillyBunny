/**
 * @typedef {object} HeaderAction
 * @property {string} id
 * @property {string} label
 * @property {string} icon Font Awesome icon name without the fa- prefix.
 * @property {(trigger: HTMLButtonElement) => void} onActivate
 * @property {boolean} [menu=false]
 * @property {boolean} [toggle=false]
 * @property {boolean} [pressed=false]
 * @property {number} [overflowPriority]
 * @property {string} [className] Extra classes for this action's button.
 */

/**
 * @typedef {object} HeaderTitleButton
 * @property {string} label What the button does: its tooltip, and the end of its accessible name, which starts with the text the button shows.
 * @property {(trigger: HTMLButtonElement) => void} onActivate
 * @property {string} [className] Extra classes for the button.
 */

/**
 * Creates a list header with caller-owned actions and overflow policy.
 * With `titleButton` the titles and a chevron sit inside one button that opens a picker.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {HeaderAction[]} [options.actions=[]]
 * @param {string} [options.className]
 * @param {HeaderTitleButton} [options.titleButton]
 * @param {string} [options.titleClassName]
 * @param {string} [options.subtitleClassName]
 * @returns {{ element: HTMLElement, titleButton: HTMLButtonElement|null, setTitle: (text: string) => void,
 *   setSubtitle: (text: string) => void, setSubtitleHidden: (hidden: boolean) => void,
 *   button: (id: string) => HTMLButtonElement|null, setPressed: (id: string, pressed: boolean) => void,
 *   setOverflowed: (ids: string[]) => void, destroy: () => void }}
 */
export function createListHeader({
    title, subtitle = '', actions = [], className = '', titleButton: titleButtonOptions = null, titleClassName = '', subtitleClassName = '',
}) {
    const element = document.createElement('header');
    element.className = ['sb-list-header', className].filter(Boolean).join(' ');
    const titles = document.createElement('div');
    titles.className = 'sb-list-header__titles';
    const titleElement = document.createElement('span');
    titleElement.className = ['sb-list-header__title', titleClassName].filter(Boolean).join(' ');
    titleElement.textContent = title;
    const subtitleElement = document.createElement('span');
    subtitleElement.className = ['sb-list-header__subtitle', subtitleClassName].filter(Boolean).join(' ');
    subtitleElement.textContent = subtitle;
    // Block spans give no space in their text, so axe reads the title and subtitle of a button as one word ("Book3 entries") and finds it missing from the name.
    if (titleButtonOptions) titles.append(titleElement, document.createTextNode(' '), subtitleElement);
    else titles.append(titleElement, subtitleElement);
    const spacer = document.createElement('span');
    spacer.className = 'sb-list-header__spacer';
    spacer.setAttribute('aria-hidden', 'true');
    const cleanups = [];
    let titleButton = null;
    if (titleButtonOptions) {
        titleButton = document.createElement('button');
        titleButton.type = 'button';
        titleButton.className = ['sb-list-header__title-button', titleButtonOptions.className].filter(Boolean).join(' ');
        titleButton.title = titleButtonOptions.label;
        titleButton.setAttribute('aria-haspopup', 'dialog');
        titleButton.setAttribute('aria-expanded', 'false');
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-down';
        chevron.setAttribute('aria-hidden', 'true');
        titleButton.append(titles, chevron);
        const onTitleClick = () => titleButtonOptions.onActivate(titleButton);
        titleButton.addEventListener('click', onTitleClick);
        cleanups.push(() => titleButton.removeEventListener('click', onTitleClick));
    }
    element.append(titleButton ?? titles, spacer);

    // Label in Name: the name has to contain all the text the button shows, so it starts with the titles and ends with what the button does.
    const nameTitleButton = () => {
        if (!titleButton) return;
        const shown = [titleElement, subtitleElement].filter(node => !node.hidden).map(node => node.textContent.trim()).filter(Boolean).join(' ');
        titleButton.setAttribute('aria-label', shown ? `${shown}, ${titleButtonOptions.label}` : titleButtonOptions.label);
    };
    nameTitleButton();

    const buttons = new Map();
    for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = ['sb-list-header__button', 'sb-header-icon-button', action.className].filter(Boolean).join(' ');
        button.dataset.actionId = action.id;
        button.setAttribute('aria-label', action.label);
        button.title = action.label;
        const icon = document.createElement('i');
        icon.className = `fa-solid fa-${action.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
        if (action.menu) {
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute('aria-expanded', 'false');
        }
        if (action.toggle) button.setAttribute('aria-pressed', String(Boolean(action.pressed)));
        if (action.overflowPriority !== undefined) button.dataset.overflowPriority = String(action.overflowPriority);
        const onClick = () => action.onActivate(button);
        button.addEventListener('click', onClick);
        cleanups.push(() => button.removeEventListener('click', onClick));
        buttons.set(action.id, button);
        element.append(button);
    }

    return {
        element,
        titleButton,
        setTitle(text) {
            if (titleElement.textContent !== text) titleElement.textContent = text;
            nameTitleButton();
        },
        setSubtitle(text) {
            if (subtitleElement.textContent !== text) subtitleElement.textContent = text;
            nameTitleButton();
        },
        setSubtitleHidden(hidden) {
            subtitleElement.hidden = hidden;
            nameTitleButton();
        },
        button: id => buttons.get(id) ?? null,
        setPressed(id, pressed) {
            const button = buttons.get(id);
            if (button?.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(Boolean(pressed)));
        },
        setOverflowed(ids) {
            const overflowed = new Set(ids);
            for (const [id, button] of buttons) button.hidden = overflowed.has(id);
        },
        destroy() {
            for (const cleanup of cleanups) cleanup();
            cleanups.length = 0;
        },
    };
}
