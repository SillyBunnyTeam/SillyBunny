import { t } from '../i18n.js';
import { markCopyPlaceholder } from './copy.js';
import { openShellTarget } from './shell-targets.js';

/** @type {unknown} */
let current = null;

/**
 * Decides what the completion toast says: the step that just finished and the next one that is still open,
 * searching on from the finished step and wrapping round to an earlier open step.
 * @param {object} options
 * @param {readonly import('./getting-started.js').GettingStartedStep[]} options.steps
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} options.state
 * @param {string} options.finishedId
 * @returns {{ finished: import('./getting-started.js').GettingStartedStep, next: import('./getting-started.js').GettingStartedStep } | null}
 *   Null when the tile is hidden, because the user chose not to see Getting Started, or when no step is left open.
 */
export function planCompletionToast({ steps, state, finishedId }) {
    const index = steps.findIndex(step => step.id === finishedId);
    if (index === -1) {
        throw new Error(`Unknown Getting Started step: ${finishedId}`);
    }
    if (state.isHidden()) {
        return null;
    }
    const after = [...steps.slice(index + 1), ...steps.slice(0, index)];
    const next = after.find(step => !state.isDone(step.id) && !state.isSkipped(step.id));
    return next ? { finished: steps[index], next } : null;
}

/**
 * Shows the completion toast: the finished step as its title, two lines of copy and one Show Me button that opens
 * the place of the next step. The toast replaces the one still on screen. toastr has no action button of its own,
 * so the button is part of the message, as in the draft-recovery toast of the editors.
 * @param {NonNullable<ReturnType<typeof planCompletionToast>>} plan
 * @param {object} [deps]
 * @param {Pick<typeof toastr, 'success' | 'clear'>} [deps.toast]
 * @param {(target: string) => unknown} [deps.openTarget]
 * @param {() => Promise<unknown> | unknown} [deps.closeWindow] Closes the Getting Started window, which the toast may be on top of.
 * @param {() => void} [deps.moveIntoDialog] Moves the toast container into the top dialog, as the app does for every
 *   toast, because a modal dialog makes the rest of the page inert and a toast behind it could not be pressed.
 */
export function showCompletionToast(plan, { toast = globalThis.toastr, openTarget = openShellTarget, closeWindow = () => {}, moveIntoDialog = () => {} } = {}) {
    const title = document.createElement('span');
    title.textContent = plan.finished.title;

    const done = markCopyPlaceholder(document.createElement('div'), 'GS-TOAST-DONE');

    const next = document.createElement('div');
    const nextTitle = document.createElement('strong');
    nextTitle.textContent = plan.next.title;
    const nextLine = markCopyPlaceholder(document.createElement('span'), 'GS-TOAST-NEXT');
    next.append(nextTitle, ' ', nextLine);

    const showMe = document.createElement('button');
    showMe.type = 'button';
    showMe.className = 'sbHomeToastAction';
    showMe.textContent = t`Show Me`;

    const message = document.createElement('div');
    message.className = 'sbHomeToast';
    message.append(done, next, showMe);

    if (current) {
        toast.clear(current, { force: true });
    }
    const shown = toast.success(message, title, {
        timeOut: 12000,
        extendedTimeOut: 6000,
        closeButton: true,
        escapeHtml: false,
        // These options replace the global onHidden, which keeps the container inside a dialog that is still open.
        onHidden: () => {
            if (current === shown) {
                current = null;
            }
            moveIntoDialog();
        },
    });
    current = shown;
    moveIntoDialog();

    showMe.addEventListener('click', async () => {
        toast.clear(shown, { force: true });
        await closeWindow();
        openTarget(plan.next.target);
    }, { once: true });
}
