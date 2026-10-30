import { t } from '../i18n.js';
import { createRow } from '../sillybunny-editor/rows.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';

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

/**
 * One Getting Started step as a boxed-list row: the title, a placeholder for its text and a Show Me button.
 * The Getting Started window and the Welcome dialog list the same steps through this builder, so a step reads
 * the same in both. Only the window tracks progress: pass it a `state` and the row also offers Skip, marks an
 * optional step and shows a skipped one. The Welcome dialog only points at the steps.
 *
 * The notes (Optional, Skipped) have a line under the text, and the line exists only while the row has a note
 * to show: always on an optional step, and on any other step while it is skipped. A note that does not fit is cut
 * short and never wraps the title. On an optional step Skipped joins Optional on its line, so that row keeps its
 * height when it is skipped. Another row grows by that one line while it is skipped, which answers its own toggle.
 * @param {object} options
 * @param {import('./getting-started.js').GettingStartedStep} options.step
 * @param {string} options.field Marks the row for tests and for the editor row styles.
 * @param {string} options.slot Copy placeholder slot of the step's text.
 * @param {string} options.labelId Id of the title, which the buttons are described by.
 * @param {(target: string) => void} options.onShowMe Receives the step's shell target.
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} [options.state]
 * @returns {{ row: HTMLElement, sync: () => void }} `sync` shows the state's current view of the step. The
 *   caller calls it when the state changes, because the row cannot know who else changes the state.
 */
export function createStepRow({ step, field, slot, labelId, onShowMe, state }) {
    const showMe = createFlatButton(t`Show Me`);
    showMe.setAttribute('aria-describedby', labelId);
    showMe.addEventListener('click', () => onShowMe(step.target));
    const buttons = [showMe];

    const skip = state ? createFlatButton(t`Skip`) : null;
    if (skip) {
        skip.setAttribute('aria-pressed', 'false');
        skip.setAttribute('aria-describedby', labelId);
        skip.addEventListener('click', () => state.setSkipped(step.id, !state.isSkipped(step.id)));
        buttons.push(skip);
    }

    const controller = createRow({ label: step.title, subtitle: COPY_PLACEHOLDER, field, suffix: buttons });
    markRowSubtitle(controller, slot);
    controller.row.classList.add('sbHomeStepRow');
    controller.row.querySelector('.ds-row-label').id = labelId;
    if (!skip) {
        return { row: controller.row, sync: () => {} };
    }

    const notes = document.createElement('span');
    notes.className = 'sbHomeStepNotes';
    const skippedTag = createTag(t`Skipped`);
    if (step.optional) {
        notes.append(createTag(t`Optional`));
    }
    notes.append(skippedTag);
    controller.row.querySelector('.ds-row-text').append(notes);

    function sync() {
        const skipped = state.isSkipped(step.id);
        skip.setAttribute('aria-pressed', String(skipped));
        skippedTag.hidden = !skipped;
        notes.hidden = !step.optional && !skipped;
        controller.row.dataset.sbStepState = skipped ? 'skipped' : 'open';
    }
    sync();
    return { row: controller.row, sync };
}
