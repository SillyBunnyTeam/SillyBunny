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
 */

/**
 * Creates a list header with caller-owned actions and overflow policy.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {HeaderAction[]} [options.actions=[]]
 * @param {string} [options.className]
 * @returns {{ element: HTMLElement, setTitle: (text: string) => void, setSubtitle: (text: string) => void,
 *   button: (id: string) => HTMLButtonElement|null, setPressed: (id: string, pressed: boolean) => void,
 *   setOverflowed: (ids: string[]) => void, destroy: () => void }}
 */
export function createListHeader({ title, subtitle = '', actions = [], className = '' }) {
    const element = document.createElement('header');
    element.className = ['sb-list-header', className].filter(Boolean).join(' ');
    const titles = document.createElement('div');
    titles.className = 'sb-list-header__titles';
    const titleElement = document.createElement('span');
    titleElement.className = 'sb-list-header__title';
    titleElement.textContent = title;
    const subtitleElement = document.createElement('span');
    subtitleElement.className = 'sb-list-header__subtitle';
    subtitleElement.textContent = subtitle;
    titles.append(titleElement, subtitleElement);
    const spacer = document.createElement('span');
    spacer.className = 'sb-list-header__spacer';
    spacer.setAttribute('aria-hidden', 'true');
    element.append(titles, spacer);

    const buttons = new Map();
    const cleanups = [];
    for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-list-header__button';
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
        setTitle(text) {
            if (titleElement.textContent !== text) titleElement.textContent = text;
        },
        setSubtitle(text) {
            if (subtitleElement.textContent !== text) subtitleElement.textContent = text;
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
