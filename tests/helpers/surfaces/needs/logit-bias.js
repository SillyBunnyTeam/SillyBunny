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
    // Applying a Chat Completion preset sets the bias selection from the preset, and the app applies the active preset at a
    // moment that differs between boots. Every preset of the answer therefore selects the same bias preset as the settings.
    answer(answer) {
        answer.openai_settings = (answer.openai_settings ?? []).map((text) => {
            const preset = JSON.parse(text);
            if (!Object.hasOwn(preset, 'bias_presets')) {
                return text;
            }
            preset.bias_preset_selected = fixture.preset;
            return JSON.stringify(preset);
        });
    },
};
