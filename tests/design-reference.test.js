import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReference, compareVersions, latestStableTag, parseRecordedReference, readReferenceLine } from '../scripts/check-design-reference.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the reference that the design documents record', () => {
    test('DESIGN.md names a libadwaita release and a commit of the HIG', () => {
        const recorded = parseRecordedReference(readReferenceLine(repoRoot));

        expect(recorded.libadwaita).toMatch(/^\d+\.\d+\.\d+$/);
        expect(recorded.higCommit).toMatch(/^[0-9a-f]{7,40}$/);
    });

    test('DESIGN.json records the same reference as DESIGN.md', () => {
        const json = JSON.parse(fs.readFileSync(path.join(repoRoot, 'DESIGN.json'), 'utf8'));

        expect(parseRecordedReference(json.narrative.referenceVersion)).toEqual(parseRecordedReference(readReferenceLine(repoRoot)));
    });
});

describe('reading a reference version statement', () => {
    test('takes the release and the commit, and leaves a date alone', () => {
        const text = '**Reference version:** libadwaita 1.10.0 (stylesheet checked 2026-11-12); GNOME HIG at commit `97028ea` (2026-06-20).';

        expect(parseRecordedReference(text)).toEqual({ libadwaita: '1.10.0', higCommit: '97028ea' });
    });

    test('answers with nulls when the statement names neither', () => {
        expect(parseRecordedReference('libadwaita 1.7+; GNOME HIG pages checked 2026-10-19')).toEqual({ libadwaita: null, higCommit: null });
    });
});

describe('the latest stable libadwaita tag', () => {
    test('ignores development snapshots and orders by number, not by text', () => {
        expect(latestStableTag(['1.11.alpha', '1.9.4', '1.10.0', '1.10.beta.1', '1.8.8', '1.11.rc'])).toBe('1.10.0');
        expect(compareVersions('1.10.0', '1.9.4')).toBeGreaterThan(0);
    });

    test('is null when no tag names a stable release', () => {
        expect(latestStableTag(['1.11.alpha', 'main'])).toBeNull();
    });
});

describe('comparing the recorded reference with the remote one', () => {
    const recorded = { libadwaita: '1.10.0', higCommit: '97028ea' };

    test('is current when the release is the same and the commit starts with the recorded id', () => {
        expect(compareReference(recorded, { libadwaita: '1.10.0', higCommit: '97028eac3792aa' })).toEqual({ status: 'current', libadwaitaMoved: false, higMoved: false });
    });

    test('has moved when libadwaita has a newer stable release', () => {
        expect(compareReference(recorded, { libadwaita: '1.11.0', higCommit: '97028eac3792aa' })).toMatchObject({ status: 'moved', libadwaitaMoved: true, higMoved: false });
    });

    test('has moved when the head of the HIG is another commit', () => {
        expect(compareReference(recorded, { libadwaita: '1.10.0', higCommit: 'abcdef012345' })).toMatchObject({ status: 'moved', libadwaitaMoved: false, higMoved: true });
    });

    test('is unknown when either side lacks a value', () => {
        expect(compareReference({ libadwaita: null, higCommit: '97028ea' }, { libadwaita: '1.10.0', higCommit: '97028ea' }).status).toBe('unknown');
        expect(compareReference(recorded, { libadwaita: null, higCommit: null }).status).toBe('unknown');
    });
});
