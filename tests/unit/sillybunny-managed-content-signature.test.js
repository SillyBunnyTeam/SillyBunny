/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createManagedContent } from '../../src/sillybunny-managed-content.js';
import { generateFixtureContent } from '../fixtures/managed-content/generate.js';

const REISEN = 'default_AssistantReisen.png';
const SPRITES = 'Assistant Reisen';
const LEXICON = 'SillyBunny Lexicon.json';

describe('the state signature of managed content', () => {
    let root;
    let bundled;
    let user;
    let signature;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-managed-signature-'));
        bundled = path.join(root, 'bundled');
        generateFixtureContent(bundled);
        user = { root: path.join(root, 'user') };
        Object.assign(user, { characters: path.join(user.root, 'characters'), worlds: path.join(user.root, 'worlds'), backups: path.join(user.root, 'backups') });
        [user.characters, user.worlds, user.backups].forEach(directory => fs.mkdirSync(directory, { recursive: true }));
        for (const name of [REISEN, 'default_AssistantTewi.png', SPRITES, 'Assistant Tewi']) {
            fs.cpSync(path.join(bundled, name), path.join(user.characters, name), { recursive: true });
        }
        fs.copyFileSync(path.join(bundled, LEXICON), path.join(user.worlds, LEXICON));
        signature = () => createManagedContent({ bundledDirectory: bundled, directories: user }).stateSignature();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** Writes new content and moves the modification time, as a later write does, so the test does not depend on the clock. */
    function rewrite(target, content) {
        const before = fs.existsSync(target) ? fs.statSync(target).mtimeMs : Date.now();
        fs.writeFileSync(target, content);
        fs.utimesSync(target, new Date(before + 5000), new Date(before + 5000));
    }

    test('is the same while nothing changed, and for a service made again', () => {
        expect(signature()).toBe(signature());
    });

    test.each([
        ['a card is rewritten', () => rewrite(path.join(user.characters, REISEN), fs.readFileSync(path.join(user.characters, REISEN)))],
        ['a card is deleted', () => fs.rmSync(path.join(user.characters, REISEN))],
        ['a sprite file is rewritten', () => rewrite(path.join(user.characters, SPRITES, 'joy.webp'), 'edited')],
        ['a sprite file is deleted', () => fs.rmSync(path.join(user.characters, SPRITES, 'joy.webp'))],
        ['a sprite folder is deleted', () => fs.rmSync(path.join(user.characters, SPRITES), { recursive: true })],
        ['a world is rewritten', () => rewrite(path.join(user.worlds, LEXICON), fs.readFileSync(path.join(user.worlds, LEXICON)))],
        ['the content log gains a line', () => rewrite(path.join(user.root, 'content.log'), REISEN)],
        ['the manifest is rewritten', () => rewrite(path.join(bundled, 'sillybunny-managed.json'), fs.readFileSync(path.join(bundled, 'sillybunny-managed.json')))],
    ])('changes when %s', (_name, change) => {
        const before = signature();

        change();

        expect(signature()).not.toBe(before);
    });

    test('does not change for files that are not managed', () => {
        const before = signature();

        fs.writeFileSync(path.join(user.characters, 'Seraphina.png'), 'another card');
        fs.writeFileSync(path.join(user.worlds, 'Other.json'), '{}');
        fs.writeFileSync(path.join(user.characters, SPRITES, 'extra.webp'), 'a sprite nobody manages');

        expect(signature()).toBe(before);
    });

    test('does not fail, and does not warn, for a broken manifest', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const before = signature();

        rewrite(path.join(bundled, 'sillybunny-managed.json'), '{ not json');

        expect(signature()).not.toBe(before);
        expect(warn).not.toHaveBeenCalled();
    });

    test('reads the manifest and no file of the user', () => {
        const read = jest.spyOn(fs, 'readFileSync');

        signature();

        const readInRoot = read.mock.calls.map(([target]) => String(target)).filter(target => target.startsWith(root));
        expect(readInRoot).toEqual([path.join(bundled, 'sillybunny-managed.json')]);
    });

    test('changes when a file is replaced by an atomic write that keeps its size and its modification time', () => {
        const target = path.join(user.characters, REISEN);
        const { size, mtime, atime } = fs.statSync(target);
        const before = signature();

        const replacement = path.join(user.characters, 'replacement.tmp');
        fs.writeFileSync(replacement, Buffer.alloc(size, 7));
        fs.utimesSync(replacement, atime, mtime);
        fs.renameSync(replacement, target);

        expect(fs.statSync(target).size).toBe(size);
        expect(fs.statSync(target).mtimeMs).toBe(mtime.getTime());
        expect(signature()).not.toBe(before);
    });

    test('changes when a file changes its size and its modification time is put back', () => {
        const target = path.join(user.characters, REISEN);
        const { mtime, atime } = fs.statSync(target);
        const before = signature();

        fs.appendFileSync(target, 'more');
        fs.utimesSync(target, atime, mtime);

        expect(signature()).not.toBe(before);
    });

    describe('for each thing it reads of a file', () => {
        const target = () => path.join(user.characters, REISEN);
        const reported = { size: 100, mtimeMs: 200, ctimeMs: 300, ino: 400 };

        /** Reports the given facts for the card of the user and the real ones for everything else. */
        function reportCard(facts) {
            const real = fs.lstatSync.bind(fs);
            jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...rest) => (file === target()
                ? { isFile: () => true, isDirectory: () => false, ...facts }
                : real(file, ...rest)));
        }

        test.each(['size', 'mtimeMs', 'ctimeMs', 'ino'])('changes when only the %s changes', (fact) => {
            reportCard(reported);
            const before = signature();

            jest.restoreAllMocks();
            reportCard({ ...reported, [fact]: reported[fact] + 1 });

            expect(signature()).not.toBe(before);
        });

        test('is the same when all of them are the same', () => {
            reportCard(reported);
            const before = signature();

            jest.restoreAllMocks();
            reportCard({ ...reported });

            expect(signature()).toBe(before);
        });

        test('tells a failure to read a file from its absence', () => {
            const absent = signature();
            const real = fs.lstatSync.bind(fs);
            jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...rest) => {
                if (file === target()) {
                    throw Object.assign(new Error('denied'), { code: 'EACCES' });
                }
                return real(file, ...rest);
            });
            const denied = signature();

            jest.restoreAllMocks();
            fs.rmSync(target());
            const missing = signature();

            expect(denied).not.toBe(missing);
            expect(denied).toContain('error:EACCES');
            expect(absent).not.toBe(missing);
        });
    });
});
