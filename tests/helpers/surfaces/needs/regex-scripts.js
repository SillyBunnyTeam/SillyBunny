/**
 * Two global regex scripts, one of them disabled. The Regex extension keeps its scripts in the account settings
 * (`extension_settings.regex`), which is the only place the app stores them, so this need is settings only.
 * See `index.js` for the shape of a need module.
 */

import { enableExtensions, extensionSettings, mergeById } from '../need-kit.js';

/** `enabled` and `disabled` are the two scripts' ids and names. */
export const fixture = Object.freeze({
    enabled: Object.freeze({ id: 'audit-regex-enabled', scriptName: 'Audit Rule Enabled' }),
    disabled: Object.freeze({ id: 'audit-regex-disabled', scriptName: 'Audit Rule Disabled' }),
});

const script = (entry, findRegex, replaceString, disabled) => ({
    ...entry, findRegex, replaceString, trimStrings: [], placement: [1, 2], disabled, markdownOnly: false, promptOnly: false,
    runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null,
});

export default {
    settings(settings) {
        enableExtensions(settings, ['regex']);
        const extensions = extensionSettings(settings);
        extensions.regex = mergeById(extensions.regex, [
            script(fixture.enabled, '/audit-alpha/g', 'audit-beta', false),
            script(fixture.disabled, '/audit-gamma/g', 'audit-delta', true),
        ]);
    },
};
