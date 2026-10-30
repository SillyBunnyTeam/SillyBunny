import { t } from '../i18n.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { createArtPlaceholder } from './art.js';
import { markCopyPlaceholder } from './copy.js';
import { formatProgress, getGettingStartedSteps, getIntroArtName, getSharedGettingStartedState } from './getting-started.js';
import { openShellTarget } from './shell-targets.js';
import { createStepRow } from './step-rows.js';

/**
 * @param {string} artName The art the intro opens with.
 * @returns {{ intro: HTMLElement, showArt: (name: string) => void }} `showArt` swaps the art for the one named.
 */
function createIntro(artName) {
    const intro = document.createElement('div');
    intro.className = 'sbHomeIntro';
    let art = createArtPlaceholder(artName);
    intro.append(art, markCopyPlaceholder(document.createElement('p'), 'GS-INTRO'));
    const showArt = (name) => {
        if (art.dataset.sbArtPlaceholder === name) {
            return;
        }
        const next = createArtPlaceholder(name);
        art.replaceWith(next);
        art = next;
    };
    return { intro, showArt };
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
    const artName = () => getIntroArtName(state.getResolvedCount(), state.getTotal());
    const { intro, showArt } = createIntro(artName());

    dialog = openDialog({
        tier: 'dialog',
        title: t`Getting Started`,
        subtitle: progress(),
        className: 'sbGettingStartedDialog',
        content: body => body.append(intro, createPrefGroup({ field: 'getting-started-group', rows: steps }).section),
    });
    const stopFollowing = state.subscribe(() => {
        steps.forEach(step => step.sync());
        dialog.setSubtitle(progress());
        showArt(artName());
    });
    void dialog.closed.then(stopFollowing);
    return dialog;
}
