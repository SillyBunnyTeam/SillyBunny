import { t } from '../i18n.js';
import { createRow } from '../sillybunny-editor/rows.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';
import { getStepLineSlot } from './getting-started.js';
import { createStatusChip } from './status-chip.js';

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
 * The check at the start of a row whose step is done. Every row of a checklist keeps its place, so the titles line up
 * whether the step is done or not, and the stylesheet shows the check only on a done row. Success Green only tints it:
 * the Done chip states the same in words.
 */
function createDoneMark() {
    const mark = document.createElement('i');
    mark.className = 'fa-solid fa-circle-check sbHomeStepDone';
    mark.setAttribute('aria-hidden', 'true');
    return mark;
}

/**
 * The status of a step that is not open, as a chip: Done is Success Green, Skipped is neutral. The `sbHomeTag` class
 * keeps it among the notes of the row, where the Optional label and the margin between the notes are.
 * @param {'done' | 'skipped'} status
 */
function createStatusTag(status) {
    const done = status === 'done';
    const chip = createStatusChip({ label: done ? t`Done` : t`Skipped`, tone: done ? 'success' : 'neutral' });
    chip.classList.add('sbHomeTag');
    chip.dataset.sbStatus = status;
    return chip;
}

/**
 * One Getting Started step as a boxed-list row: the title, a placeholder for its text and a Show Me button.
 * The Getting Started window lists its steps through this builder. Pass it a `state` and the row also offers
 * Skip, marks an optional step and shows a skipped or a finished one. Without a state the row only points at the step.
 *
 * The notes (Optional, and Skipped or Done) have a line under the text, and the line exists only while the row has a
 * note to show: always on an optional step, and on any other step while it is skipped or done. A note that does not
 * fit is cut short and never wraps the title. On an optional step the status joins Optional on its line, so that row
 * keeps its height when it is skipped or done. Another row grows by that one line, which answers the state it follows.
 * A finished step has nothing to skip, so its Skip button goes, and it starts with a check in Success Green and carries
 * a Done chip. A skipped step carries a neutral Skipped chip. A finished step 3 shows the line of the kind of card that
 * finished it.
 * @param {object} options
 * @param {import('./getting-started.js').GettingStartedStep} options.step
 * @param {string} options.field Marks the row for tests and for the editor row styles.
 * @param {string} options.slot Copy placeholder slot of the step's text.
 * @param {string} options.labelId Id of the title, which the buttons are described by.
 * @param {(target: string) => void} options.onShowMe Receives the step's shell target.
 * @param {(topicId: string) => void} [options.onLearnMore] Receives the id of the step's Help topic. Without it the row has no Learn More.
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} [options.state]
 * @returns {{ row: HTMLElement, sync: () => void }} `sync` shows the state's current view of the step. The
 *   caller calls it when the state changes, because the row cannot know who else changes the state.
 */
export function createStepRow({ step, field, slot, labelId, onShowMe, onLearnMore, state }) {
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

    const doneMark = state ? createDoneMark() : null;
    const controller = createRow({ label: step.title, subtitle: COPY_PLACEHOLDER, field, prefix: doneMark ?? undefined, suffix: buttons });
    markRowSubtitle(controller, slot);
    controller.row.classList.add('sbHomeStepRow');
    controller.row.querySelector('.ds-row-label').id = labelId;
    // The notes and Learn More share one block under the text, so the text column adds its 2px gap once, and a note line adds only its own height.
    // Learn More is there and not beside Show Me and Skip because a third button in the suffix would squeeze the title column on a phone.
    const underText = document.createElement('div');
    controller.row.querySelector('.ds-row-text').append(underText);
    if (onLearnMore) {
        const learnMore = createFlatButton(t`Learn More`);
        learnMore.classList.add('sbHomeStepLearnMore');
        learnMore.setAttribute('aria-describedby', labelId);
        learnMore.addEventListener('click', () => onLearnMore(step.helpTopic));
        underText.append(learnMore);
    }
    if (!skip) {
        return { row: controller.row, sync: () => {} };
    }

    const notes = document.createElement('span');
    notes.className = 'sbHomeStepNotes';
    let statusTag = createStatusTag('skipped');
    statusTag.hidden = true;
    if (step.optional) {
        notes.append(createTag(t`Optional`));
    }
    notes.append(statusTag);
    underText.prepend(notes);

    function sync() {
        const skipped = state.isSkipped(step.id);
        const done = state.isDone(step.id);
        skip.setAttribute('aria-pressed', String(skipped));
        skip.hidden = done;
        const status = done ? 'done' : 'skipped';
        if (statusTag.dataset.sbStatus !== status) {
            const replacement = createStatusTag(status);
            statusTag.replaceWith(replacement);
            statusTag = replacement;
        }
        statusTag.hidden = !skipped && !done;
        notes.hidden = !step.optional && !skipped && !done;
        controller.row.dataset.sbStepState = done ? 'done' : (skipped ? 'skipped' : 'open');
        markRowSubtitle(controller, getStepLineSlot(step, state, slot));
    }
    sync();
    return { row: controller.row, sync };
}
