import { createEntityRow } from './entity-row.js';
import { t } from '../i18n.js';
import { MOTION_SLOW, play, prefersReducedMotion } from '../sillybunny-motion.js';

/** Member count for a folder in the Characters, Groups, Personas or Backgrounds scope. */
export function folderCountLabel(count, scope) {
    if (scope === 'groups') return count === 1 ? t`1 group` : t`${count} groups`;
    if (scope === 'personas') return count === 1 ? t`1 persona` : t`${count} personas`;
    if (scope === 'backgrounds') return count === 1 ? t`1 background` : t`${count} backgrounds`;
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

/**
 * Opens or closes a folder whose members are the content of one element (a section body holding a grid), over the same
 * duration, easing, fade and height change as the member rows of a list. The caller has set `hidden` and the stored
 * state; `onEnd` runs when a close has finished or been cancelled, so the caller can hide the body and drop its content.
 * A click in the middle of a motion continues from the height and opacity on screen instead of from the end state.
 * @param {HTMLElement} body
 * @param {boolean} expanding
 * @param {{ onEnd?: (() => void) | null }} [options]
 */
export function animateFolderBody(body, expanding, { onEnd = null } = {}) {
    if (prefersReducedMotion() || !body.isConnected) {
        onEnd?.();
        return null;
    }
    let from = null;
    const running = typeof body.getAnimations === 'function' ? body.getAnimations() : [];
    if (running.length) {
        const style = getComputedStyle(body);
        from = {
            height: `${body.getBoundingClientRect().height}px`,
            paddingBlockStart: style.paddingBlockStart,
            paddingBlockEnd: style.paddingBlockEnd,
            borderBlockStartWidth: style.borderBlockStartWidth,
            borderBlockEndWidth: style.borderBlockEndWidth,
            opacity: Number(style.opacity),
        };
        // The settled height is measured below, so the running motion has to be gone first.
        for (const animation of running) animation.cancel();
    }
    const natural = body.getBoundingClientRect().height;
    // A body that has padding and a border cannot shrink below them with `height` alone, so they are animated too.
    const shut = { height: '0px', paddingBlockStart: '0px', paddingBlockEnd: '0px', borderBlockStartWidth: '0px', borderBlockEndWidth: '0px', opacity: 0 };
    const open = { height: `${natural}px`, opacity: 1 };
    return play(body, [from ?? (expanding ? shut : open), expanding ? open : shut], {
        fill: expanding ? 'none' : 'forwards',
        inert: !expanding,
        styles: { 'box-sizing': 'border-box', overflow: 'hidden' },
        onEnd,
    });
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
    // The button's name comes from its text: the title, then the count. An aria-label with a comma between them would not contain the visible text (WCAG 2.5.3).
    row.removeAttribute('aria-label');
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
            // The entity row sets its label on every rename; the name stays the content's.
            row.removeAttribute('aria-label');
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
