import { createSelectRow } from './sillybunny-editor/select-row.js';

// English only, like the other labels of the Interface page.
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
    const select = document.createElement('select');
    for (const [value, label] of Object.entries(OPTION_LABELS)) {
        select.append(new Option(label, value));
    }
    select.value = preferences.getCharacter();
    const row = createSelectRow({
        select,
        label: 'Splash Character',
        subtitle: 'Choose who appears while SillyBunny starts',
        field: 'splash-character',
        onChange: choice => preferences.setCharacter(choice),
    });
    // The account settings can replace the character after the drawer was built.
    preferences.onCharacterChange(choice => row.setValue(choice));
    return row;
}
