import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

const journalModule = fileURLToPath(new URL('../src/generation-journal.js', import.meta.url));

let root;
let journalFile;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-journal-exit-'));
    journalFile = path.join(root, 'generation-journal.json');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the journal in a child process that exits on its own, the way a restart does.
 * @param {string} steps Code that runs after the journal module is loaded; `journal`, `user` and `plan` are in scope
 */
function runUntilExit(steps) {
    const code = `
        const journal = await import(${JSON.stringify(journalModule)});
        const user = { directories: { root: ${JSON.stringify(root)} } };
        const plan = { chat: 'chat', file: 'file', kind: 'append', index: 3, anchor: null, target: null, started: 'started', page: 'page', message: { original_avatar: 'bunny.png' }, round: [] };
        const microtaskTicks = async count => { for (let i = 0; i < count; i++) await Promise.resolve(); };
        ${steps}
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
}

const readEntries = () => JSON.parse(fs.readFileSync(journalFile, 'utf8'));

describe('generation journal at process exit', () => {
    test('a generation recorded in the same tick as the exit is on disk', () => {
        runUntilExit(`
            journal.recordGeneration(user, 'g-1', plan);
            process.exit(0);
        `);

        expect(readEntries().map(entry => entry.id)).toEqual(['g-1']);
    });

    test('a generation whose write is still in flight at the exit is on disk', () => {
        runUntilExit(`
            journal.recordGeneration(user, 'g-1', plan);
            await microtaskTicks(3);
            process.exit(0);
        `);

        expect(readEntries().map(entry => entry.id)).toEqual(['g-1']);
    });

    test('a forgotten generation is gone from disk when its removal is still in flight at the exit', () => {
        fs.writeFileSync(journalFile, JSON.stringify([{ id: 'g-1', chatKey: 'chat', kind: 'append', index: 3, round: [], lost: false }]));

        runUntilExit(`
            journal.recordGeneration(user, 'g-2', plan);
            await journal.testExports.flushJournal();
            journal.forgetGeneration(user, 'g-2');
            await microtaskTicks(3);
            process.exit(0);
        `);

        expect(readEntries().map(entry => entry.id)).toEqual(['g-1']);
    });
});
