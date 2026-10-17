/**
 * @param {object} options
 * @param {string} options.icon Font Awesome icon name without the fa- prefix.
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {{label: string, onActivate?: (event: MouseEvent) => void, primary?: boolean}[]} [options.actions=[]]
 * @param {boolean} [options.compact=false]
 * @returns {{element: HTMLDivElement, update: (values: {icon?: string, title?: string, description?: string}) => void}}
 */
export function createStatusPage({ icon, title, description, actions = [], compact = false }) {
    const element = document.createElement('div');
    element.className = 'sb-status-page';
    element.classList.toggle('sb-status-page--compact', Boolean(compact));
    element.setAttribute('role', 'status');
    const glyph = document.createElement('i');
    glyph.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('h3');
    heading.className = 'sb-status-page__title';
    const detail = document.createElement('p');
    detail.className = 'sb-status-page__description';
    element.append(glyph, heading);
    if (actions.length) {
        const buttons = document.createElement('div');
        buttons.className = 'sb-status-page__actions';
        for (const { label, onActivate, primary = false } of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button sb-status-page__action';
            button.classList.toggle('menu_button_primary', Boolean(primary));
            button.classList.toggle('is-suggested', Boolean(primary));
            button.textContent = label;
            button.addEventListener('click', event => onActivate?.(event));
            buttons.append(button);
        }
        element.append(buttons);
    }
    const update = values => {
        if (Object.hasOwn(values, 'icon')) {
            glyph.className = `fa-solid${values.icon ? ` fa-${values.icon}` : ''} sb-status-page__icon`;
        }
        if (Object.hasOwn(values, 'title')) heading.textContent = values.title ?? '';
        if (!Object.hasOwn(values, 'description')) return;
        detail.textContent = values.description ?? '';
        if (values.description) heading.after(detail);
        else detail.remove();
    };
    update({ icon, title, description });
    return { element, update };
}
