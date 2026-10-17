import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-theme.css'), 'utf8').replace(/\r\n/g, '\n');
const baseStyleSource = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

describe('message action contrast', () => {
    test('raises light-surface action contrast without changing dark-surface defaults', () => {
        expect(themeSource).toMatch(/:root\[data-sb-surface-tone='light'\][\s\S]*?#chat \.mes \.mes_button[\s\S]*?opacity:\s*0\.8;/);
        expect(themeSource).toMatch(/:root\[data-sb-surface-tone='light'\][\s\S]*?#chat \.mes \.mes_button[\s\S]*?filter:\s*none;/);
        expect(themeSource).toMatch(/:root\[data-sb-surface-tone='light'\][\s\S]*?#chat \.mes \.mes_button:hover[\s\S]*?opacity:\s*1;/);
        expect(baseStyleSource).toContain('opacity: 0.3;');
        expect(baseStyleSource).toContain('filter: drop-shadow(0px 0px 2px black);');
    });
});
