import { t } from '../i18n.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createRow, createPrefGroup } from '../sillybunny-editor/rows.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';

const CHOICE = 'choose';

// Building every row before the first paint holds the window back on a long list, so the first screenful is built at
// once and the rest follows in chunks, one per frame. Rows are only ever added after the last one, so the rows already
// on the screen do not move and the tab order stays the order of the list.
//
// Each append restyles and lays out every row already in the list, so the cost of a chunk grows with the size of the
// list. A small fixed chunk would therefore cost more with every chunk, so a chunk grows with the list, which keeps the
// number of insertions low. The cap bounds how long one frame can hold the page.
const FIRST_ROWS = 40;
const MIN_ROWS_PER_FRAME = 60;
const MAX_ROWS_PER_FRAME = 500;

function createThumbnail(avatar, getThumbnailUrl) {
    const image = document.createElement('img');
    image.className = 'sbAssistantPickerThumb';
    image.src = getThumbnailUrl(avatar);
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    return image;
}

function createSelectedMark() {
    const mark = document.createElement('i');
    mark.className = 'fa-solid fa-check sbAssistantPickerSelected';
    mark.setAttribute('aria-hidden', 'true');
    return mark;
}

function createStatus(icon, title) {
    const status = createStatusPage({ icon, title, compact: true });
    status.element.hidden = true;
    return status;
}

/** @param {string} query */
function normalize(query) {
    return query.trim().toLocaleLowerCase();
}

/**
 * @param {import('./assistant-cards.js').PickerEntry} entry
 * @param {number} index
 * @param {(avatar: string) => string} getThumbnailUrl
 * @param {(avatar: string) => void} activate
 */
function createPickerRow(entry, index, getThumbnailUrl, activate) {
    const row = createRow({
        label: entry.name,
        field: `assistant-picker-${index}`,
        prefix: createThumbnail(entry.avatar, getThumbnailUrl),
        suffix: entry.selected ? createSelectedMark() : undefined,
        activatable: true,
        onActivate: () => activate(entry.avatar),
    });
    row.row.dataset.sbAssistantAvatar = entry.avatar;
    if (entry.selected) {
        row.row.setAttribute('aria-current', 'true');
    }
    return row;
}

/**
 * The picker window of the third assistant slot: the characters of the library as rows, with search. A row marks the
 * current choice. Activating another row closes the window and applies the choice. A long library is built in chunks,
 * and the search covers every character, whether its row exists yet or not.
 * @param {object} options
 * @param {() => import('./assistant-cards.js').PickerEntry[]} options.getEntries Read when the window opens.
 * @param {(avatar: string) => string} options.getThumbnailUrl
 * @param {(avatar: string) => unknown} options.choose Applies the choice, once the window has closed. It must not reject.
 * @returns {Promise<{ closed: Promise<unknown> }>} `closed` settles once the window has closed and the choice, if any,
 *   was applied, which is when Home shows it.
 */
export async function openAssistantPickerWindow({ getEntries, getThumbnailUrl, choose }) {
    await ensureWindowStyles();
    let chosenAvatar = null;
    let query = '';
    let rowsBuilt = 0;
    let pendingFrame = 0;
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;

    const items = getEntries().map(entry => ({ entry, name: normalize(entry.name), row: null }));
    const group = createPrefGroup({ field: 'assistant-picker' });

    function activate(avatar) {
        // The window takes a moment to close, and a second row pressed meanwhile must not replace the first choice.
        if (chosenAvatar !== null) {
            return;
        }
        chosenAvatar = avatar;
        void dialog.close(CHOICE);
    }

    function buildRowsUpTo(end) {
        const rows = [];
        for (; rowsBuilt < Math.min(end, items.length); rowsBuilt++) {
            const item = items[rowsBuilt];
            item.row = createPickerRow(item.entry, rowsBuilt, getThumbnailUrl, activate);
            item.row.setVisible(item.name.includes(query));
            rows.push(item.row);
        }
        group.append(...rows);
    }

    function buildNextChunk() {
        pendingFrame = 0;
        buildRowsUpTo(rowsBuilt + Math.min(MAX_ROWS_PER_FRAME, Math.max(MIN_ROWS_PER_FRAME, rowsBuilt)));
        scheduleNextChunk();
    }

    function scheduleNextChunk() {
        if (rowsBuilt < items.length) {
            pendingFrame = requestAnimationFrame(buildNextChunk);
        }
    }

    const selectedIndex = items.findIndex(item => item.entry.selected);
    // The selected row gets the focus and is scrolled to the middle, so the rows down to half a screen below it are
    // built too. Rows built later all come after them, because a row inserted above the focused one would move it on
    // browsers without scroll anchoring. The first insertion therefore grows with the position of the selected row.
    buildRowsUpTo(Math.max(FIRST_ROWS, selectedIndex + 1 + FIRST_ROWS / 2));

    const emptyLibrary = createStatus('user', t`No Characters Yet`);
    emptyLibrary.element.hidden = items.length > 0;
    const noResults = createStatus('magnifying-glass', t`No results`);
    group.section.hidden = items.length === 0;

    function filter(value) {
        query = normalize(value);
        let shown = 0;
        for (const item of items) {
            const matches = item.name.includes(query);
            item.row?.setVisible(matches);
            shown += matches ? 1 : 0;
        }
        noResults.element.hidden = items.length === 0 || shown > 0;
        dialog.search.report(shown, items.length);
    }

    const selected = items[selectedIndex];
    dialog = openDialog({
        tier: 'window',
        title: t`Choose Assistant`,
        className: 'sbAssistantPickerDialog',
        search: {
            label: t`Search Characters`,
            toggleLabel: t`Search Characters`,
            placeholder: t`Search...`,
            collapsed: true,
            escapeClearsFirst: true,
            onChange: filter,
        },
        initialFocus: selected ? () => {
            selected.row.row.scrollIntoView({ block: 'center' });
            return selected.row.row;
        } : undefined,
        content: body => body.append(group.section, noResults.element, emptyLibrary.element),
    });
    scheduleNextChunk();

    const closed = dialog.closed.then(async ({ response }) => {
        cancelAnimationFrame(pendingFrame);
        if (response === CHOICE && chosenAvatar !== null && chosenAvatar !== selected?.entry.avatar) {
            await choose(chosenAvatar);
        }
    });
    return { closed };
}
