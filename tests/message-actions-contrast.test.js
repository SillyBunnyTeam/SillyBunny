import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const themeSource = read('public', 'css', 'sillybunny-theme.css');
const actionsSource = read('public', 'css', 'sillybunny-message-actions.css');
const baseStyleSource = read('public', 'style.css');

describe('message action contrast', () => {
    test('a resting action is dimmed by colour at full opacity, in both tones', () => {
        expect(actionsSource).toMatch(/#chat \.mes :is\(\.mes_buttons \.mes_button, \.extraMesButtons > div, \.mes_reasoning_actions \.mes_button\):not\(\.mes_delete, \.script-running, \.script-ran\) \{\s*opacity: 1;\s*color: var\(--sb-muted-fg\);/);
        expect(actionsSource).toMatch(/body #chat \.mes:not\(\.last_swipe\) :is\(\.swipe_left, \.swipe_right, \.swipes-counter\) \{\s*opacity: 1;\s*color: var\(--sb-muted-fg\);/);
        expect(actionsSource).toMatch(/#chat \.mes \.mes_buttons \.mes_delete \{\s*opacity: 1;/);
    });

    test('the light tone no longer lifts the opacity, and keeps dropping the dark shadow', () => {
        expect(themeSource).toMatch(/:root\[data-sb-surface-tone='light'\] #chat \.mes \.mes_button,[\s\S]*?\{\s*filter: none;\s*\}/);
        const lightRules = themeSource.match(/:root\[data-sb-surface-tone='light'\] #chat \.mes \.(?:mes_button|extraMesButtons > div)[^{]*\{[^}]*\}/g) ?? [];
        expect(lightRules.length).toBeGreaterThan(0);
        for (const rule of lightRules) {
            expect(rule).not.toMatch(/opacity/);
        }
    });

    test('upstream keeps its 30% opacity and dark shadow, which the rules above override', () => {
        expect(baseStyleSource).toContain('opacity: 0.3;');
        expect(baseStyleSource).toContain('filter: drop-shadow(0px 0px 2px black);');
    });

    test('the Moonlit styles no longer force an opacity on the swipe counter', () => {
        const chatStyles = read('public', 'css', 'sillybunny-chat-styles.css');
        expect(chatStyles).not.toMatch(/\.swipes-counter[^{]*\{[^}]*opacity:\s*0\.[89]\s*!important/);
    });
});
