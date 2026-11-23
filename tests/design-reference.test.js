import { describe, expect, test } from '@jest/globals';
import { compareReference, compareVersions, formatMarkdown, formatReport, latestStableShellTag, latestStableTag, parseRecordedReference } from '../scripts/check-design-reference.js';

describe('reading a reference version statement', () => {
    test('takes the release and the commit, and leaves a date alone', () => {
        const text = '**Reference version:** libadwaita 1.10.0 (stylesheet checked 2026-11-12); GNOME HIG at commit `97028ea` (2026-06-20).';

        expect(parseRecordedReference(text)).toEqual({ libadwaita: '1.10.0', higCommit: '97028ea', shell: null });
    });

    test('answers with nulls when the statement names none of them', () => {
        expect(parseRecordedReference('libadwaita 1.7+; GNOME HIG pages checked 2026-10-19')).toEqual({ libadwaita: null, higCommit: null, shell: null });
    });

    test('takes the GNOME Shell release when the statement names one', () => {
        const text = '**Reference version:** libadwaita 1.10.0 (stylesheet checked 2026-11-12); GNOME HIG at commit `97028ea` (2026-06-20); GNOME Shell 51.1 (banner sources checked 2026-11-23).';

        expect(parseRecordedReference(text)).toEqual({ libadwaita: '1.10.0', higCommit: '97028ea', shell: '51.1' });
    });

    test('does not take GNOME Shell from a statement that names the Shell without a release', () => {
        const text = 'libadwaita 1.10.0; GNOME HIG at commit `97028ea`; GNOME Shell\'s banner styles at main (read 2026-11-22).';

        expect(parseRecordedReference(text).shell).toBeNull();
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

describe('the latest stable GNOME Shell tag', () => {
    // The tags that gitlab.gnome.org listed on 2026-11-23: a release is `major.point`, and each cycle has `.alpha`, `.beta` and `.rc` snapshots.
    const listed = ['50.6', '51.1', '49.10', '50.5', '51.0', '51.rc', '49.9', '51.beta', '51.alpha', '50.0', '50.rc'];

    test('is the newest point release of the newest major, and ignores the snapshots and the older cycles', () => {
        expect(latestStableShellTag(listed)).toBe('51.1');
    });

    test('orders a point release by number, not by text', () => {
        expect(latestStableShellTag(['49.9', '49.10', '49.2'])).toBe('49.10');
    });

    test('is null when no tag names a release', () => {
        expect(latestStableShellTag(['51.alpha', '51.rc', 'main'])).toBeNull();
    });
});

describe('comparing the recorded reference with the remote one', () => {
    const recorded = { libadwaita: '1.10.0', higCommit: '97028ea', shell: null };
    const same = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: null };

    test('is current when the release is the same and the commit starts with the recorded id', () => {
        expect(compareReference(recorded, same)).toEqual({ status: 'current', libadwaitaMoved: false, higMoved: false, shellMoved: false });
    });

    test('has moved when libadwaita has a newer stable release', () => {
        expect(compareReference(recorded, { ...same, libadwaita: '1.11.0' })).toMatchObject({ status: 'moved', libadwaitaMoved: true, higMoved: false });
    });

    test('has moved when the head of the HIG is another commit', () => {
        expect(compareReference(recorded, { ...same, higCommit: 'abcdef012345' })).toMatchObject({ status: 'moved', libadwaitaMoved: false, higMoved: true });
    });

    test('is unknown when either side lacks a value', () => {
        expect(compareReference({ ...recorded, libadwaita: null }, same).status).toBe('unknown');
        expect(compareReference(recorded, { libadwaita: null, higCommit: null, shell: null }).status).toBe('unknown');
    });

    describe('with a GNOME Shell release recorded', () => {
        const tracked = { ...recorded, shell: '51.0' };

        test('is current when the latest stable release is the recorded one', () => {
            expect(compareReference(tracked, { ...same, shell: '51.0' })).toEqual({ status: 'current', libadwaitaMoved: false, higMoved: false, shellMoved: false });
        });

        test('has moved when GNOME Shell has a newer stable release, a point release too', () => {
            expect(compareReference(tracked, { ...same, shell: '51.1' })).toEqual({ status: 'moved', libadwaitaMoved: false, higMoved: false, shellMoved: true });
            expect(compareReference(tracked, { ...same, shell: '52.0' })).toMatchObject({ status: 'moved', shellMoved: true });
        });

        test('has moved for each side that moved, and not for one that did not', () => {
            expect(compareReference(tracked, { libadwaita: '1.11.0', higCommit: 'abcdef012345', shell: '51.0' })).toEqual({ status: 'moved', libadwaitaMoved: true, higMoved: true, shellMoved: false });
        });

        test('does not move when the remote has an older release than the recorded one', () => {
            expect(compareReference({ ...tracked, shell: '51.1' }, { ...same, shell: '51.0' }).shellMoved).toBe(false);
        });

        test('is unknown when the remote release could not be read', () => {
            expect(compareReference(tracked, { ...same, shell: null }).status).toBe('unknown');
        });
    });

    test('does not compare GNOME Shell when nothing is recorded for it, whatever the remote says', () => {
        expect(compareReference(recorded, { ...same, shell: '99.0' })).toEqual({ status: 'current', libadwaitaMoved: false, higMoved: false, shellMoved: false });
    });
});

describe('the text report', () => {
    const recorded = { libadwaita: '1.10.0', higCommit: '97028ea', shell: '51.0' };
    const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: '51.1' };

    test('names the GNOME Shell release on both sides and says what to read when it moved', () => {
        const report = formatReport(recorded, remote, compareReference(recorded, remote));

        expect(report).toContain('GNOME Shell 51.0');
        expect(report).toContain('GNOME Shell 51.1');
        expect(report).toMatch(/GNOME Shell has a newer stable release \(51\.1\)\..*messageTray\.js.*51\.0/);
    });

    test('says that Shell is not compared when DESIGN.md records no release for it', () => {
        const untracked = { ...recorded, shell: null };
        const report = formatReport(untracked, remote, compareReference(untracked, remote));

        expect(report).toContain('records no GNOME Shell release');
        expect(report).toContain('The recorded reference is current.');
    });
});

describe('the Markdown report', () => {
    const recorded = { libadwaita: '1.10.0', higCommit: '97028ea', shell: null };

    test('links the libadwaita changes and the HIG changes that moved, and ends with the review checklist', () => {
        const remote = { libadwaita: '1.11.0', higCommit: 'abcdef0123456789', higDate: '2027-03-20', shell: null };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).toContain('| libadwaita | `1.10.0` | `1.11.0` |');
        expect(markdown).toContain('| GNOME HIG | `97028ea` | `abcdef012345` (2027-03-20) |');
        expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/libadwaita/-/blob/1.11.0/NEWS)');
        expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/libadwaita/-/compare/1.10.0...1.11.0)');
        expect(markdown).toContain('(https://gitlab.gnome.org/Teams/Design/hig-www/-/compare/97028ea...abcdef0123456789)');
        expect(markdown).toMatch(/### Review\n\n(- \[ \] .+\n?){8}$/);
    });

    test('links only the side that moved', () => {
        const remote = { libadwaita: '1.10.0', higCommit: 'abcdef0123456789', shell: null };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).not.toContain('libadwaita/-/compare');
        expect(markdown).not.toContain('gnome-shell/-/compare');
        expect(markdown).toContain('hig-www/-/compare/97028ea...abcdef0123456789');
    });

    test('says so when the reference is current, without a checklist', () => {
        const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: null };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).toMatch(/The recorded reference is current\./);
        expect(markdown).not.toContain('### Review');
    });

    test('says what is missing when the two cannot be compared', () => {
        const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: null };
        const markdown = formatMarkdown({ libadwaita: null, higCommit: null, shell: null }, remote, compareReference({ libadwaita: null, higCommit: null, shell: null }, remote));

        expect(markdown).toContain('| libadwaita | not found | `1.10.0` |');
        expect(markdown).toContain('could not be compared');
    });

    describe('with a GNOME Shell release recorded', () => {
        const tracked = { ...recorded, shell: '51.0' };

        test('has a row for GNOME Shell, and links its NEWS and its changes and names the files to read when it moved', () => {
            const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: '51.1' };
            const markdown = formatMarkdown(tracked, remote, compareReference(tracked, remote));

            expect(markdown).toContain('| GNOME Shell | `51.0` | `51.1` |');
            expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/NEWS)');
            expect(markdown).toContain('(https://gitlab.gnome.org/GNOME/gnome-shell/-/compare/51.0...51.1)');
            expect(markdown).not.toContain('libadwaita/-/compare');
            expect(markdown).toMatch(/### Review\n\n(- \[ \] .+\n?){8}$/);
            expect(markdown).toContain('js/ui/messageTray.js');
            expect(markdown).toContain('_message-list.scss');
        });

        test('says so when it is current', () => {
            const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: '51.0' };
            const markdown = formatMarkdown(tracked, remote, compareReference(tracked, remote));

            expect(markdown).toContain('| GNOME Shell | `51.0` | `51.0` |');
            expect(markdown).toMatch(/The recorded reference is current\./);
        });
    });

    test('says that Shell is not compared when DESIGN.md records no release for it', () => {
        const remote = { libadwaita: '1.10.0', higCommit: '97028eac3792aa', shell: null };
        const markdown = formatMarkdown(recorded, remote, compareReference(recorded, remote));

        expect(markdown).toContain('records no GNOME Shell release');
    });
});
