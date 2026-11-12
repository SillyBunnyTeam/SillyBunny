import { describe, expect, test } from '@jest/globals';
import { compareReference, compareVersions, formatMarkdown, latestStableTag, parseRecordedReference } from '../scripts/check-design-reference.js';

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

describe('the Markdown report', () => {
    const recorded = { libadwaita: '1.10.0', higCommit: '97028ea' };

    test('links the libadwaita changes and the HIG changes that moved, and ends with the review checklist', () => {
        const remote = { libadwaita: '1.11.0', higCommit: 'abcdef0123456789', higDate: '2027-03-20' };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).toContain('| libadwaita | `1.10.0` | `1.11.0` |');
        expect(markdown).toContain('| GNOME HIG | `97028ea` | `abcdef012345` (2027-03-20) |');
        expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/libadwaita/-/blob/1.11.0/NEWS)');
        expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/libadwaita/-/compare/1.10.0...1.11.0)');
        expect(markdown).toContain('(https://gitlab.gnome.org/Teams/Design/hig-www/-/compare/97028ea...abcdef0123456789)');
        expect(markdown).toMatch(/### Review\n\n(- \[ \] .+\n?){8}$/);
    });

    test('links only the side that moved', () => {
        const remote = { libadwaita: '1.10.0', higCommit: 'abcdef0123456789' };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).not.toContain('libadwaita/-/compare');
        expect(markdown).toContain('hig-www/-/compare/97028ea...abcdef0123456789');
    });

    test('says so when the reference is current, without a checklist', () => {
        const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa' };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).toMatch(/The recorded reference is current\.$/);
        expect(markdown).not.toContain('### Review');
    });

    test('says what is missing when the two cannot be compared', () => {
        const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa' };
        const markdown = formatMarkdown({ libadwaita: null, higCommit: null }, remote, compareReference({ libadwaita: null, higCommit: null }, remote));

        expect(markdown).toContain('| libadwaita | not found | `1.10.0` |');
        expect(markdown).toContain('could not be compared');
    });
});
