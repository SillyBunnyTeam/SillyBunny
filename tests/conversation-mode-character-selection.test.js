import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

describe('Conversation mode character selection', () => {
    test('opens the selected character card in Conversation mode', () => {
        expect(scriptSource).toContain('window.dispatchEvent(new CustomEvent(\'sb:roleplay-character-selected\'');
        expect(scriptSource).toContain('detail: { avatar: characters[this_chid]?.avatar || \'\' }');
        expect(tabsSource).toContain('characters, flushCharacterSaveDebounced');
        expect(tabsSource).toContain('saveSettingsDebounced, this_chid } from \'../script.js\';');
        expect(tabsSource).toContain('avatar: characters[this_chid]?.avatar || \'\',');
        expect(tabsSource).toContain('showToast: false,');
    });
});
