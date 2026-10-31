import { t } from '../i18n.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { createArtIntro } from './art-intro.js';
import { formatProgress, getGettingStartedSteps, getIntroArtName, getIntroLineSlot, getSharedGettingStartedState } from './getting-started.js';
import { openShellTarget } from './shell-targets.js';
import { createStepRow } from './step-rows.js';

/** @type {ReturnType<typeof openDialog> | null} */
let openWindow = null;

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
 * resolved elsewhere, shows at once, and the progress in the header follows.
 * @param {object} [options]
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} [options.state]
 * @param {(target: string) => unknown} [options.openTarget]
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openGettingStartedWindow({ state = getSharedGettingStartedState(), openTarget = openShellTarget } = {}) {
    await ensureWindowStyles();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    // The target opens only after the window has gone, so focus and the inert backdrop are settled first.
    const showMe = (target) => {
        void dialog.close('show-me');
        void dialog.closed.then(() => openTarget(target));
    };
    const steps = getGettingStartedSteps().map(step => createStepRow({
        step,
        field: `getting-started-${step.id}`,
        slot: step.slot,
        labelId: `sb-getting-started-${step.id}-title`,
        onShowMe: showMe,
        state,
    }));
    const progress = () => formatProgress(state.getResolvedCount(), state.getTotal());
    const pose = () => {
        const resolved = state.getResolvedCount();
        const total = state.getTotal();
        return { art: getIntroArtName(resolved, total), slot: getIntroLineSlot(resolved, total) };
    };
    const { intro, show } = createArtIntro(pose());

    dialog = openDialog({
        tier: 'dialog',
        title: t`Getting Started`,
        subtitle: progress(),
        className: 'sbGettingStartedDialog',
        content: body => body.append(intro, createPrefGroup({ field: 'getting-started-group', rows: steps }).section),
    });
    openWindow = dialog;
    const stopFollowing = state.subscribe(() => {
        steps.forEach(step => step.sync());
        dialog.setSubtitle(progress());
        show(pose());
    });
    void dialog.closed.then(() => {
        stopFollowing();
        if (openWindow === dialog) {
            openWindow = null;
        }
    });
    return dialog;
}
