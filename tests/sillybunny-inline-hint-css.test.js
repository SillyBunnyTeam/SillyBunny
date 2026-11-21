import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

describe('inline hint', () => {
    test('one shared rule: a centred Caption line in the dimmed foreground', () => {
        const css = read('public/css/sillybunny-tabs.css');
        const rule = css.match(/\n\.sb-inline-hint \{([^}]*)\}/)?.[1] ?? '';
        expect(rule).toMatch(/color:\s*var\(--sb-muted-fg\)/);
        expect(rule).toMatch(/font-size:\s*var\(--sb-type-caption\)/);
        expect(rule).toMatch(/text-align:\s*center/);
    });

    test('the three empty-part hints use it and carry no icon, title or action', () => {
        expect(read('public/scripts/sillybunny-tabs.js')).toContain('className: \'sb-persona-picker-appendices-empty sb-inline-hint\'');
        expect(read('public/scripts/extensions/in-chat-agents/companion/companion-panel.js')).toContain('<div class="ica--cdash-empty sb-inline-hint">No state yet.');
        const ui = read('public/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        expect(ui).toContain('<div class="ica--companion-empty sb-inline-hint">No note returned.</div>');
        expect(ui).toContain('<div class="ica--companion-empty sb-inline-hint">Companion run was cancelled.</div>');
    });

    test('the old per-surface hint rules are gone', () => {
        const agents = read('public/scripts/extensions/in-chat-agents/style.css');
        expect(agents).not.toMatch(/^\.ica--cdash-empty \{/m);
        expect(agents).not.toMatch(/^\.ica--companion-empty,/m);
        expect(read('public/css/sillybunny-tabs.css')).not.toMatch(/^\.sb-persona-picker-appendices-empty \{/m);
    });
});
