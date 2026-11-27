/**
 * A user folder for the conversation migration tests: `settings.json`, the character cards, the roleplay group files
 * and the images that the migration reads, laid out under the `directories` of a real user handle.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CHARACTER_FILES } from './conversation-legacy-fixture.js';

export const GROUP_AVATAR_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

/**
 * @param {Record<string, string>} directories `getUserDirectories(handle)`
 * @param {object} [options]
 * @param {object} [options.settings] Written as `settings.json`. None writes no file.
 * @param {string[]} [options.characters] Card files to create in `characters/`.
 * @param {string[]} [options.userAvatars] Files to create in `User Avatars/`.
 * @param {Record<string, object>} [options.groups] Roleplay groups, by id, written to `groups/<id>.json`.
 * @param {Record<string, Buffer>} [options.userImages] Files to create in `user/images/`.
 * @returns {{ user: { profile: { handle: string }, directories: Record<string, string> }, settingsPath: string }}
 */
export function populateUser(handle, directories, { settings, characters = CHARACTER_FILES, userAvatars = [], groups = {}, userImages = {} } = {}) {
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    const settingsPath = path.join(directories.root, 'settings.json');
    if (settings) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    }
    for (const name of characters) {
        fs.writeFileSync(path.join(directories.characters, name), 'PNG');
    }
    for (const name of userAvatars) {
        fs.writeFileSync(path.join(directories.avatars, name), 'PNG');
    }
    for (const [id, group] of Object.entries(groups)) {
        fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    }
    for (const [name, data] of Object.entries(userImages)) {
        fs.writeFileSync(path.join(directories.userImages, name), data);
    }
    return { user: { profile: { handle }, directories }, settingsPath };
}

export const ROLEPLAY_GROUP_FILE = { id: 'rp-group-1', name: 'Roleplay Group One', members: ['Nova.png', 'Orion.png'], disabled_members: [] };
