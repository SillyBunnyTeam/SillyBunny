import { createComboRow } from './sillybunny-editor/rows.js';

// English only, like the other labels of the Interface drawer.
const OPTION_LABELS = Object.freeze({
    random: 'Random',
    reisen: 'Reisen',
    tewi: 'Tewi',
    both: 'Both',
});

/**
 * The Customize → Interface row that chooses who appears while SillyBunny starts.
 * @param {{
 *   getCharacter: () => string,
 *   setCharacter: (choice: string) => void,
 *   onCharacterChange: (listener: (choice: string) => void) => void,
 * }} preferences
 */
export function createSplashCharacterRow(preferences) {
    const row = createComboRow({
        label: 'Splash Character',
        subtitle: 'Choose who appears while SillyBunny starts.',
        field: 'splash-character',
        options: Object.entries(OPTION_LABELS).map(([value, label]) => ({ value, label })),
        value: preferences.getCharacter(),
        wide: true,
        onChange: choice => preferences.setCharacter(choice),
    });
    // Borrows the column sizing of the Interface drawer's rows: the blocking stylesheets have no room for rules of their own.
    row.row.classList.add('sb-interface-settings-group', 'sb-interface-select-group');
    row.control.classList.add('text_pole');
    // The account settings can replace the character after the drawer was built.
    preferences.onCharacterChange(choice => row.setValue(choice));
    return row;
}
