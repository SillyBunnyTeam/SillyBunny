/** Character and group folders, with the audit character in the first character folder. Settings only. See `index.js` for the shape of a need module. */

import { fixture as character } from './character.js';

export const fixture = Object.freeze({
    characters: Object.freeze([{ id: 'audit-folder-a', name: 'Audit Folder A' }, { id: 'audit-folder-b', name: 'Audit Folder B' }]),
    groups: Object.freeze([{ id: 'audit-group-folder', name: 'Audit Group Folder' }]),
});

export default {
    requires: ['character'],
    settings(settings) {
        const scope = list => ({ folders: list.map(folder => ({ ...folder, color: '', expanded: true })), members: {} });
        const characterScope = scope(fixture.characters);
        characterScope.members[character.avatar] = fixture.characters[0].id;
        // `migratedFromTags` keeps the app from converting legacy tag folders on boot.
        settings.power_user.sb_folders = { version: 1, migratedFromTags: true, characters: characterScope, groups: scope(fixture.groups) };
    },
};
