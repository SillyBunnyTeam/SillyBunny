import { describe, test, expect } from '@jest/globals';
import { buildBackgroundSections } from '../../public/scripts/sillybunny-background-sections.js';
import { mergeBackgroundFolders } from '../../public/scripts/sillybunny-folders.js';

const images = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map(filename => ({ filename }));
const folder = (id, expanded = true) => ({ id, name: id.toUpperCase(), color: '', expanded });
const sortFiles = files => [...files].sort();

function build(options) {
    return buildBackgroundSections({ images, sortFiles, ...options });
}

describe('background sections', () => {
    test('with no folders every background is unfiled and no heading shows', () => {
        const model = build({ folders: [], getMembers: () => [] });
        expect(model.sections).toEqual([]);
        expect(model.unfiled).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
        expect(model.showUnfiledHeading).toBe(false);
    });

    test('the unfiled backgrounds get a heading when at least one folder exists, and none when all are filed', () => {
        const members = { x: ['a.png', 'b.png'] };
        const model = build({ folders: [folder('x')], getMembers: id => members[id] ?? [] });
        expect(model.unfiled).toEqual(['c.png', 'd.png', 'e.png']);
        expect(model.showUnfiledHeading).toBe(true);
        const all = build({ folders: [folder('x')], getMembers: () => images.map(image => image.filename) });
        expect(all.unfiled).toEqual([]);
        expect(all.showUnfiledHeading).toBe(false);
    });

    test('a folder follows its stored expanded state and counts its existing members only', () => {
        const members = { x: ['a.png', 'gone.png'], y: ['b.png'] };
        const model = build({ folders: [folder('x'), folder('y', false)], getMembers: id => members[id] ?? [] });
        expect(model.sections.map(section => [section.folder.id, section.total, section.expanded, section.files])).toEqual([
            ['x', 1, true, ['a.png']],
            ['y', 1, false, ['b.png']],
        ]);
    });

    test('an empty folder is a section with a count of zero', () => {
        const model = build({ folders: [folder('x', false)], getMembers: () => [] });
        expect(model.sections).toHaveLength(1);
        expect(model.sections[0]).toMatchObject({ total: 0, files: [], expanded: false });
    });

    test('a file that upstream data placed in two folders shows in both and is not unfiled', () => {
        const members = { x: ['a.png'], y: ['a.png', 'b.png'] };
        const model = build({ folders: [folder('x'), folder('y')], getMembers: id => members[id] ?? [] });
        expect(model.sections.map(section => section.files)).toEqual([['a.png'], ['a.png', 'b.png']]);
        expect(model.unfiled).not.toContain('a.png');
    });

    test('a search opens the folders that hold a match, drops the ones that do not, and leaves the stored state alone', () => {
        const stored = [folder('x', false), folder('y', false), folder('z', true)];
        const members = { x: ['a.png', 'b.png'], y: ['c.png'], z: ['d.png'] };
        const model = build({ folders: stored, getMembers: id => members[id] ?? [], query: ' B.' });
        expect(model.sections.map(section => [section.folder.id, section.files, section.expanded, section.temporary])).toEqual([
            ['x', ['b.png'], true, true],
        ]);
        expect(model.unfiled).toEqual([]);
        expect(stored.map(entry => entry.expanded)).toEqual([false, false, true]);
        expect(model.hasMatches).toBe(true);
    });

    test('a search keeps an open folder open without marking it temporary, and reports no match', () => {
        const members = { z: ['d.png'] };
        const open = build({ folders: [folder('z')], getMembers: id => members[id] ?? [], query: 'd' });
        expect(open.sections[0]).toMatchObject({ expanded: true, temporary: false, total: 1 });
        const none = build({ folders: [folder('z')], getMembers: id => members[id] ?? [], query: 'zzz' });
        expect(none.hasMatches).toBe(false);
        expect(none.sections).toEqual([]);
    });
});

describe('merged folder list', () => {
    const indexed = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];

    test('the index decides the names, the scope decides order, colour and expansion', () => {
        const merged = mergeBackgroundFolders([{ id: 'c', color: 'red', expanded: false }, { id: 'a' }], indexed);
        expect(merged).toEqual([
            { id: 'c', name: 'Gamma', color: 'red', expanded: false },
            { id: 'a', name: 'Alpha', color: '', expanded: true },
            { id: 'b', name: 'Beta', color: '', expanded: true },
        ]);
    });

    test('a scope record whose folder the index lost is ignored and a repeated record counts once', () => {
        const merged = mergeBackgroundFolders([{ id: 'gone', color: 'red' }, { id: 'a' }, { id: 'a', color: 'blue' }], indexed);
        expect(merged.map(folderEntry => folderEntry.id)).toEqual(['a', 'b', 'c']);
        expect(merged[0].color).toBe('');
    });
});
