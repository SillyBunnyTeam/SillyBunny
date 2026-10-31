import { createComboRow } from './sillybunny-editor/rows.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './sillybunny-home/copy.js';

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
        subtitle: COPY_PLACEHOLDER,
        field: 'splash-character',
        options: Object.entries(OPTION_LABELS).map(([value, label]) => ({ value, label })),
        value: preferences.getCharacter(),
        wide: true,
        onChange: choice => preferences.setCharacter(choice),
    });
    markRowSubtitle(row, 'SET-SPLASH-SUB');
    // Borrows the Frontend Icon row's column sizing and select look: the blocking stylesheets have no room
    // for rules of their own.
    row.row.classList.add('sb-interface-settings-group', 'sb-frontend-icon-group');
    row.control.classList.add('text_pole');
    // The account settings can replace the character after the drawer was built.
    preferences.onCharacterChange(choice => row.setValue(choice));
    return row;
}
