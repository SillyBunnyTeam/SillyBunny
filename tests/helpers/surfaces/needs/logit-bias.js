/**
 * The Chat Completion logit bias list with entries: the app ships a bias preset with four entries ("Anti-bond"), and the
 * settings of a fresh account select the empty "Default (none)". The need selects the shipped preset, so that the list has
 * rows. Account settings only. See `index.js` for the shape of a need module.
 */

export const fixture = Object.freeze({ preset: 'Anti-bond', entries: 4 });

export default {
    settings(settings) {
        settings.oai_settings ??= {};
        settings.oai_settings.bias_preset_selected = fixture.preset;
    },
};
