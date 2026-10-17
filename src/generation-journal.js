/**
 * SillyBunny: a small on-disk list of the server-owned generations that are still in flight, so the
 * page can be told which replies a server restart lost. Only bookkeeping is stored, never reply
 * text: a reply cut off by a restart is reported lost and regenerated whole, not kept half-written.
 *
 * Each user's journal is read the first time this process touches it. Everything already in it at
 * that point was in flight when the previous process stopped, so it is marked lost.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getCommitChatKey } from '../public/scripts/generation-commit-plan.js';

const JOURNAL_FILE = 'generation-journal.json';
/** Lost replies nobody came back for are forgotten, oldest first, past this many. */
const MAX_LOST_ENTRIES = 50;

/**
 * @typedef {object} JournalEntry
 * @property {string} id Generation id
 * @property {string} chatKey Chat the reply was for
 * @property {'append'|'swipe'|'continue'} kind How the reply would have landed
 * @property {number} index Message index the reply would have been written to
 * @property {string|null} anchor append: identity of the message before `index`
 * @property {string|null} target swipe/continue: identity of the message at `index`
 * @property {string} started Generation start; also marks the page's in-progress message
 * @property {string} page Page load that started it
 * @property {string|null} member Group chats: avatar of the member who was speaking
 * @property {string[]} round Group chats: members still to speak after this one
 * @property {boolean} lost The server stopped before the reply was finished or saved
 */

/** @type {Map<string, Map<string, JournalEntry>>} Entries by journal file */
const journals = new Map();

/**
 * @param {string} file Journal file
 * @param {Map<string, JournalEntry>} entries Entries to write
 */
function saveJournal(file, entries) {
    try {
        if (entries.size === 0) {
            fs.rmSync(file, { force: true });
        } else {
            writeFileAtomicSync(file, JSON.stringify([...entries.values()]), 'utf8');
        }
    } catch (error) {
        console.warn('Could not save the generation journal:', error);
    }
}

/**
 * @param {Map<string, JournalEntry>} entries Journal entries
 */
function trimLostEntries(entries) {
    const lost = [...entries.values()].filter(entry => entry.lost);
    for (const entry of lost.slice(0, Math.max(0, lost.length - MAX_LOST_ENTRIES))) {
        entries.delete(entry.id);
    }
}

/**
 * @param {unknown} entry Candidate entry read from disk
 * @returns {entry is JournalEntry}
 */
function isJournalEntry(entry) {
    return Boolean(entry) && typeof entry === 'object'
        && typeof (/** @type {any} */ (entry).id) === 'string'
        && typeof (/** @type {any} */ (entry).chatKey) === 'string';
}

/**
 * @param {{ directories?: { root?: string } }} user Owner
 * @returns {{ file: string, entries: Map<string, JournalEntry> }|null}
 */
function getJournal(user) {
    const root = user?.directories?.root;
    if (!root) {
        return null;
    }
    const file = path.join(root, JOURNAL_FILE);
    const cached = journals.get(file);
    if (cached) {
        return { file, entries: cached };
    }

    /** @type {Map<string, JournalEntry>} */
    const entries = new Map();
    let changed = false;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of Array.isArray(saved) ? saved : []) {
            if (isJournalEntry(entry)) {
                changed ||= !entry.lost;
                entries.set(entry.id, { ...entry, round: Array.isArray(entry.round) ? entry.round : [], lost: true });
            }
        }
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
            console.warn('Could not read the generation journal:', error);
        }
    }
    const before = entries.size;
    trimLostEntries(entries);
    journals.set(file, entries);
    if (changed || entries.size !== before) {
        saveJournal(file, entries);
    }
    return { file, entries };
}

/**
 * Notes a server-owned generation as in flight.
 * @param {{ directories?: { root?: string } }} user Owner
 * @param {string} id Generation id
 * @param {import('../public/scripts/generation-commit-plan.js').GenerationCommitPlan} plan Where its reply goes
 */
export function recordGeneration(user, id, plan) {
    const journal = getJournal(user);
    if (!journal) {
        return;
    }
    journal.entries.set(id, {
        id,
        chatKey: getCommitChatKey(plan.chat, plan.file),
        kind: plan.kind,
        index: plan.index,
        anchor: plan.anchor,
        target: plan.target,
        started: plan.started,
        page: plan.page,
        member: plan.message.original_avatar,
        round: plan.round,
        lost: false,
    });
    saveJournal(journal.file, journal.entries);
}

/**
 * Drops a generation whose reply can no longer be lost: saved, refused, failed or cancelled.
 * @param {{ directories?: { root?: string } }} user Owner
 * @param {string} id Generation id
 */
export function forgetGeneration(user, id) {
    const journal = getJournal(user);
    if (journal?.entries.delete(id)) {
        saveJournal(journal.file, journal.entries);
    }
}

/**
 * @param {{ directories?: { root?: string } }} user Owner
 * @param {string} chatKey Chat
 * @returns {JournalEntry[]} Replies for this chat that a server restart lost
 */
export function getLostGenerations(user, chatKey) {
    const journal = getJournal(user);
    return journal ? [...journal.entries.values()].filter(entry => entry.lost && entry.chatKey === chatKey) : [];
}

/**
 * Forgets lost replies the page has told the user about.
 * @param {{ directories?: { root?: string } }} user Owner
 * @param {string[]} ids Generation ids
 * @returns {boolean} Whether anything was forgotten
 */
export function acknowledgeLostGenerations(user, ids) {
    const journal = getJournal(user);
    if (!journal) {
        return false;
    }
    let changed = false;
    for (const id of ids) {
        if (journal.entries.get(id)?.lost) {
            journal.entries.delete(id);
            changed = true;
        }
    }
    if (changed) {
        saveJournal(journal.file, journal.entries);
    }
    return changed;
}

export const testExports = {
    JOURNAL_FILE,
    MAX_LOST_ENTRIES,
    /** Simulates a server restart: the next touch reads every journal from disk again. */
    forgetLoadedJournals() {
        journals.clear();
    },
};
