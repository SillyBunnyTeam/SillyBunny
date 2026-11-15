import { t } from '../i18n.js';

/**
 * The Show More row at the end of a boxed list that loads in batches. It holds one button; the caller owns the count of
 * rows shown and what a press loads, and calls `update` after each render. The row hides itself once everything is shown.
 *
 * @param {object} options
 * @param {() => (void|Promise<void>)} options.onShowMore Loads the next batch. A press while it runs is ignored.
 * @returns {{ element: HTMLElement, button: HTMLButtonElement, update: (state: { shown: number, total: number }) => void,
 *   readonly isComplete: boolean, destroy: () => void }}
 */
export function createListShowMore({ onShowMore }) {
    const element = document.createElement('div');
    element.className = 'sb-list-show-more';
    element.hidden = true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-list-show-more__button';
    // HUMAN: replace — the label of the button that loads the next batch of rows (DESIGN.md names it "Show More"), in header capitalisation.
    button.textContent = t`TODO(copy)`;
    button.setAttribute('data-sb-copy-placeholder', 'true');
    element.append(button);

    let busy = false;
    let destroyed = false;

    async function onClick() {
        if (busy || destroyed) return;
        busy = true;
        button.setAttribute('aria-busy', 'true');
        try {
            await onShowMore();
        } finally {
            busy = false;
            button.removeAttribute('aria-busy');
        }
    }
    button.addEventListener('click', onClick);

    return {
        element,
        button,
        update({ shown, total }) {
            element.hidden = !(total > shown);
        },
        get isComplete() {
            return element.hidden;
        },
        destroy() {
            destroyed = true;
            button.removeEventListener('click', onClick);
        },
    };
}
