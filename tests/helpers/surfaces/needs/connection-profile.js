/**
 * One saved connection profile. The Connection Manager keeps its profiles in the account settings
 * (`extension_settings.connectionManager`), which is the only place the app stores them, so this need is settings only.
 * The profile is saved but not selected, so a boot does not apply it. See `index.js` for the shape of a need module.
 */

import { enableExtensions, extensionSettings, mergeById } from '../need-kit.js';

export const fixture = Object.freeze({ id: 'audit-profile', name: 'Audit Profile', model: 'gpt-4o' });

export default {
    settings(settings) {
        enableExtensions(settings, ['connection-manager']);
        const extensions = extensionSettings(settings);
        const current = extensions.connectionManager ?? {};
        extensions.connectionManager = {
            selectedProfile: null,
            folders: [],
            ...current,
            profiles: mergeById(current.profiles, [{
                id: fixture.id, name: fixture.name, mode: 'cc', exclude: [], folderId: null, fav: false, api: 'openai', preset: 'Default',
                model: fixture.model, 'reasoning-effort': 'high', verbosity: 'low', 'start-reply-with': '', 'stop-strings': '',
                'active-agents': '<None>', samplers: 'Temperature: 1', 'world-info-active-count': '0',
            }]),
        };
    },
};
