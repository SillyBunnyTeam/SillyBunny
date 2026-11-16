import { createEntityRow } from './entity-row.js';
import { t } from '../i18n.js';
import { MOTION_SLOW, play, prefersReducedMotion } from '../sillybunny-motion.js';

/** Member count for a folder in the Characters, Groups or Personas scope. */
export function folderCountLabel(count, scope) {
    if (scope === 'groups') return count === 1 ? t`1 group` : t`${count} groups`;
    if (scope === 'personas') return count === 1 ? t`1 persona` : t`${count} personas`;
    return count === 1 ? t`1 character` : t`${count} characters`;
}

// A folder past this many rows opens and closes without the motion, so a long member list never animates dozens of rows at once.
const MEMBER_MOTION_LIMIT = 60;
// A reveal that waits longer than this for its render belongs to an earlier click.
const REVEAL_WINDOW_MS = 1500;

function setExpanded(row, expanded) {
    row.setAttribute('aria-expanded', String(Boolean(expanded)));
    const chevron = row.querySelector('.ds-entity-row__chevron');
    if (!chevron) return;
    // The chevron keeps one glyph and turns with aria-expanded in CSS, so it can animate.
    chevron.classList.remove('fa-chevron-right', 'fa-chevron-up');
    chevron.classList.add('fa-chevron-down');
}

/** The rows that follow a folder header and belong to it, in display order. */
function folderMembers(header) {
    const members = [];
    for (let row = header.nextElementSibling; row?.classList.contains('is-folder-member') && !row.classList.contains('is-folder-section-start'); row = row.nextElementSibling) {
        members.push(row);
    }
    return members;
}

/** Grows the rows in from nothing, or shrinks them out; `done` runs once the last one has finished. */
function animateMembers(rows, expanding, done) {
    let remaining = rows.length;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        done?.();
    };
    const settle = () => {
        remaining -= 1;
        if (remaining === 0) finish();
    };
    // A page that is not rendering (a background tab) never finishes its animations; the state change must not wait for them.
    if (done) setTimeout(finish, MOTION_SLOW + 150);
    for (const row of rows) {
        const height = row.getBoundingClientRect().height;
        const shut = { height: '0px', minHeight: '0px', paddingBlock: '0px', marginBlock: '0px', borderBlockWidth: '0px', opacity: 0 };
        const open = { height: `${height}px`, opacity: 1 };
        play(row, expanding ? [shut, open] : [open, shut], {
            fill: expanding ? 'none' : 'forwards',
            inert: !expanding,
            styles: { 'box-sizing': 'border-box', overflow: 'hidden', 'pointer-events': 'none' },
            onEnd: settle,
        });
    }
}

/**
 * Motion for the open and close of folders in a list. The members are separate rows next to the header, so
 * closing animates them out before the stored state changes, and opening animates the rows the next render adds.
 * One controller serves one list.
 */
export function createFolderMotion() {
    let pending = null;
    let busy = false;
    return {
        /** True from the click that opens a folder until the render that shows its members. */
        get pending() {
            return pending !== null && performance.now() < pending.until;
        },
        /**
         * Runs `commit`, which stores the new state and renders, around the member motion.
         * @param {HTMLElement} header The folder's header row.
         * @param {boolean} expanded Whether the folder is open now.
         * @param {() => void} commit
         */
        toggle(header, expanded, commit) {
            if (busy) return;
            const members = expanded ? folderMembers(header) : [];
            if (prefersReducedMotion() || (expanded && (!members.length || members.length > MEMBER_MOTION_LIMIT))) {
                commit();
                return;
            }
            if (!expanded) {
                pending = { folderId: header.dataset.folderId, until: performance.now() + REVEAL_WINDOW_MS };
                commit();
                return;
            }
            busy = true;
            setExpanded(header, false);
            animateMembers(members, false, () => {
                busy = false;
                commit();
            });
        },
        /** Call after a render has added the rows: plays the reveal that an opening click asked for. */
        reveal(container) {
            if (!pending) return;
            const { folderId, until } = pending;
            pending = null;
            if (performance.now() > until || prefersReducedMotion()) return;
            const header = [...container.children].find(row => row.classList.contains('sb-folder-row') && row.dataset.folderId === folderId);
            const members = header ? folderMembers(header) : [];
            if (members.length && members.length <= MEMBER_MOTION_LIMIT) animateMembers(members, true);
        },
    };
}

function setColor(dot, color) {
    if (color) dot.style.setProperty('--sb-folder-color', color);
    else dot.style.removeProperty('--sb-folder-color');
}

/** Builds an accessible, keyed folder section header for the main entity list. */
export function createFolderRow({ key, folder, count, countLabel, expanded }) {
    const dot = document.createElement('span');
    dot.className = 'sb-folder-row__dot';
    dot.setAttribute('aria-hidden', 'true');
    setColor(dot, folder.color);

    const rowFactory = createEntityRow({
        key,
        label: `${folder.name}, ${countLabel}`,
        title: folder.name,
        subtitle: countLabel,
        avatar: dot,
        activation: 'navigate',
    });
    const { row } = rowFactory;
    row.classList.add('ds-row-expander', 'sb-folder-row');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${folder.name}, ${countLabel}`);
    row.dataset.folderId = folder.id;
    row.dataset.folderScope = folder.scope;
    setExpanded(row, expanded);

    return {
        row,
        update(entry) {
            rowFactory.update({
                label: `${entry.folder.name}, ${entry.countLabel}`,
                title: entry.folder.name,
                subtitle: entry.countLabel,
            });
            row.setAttribute('aria-label', `${entry.folder.name}, ${entry.countLabel}`);
            row.dataset.folderId = entry.folder.id;
            row.dataset.folderScope = entry.scope;
            setColor(dot, entry.folder.color);
            setExpanded(row, entry.expanded);
            row.classList.toggle('is-folder-temporarily-expanded', Boolean(entry.temporaryExpansion));
            row.inert = Boolean(entry.inert);
            if (entry.inert) row.setAttribute('aria-disabled', 'true');
            else row.removeAttribute('aria-disabled');
            row.tabIndex = entry.inert ? -1 : 0;
        },
    };
}
