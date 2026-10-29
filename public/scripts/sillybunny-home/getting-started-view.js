import { t } from '../i18n.js';
import { createExpanderRow, createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { createArtPlaceholder } from './art.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from './copy.js';
import { createGettingStartedState, formatProgress, getGettingStartedSteps } from './getting-started.js';
import { openShellTarget } from './shell-targets.js';

/** The section's `aria-labelledby` in the Home template points at this id. */
const TITLE_ID = 'sb-home-gs-title';

/** @type {ReturnType<typeof createGettingStartedState> | null} */
let sharedState = null;

/**
 * Home renders its panel again after many actions. One state for the page's lifetime keeps a skipped
 * step skipped across those renders, until a stored state replaces this one.
 */
function getSharedState() {
    sharedState ??= createGettingStartedState(getGettingStartedSteps().map(step => step.id));
    return sharedState;
}

function createFlatButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sbHomeFlatButton';
    button.textContent = label;
    return button;
}

function createTag(text) {
    const tag = document.createElement('span');
    tag.className = 'sbHomeTag';
    tag.textContent = text;
    return tag;
}

function createIntro() {
    const intro = document.createElement('div');
    intro.className = 'sbHomeIntro';
    const text = markCopyPlaceholder(document.createElement('p'), 'GS-INTRO');
    intro.append(createArtPlaceholder('gs-reisen'), text);
    return intro;
}

/** The title joins the heading outline like the other sections' titles. The summary keeps its row styling. */
function markTitleAsHeading(label) {
    const heading = document.createElement('h2');
    heading.className = label.className;
    heading.id = TITLE_ID;
    heading.textContent = label.textContent;
    label.replaceWith(heading);
}

/** @returns {{ row: HTMLElement, sync: () => void }} */
function createStepRow(step, state, openTarget) {
    const labelId = `sb-home-gs-${step.id}-title`;
    const showMe = createFlatButton(t`Show Me`);
    const skip = createFlatButton(t`Skip`);
    skip.setAttribute('aria-pressed', 'false');
    showMe.setAttribute('aria-describedby', labelId);
    skip.setAttribute('aria-describedby', labelId);

    const controller = createRow({
        label: step.title,
        subtitle: COPY_PLACEHOLDER,
        field: `getting-started-${step.id}`,
        suffix: [showMe, skip],
    });
    markRowSubtitle(controller, step.slot);
    controller.row.classList.add('sbHomeStepRow');

    const label = controller.row.querySelector('.ds-row-label');
    label.id = labelId;
    if (step.optional) {
        label.append(' ', createTag(t`Optional`));
    }
    const skippedTag = createTag(t`Skipped`);
    label.append(' ', skippedTag);

    showMe.addEventListener('click', () => openTarget(step.target));
    skip.addEventListener('click', () => state.setSkipped(step.id, !state.isSkipped(step.id)));

    function sync() {
        const skipped = state.isSkipped(step.id);
        skip.setAttribute('aria-pressed', String(skipped));
        skippedTag.hidden = !skipped;
        controller.row.dataset.sbStepState = skipped ? 'skipped' : 'open';
    }
    sync();
    return { row: controller.row, sync };
}

/**
 * Fills the Getting Started section: one collapsed row that opens in place and lists the steps.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} [options]
 * @param {ReturnType<typeof createGettingStartedState>} [options.state]
 * @param {(target: string) => unknown} [options.openTarget]
 */
export function mountGettingStarted(panel, { state = getSharedState(), openTarget = openShellTarget } = {}) {
    const section = panel.querySelector('[data-sb-home-region="getting-started"]');
    if (!section) {
        return;
    }

    const steps = getGettingStartedSteps().map(step => createStepRow(step, state, openTarget));
    const expander = createExpanderRow({
        label: t`Getting Started`,
        subtitle: formatProgress(state.getResolvedCount(), state.getTotal()),
        field: 'getting-started',
        children: [createIntro(), ...steps.map(step => step.row)],
    });
    const progress = expander.row.querySelector('summary .ds-row-subtitle');
    markTitleAsHeading(expander.row.querySelector('summary .ds-row-label'));

    const unsubscribe = state.subscribe(() => {
        // The panel was replaced since this view was built, so its rows are gone.
        if (!section.isConnected) {
            unsubscribe();
            return;
        }
        steps.forEach(step => step.sync());
        progress.textContent = formatProgress(state.getResolvedCount(), state.getTotal());
    });

    section.replaceChildren(createPrefGroup({ field: 'getting-started-group', rows: [expander] }).section);
}
