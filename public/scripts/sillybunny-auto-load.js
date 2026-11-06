/*
 * Records the chat a SillyBunny surface opened as the Auto-load Last Chat entity.
 * Upstream records it in the delegated .character_select / .group_select click handlers in
 * RossAscends-mods.js, which the shared lists, object navigation and search never reach.
 */

import { saveSettingsDebounced, setActiveCharacter, setActiveGroup } from '../script.js';

/**
 * @param {'character'|'group'} kind
 * @param {string} key Character avatar or group id. Characters go by avatar because upstream
 * reads a falsy key as no entity, which would drop the character at index 0.
 */
export function rememberOpenedEntity(kind, key) {
    if (kind === 'group') {
        setActiveCharacter(null);
        setActiveGroup(key);
    } else {
        setActiveCharacter(key);
        setActiveGroup(null);
    }
    saveSettingsDebounced();
}
