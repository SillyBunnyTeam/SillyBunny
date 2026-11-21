import { t } from '../i18n.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { formatProgress, getGettingStartedSteps, getIntroArtName, getIntroLine, getSharedGettingStartedState } from './getting-started.js';
import { openShellTarget } from './shell-targets.js';
import { createStepRow } from './step-rows.js';
import { createArtIntro } from './art-intro.js';
import { focusFirstHomeTile, openHelp } from './windows.js';

/** @type {ReturnType<typeof openDialog> | null} */
let openWindow = null;

/**
 * Hide Getting Started and what it does, for a finished list. Hide is the one suggested action of the window.
 * @param {() => void} onHide
 */
function createFinishedActions(onHide) {
    const actions = document.createElement('div');
    actions.className = 'sbGettingStartedFinish';

    const caption = document.createElement('p');
    caption.className = 'sbGettingStartedHideCaption';
    caption.id = 'sb-getting-started-hide-caption';
    caption.textContent = t`You can bring it back from the Home menu.`;

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'menu_button menu_button_primary is-suggested sbGettingStartedHide';
    hide.textContent = t`Hide Getting Started`;
    hide.setAttribute('aria-describedby', caption.id);
    hide.addEventListener('click', onHide);

    actions.append(hide, caption);
    return actions;
}

/**
 * Closes the Getting Started window, if it is open, and settles once it has gone.
 * @returns {Promise<unknown>}
 */
export async function closeGettingStartedWindow() {
    const dialog = openWindow;
    if (!dialog) {
        return;
    }
    void dialog.close('show-me');
    await dialog.closed;
}

/**
 * Opens the Getting Started window: Reisen's intro and the four steps. It applies each change at once and has
 * no responses, so it shows Close. The window follows the state while it is open, so a step skipped here, or
 * resolved elsewhere, shows at once, and the progress in the header follows. While every step is resolved it also
 * offers Hide Getting Started under Reisen's line; that hides the tile, closes the window and puts focus on the first
 * tile that is left, because the tile that opened the window is gone.
 * @param {object} [options]
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} [options.state]
 * @param {(target: string) => unknown} [options.openTarget]
 * @param {(topicId: string) => unknown} [options.openHelpTopic] Opens Help at a topic. Learn More calls it.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openGettingStartedWindow({ state = getSharedGettingStartedState(), openTarget = openShellTarget, openHelpTopic = topic => openHelp({ topic }) } = {}) {
    await ensureWindowStyles();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    // The target opens only after the window has gone, so focus and the inert backdrop are settled first.
    const showMe = (target) => {
        void dialog.close('show-me');
        void dialog.closed.then(() => openTarget(target));
    };
    // Learn More leaves the window the way Show Me does, so Help does not open as a page over it.
    const learnMore = (topicId) => {
        void dialog.close('learn-more');
        void dialog.closed.then(() => openHelpTopic(topicId));
    };
    const steps = getGettingStartedSteps().map(step => createStepRow({
        step,
        field: `getting-started-${step.id}`,
        labelId: `sb-getting-started-${step.id}-title`,
        onShowMe: showMe,
        onLearnMore: learnMore,
        state,
    }));
    const progress = () => formatProgress(state.getResolvedCount(), state.getTotal());
    const pose = () => {
        const resolved = state.getResolvedCount();
        const total = state.getTotal();
        return { art: getIntroArtName(resolved, total), text: getIntroLine(resolved, total) };
    };
    const { intro, show } = createArtIntro(pose());
    const { section } = createPrefGroup({ field: 'getting-started-group', rows: steps });
    const hideGettingStarted = () => {
        state.hideFinished();
        void dialog.close('hide');
        void dialog.closed.then(focusFirstHomeTile);
    };
    const finishedActions = createFinishedActions(hideGettingStarted);
    // The intro replaces its line when the state changes, so the actions are placed before the list and not after the line.
    const showFinishedActions = () => {
        if (!state.isFinished()) {
            finishedActions.remove();
        } else if (!finishedActions.isConnected) {
            section.before(finishedActions);
        }
    };

    dialog = openDialog({
        tier: 'dialog',
        title: t`Getting Started`,
        subtitle: progress(),
        className: 'sbGettingStartedDialog',
        content: body => body.append(intro, section),
    });
    openWindow = dialog;
    showFinishedActions();
    const stopFollowing = state.subscribe(() => {
        steps.forEach(step => step.sync());
        dialog.setSubtitle(progress());
        show(pose());
        showFinishedActions();
    });
    void dialog.closed.then(() => {
        stopFollowing();
        if (openWindow === dialog) {
            openWindow = null;
        }
    });
    return dialog;
}
