import { t } from '../i18n.js';
import { getHomeDestination } from './destinations.js';
import { openShellTarget } from './shell-targets.js';

/** @type {unknown} */
let current = null;

/**
 * Decides what the toast of a step that just finished says. While a step is still open, that is the finished step and
 * the next open one, searching on from the finished step and wrapping round to an earlier open step. When the step
 * was the last one, it is the final toast.
 * @param {object} options
 * @param {readonly import('./getting-started.js').GettingStartedStep[]} options.steps
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} options.state
 * @param {string} options.finishedId
 * @returns {{ kind: 'next', finished: import('./getting-started.js').GettingStartedStep, next: import('./getting-started.js').GettingStartedStep } | { kind: 'finished' } | null}
 *   Null when the tile is hidden, because the user chose not to see Getting Started.
 */
export function planCompletionToast({ steps, state, finishedId }) {
    const index = steps.findIndex(step => step.id === finishedId);
    if (index === -1) {
        throw new Error(`Unknown Getting Started step: ${finishedId}`);
    }
    if (state.isHidden()) {
        return null;
    }
    if (state.isFinished()) {
        return { kind: 'finished' };
    }
    const after = [...steps.slice(index + 1), ...steps.slice(0, index)];
    const next = after.find(step => !state.isDone(step.id) && !state.isSkipped(step.id));
    return next ? { kind: 'next', finished: steps[index], next } : null;
}

/**
 * Shows one toast with a title, a body and one Show Me button. The toast replaces the one still on screen. toastr has
 * no action button of its own, so the button is part of the message, as in the draft-recovery toast of the editors.
 * @param {object} options
 * @param {string} options.title
 * @param {HTMLElement[]} options.lines
 * @param {() => Promise<unknown> | unknown} options.onShowMe Runs once, after the toast has been cleared.
 * @param {Pick<typeof toastr, 'success' | 'clear'>} options.toast
 * @param {() => void} options.moveIntoDialog
 */
function showToast({ title: titleText, lines, onShowMe, toast, moveIntoDialog }) {
    const title = document.createElement('span');
    title.textContent = titleText;

    const showMe = document.createElement('button');
    showMe.type = 'button';
    showMe.className = 'sbHomeToastAction';
    showMe.textContent = t`Show Me`;

    const message = document.createElement('div');
    message.className = 'sbHomeToast';
    message.append(...lines, showMe);

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
        await onShowMe();
    }, { once: true });
}

/**
 * Shows the toast that a plan describes. A step toast has the finished step as its title, two lines and a Show Me
 * button that opens the place of the next step. The final toast has the title of Getting Started, one line and a
 * Show Me button that opens the Getting Started window, where the finished state is.
 * @param {NonNullable<ReturnType<typeof planCompletionToast>>} plan
 * @param {object} [deps]
 * @param {Pick<typeof toastr, 'success' | 'clear'>} [deps.toast]
 * @param {(target: string) => unknown} [deps.openTarget]
 * @param {() => Promise<unknown> | unknown} [deps.closeWindow] Closes the Getting Started window, which the toast may be on top of.
 * @param {() => unknown} [deps.openWindow] Opens the Getting Started window, for the final toast.
 * @param {() => void} [deps.moveIntoDialog] Moves the toast container into the top dialog, as the app does for every
 *   toast, because a modal dialog makes the rest of the page inert and a toast behind it could not be pressed.
 */
export function showCompletionToast(plan, { toast = globalThis.toastr, openTarget = openShellTarget, closeWindow = () => {}, openWindow = () => {}, moveIntoDialog = () => {} } = {}) {
    if (plan.kind === 'finished') {
        const finished = document.createElement('div');
        finished.dataset.sbHomeToast = 'finished';
        finished.textContent = t`Congrats, you've completed every step I've given you! You can dismiss it in Home whenever you'd like.`;
        showToast({ title: getHomeDestination('getting-started').getTitle(), lines: [finished], onShowMe: openWindow, toast, moveIntoDialog });
        return;
    }

    const done = document.createElement('div');
    done.dataset.sbHomeToast = 'done';
    done.textContent = t`Well done! That step is finished.`;

    const next = document.createElement('div');
    const nextTitle = document.createElement('strong');
    nextTitle.textContent = plan.next.title;
    // The sentence continues after the title of the next step, which is in bold.
    const nextLine = document.createElement('span');
    nextLine.dataset.sbHomeToast = 'next-line';
    nextLine.textContent = t`is next, whenever you're ready.`;
    next.append(nextTitle, ' ', nextLine);

    showToast({
        title: plan.finished.title,
        lines: [done, next],
        onShowMe: async () => {
            await closeWindow();
            openTarget(plan.next.target);
        },
        toast,
        moveIntoDialog,
    });
}
