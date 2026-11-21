import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const read = path => readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');

describe('responses of SillyBunny-authored dialogs', () => {
    test.each([
        ['scripts/data-maid-dialog.js'],
        ['scripts/sillybunny-tabs.js'],
        ['scripts/sillybunny-server-tools.js'],
        ['scripts/extensions/vectors/index.js'],
    ])('%s labels no response "Yes"', path => {
        expect(read(path)).not.toMatch(/(?:label|okButton): t`Yes`/);
    });

    test('Data Maid confirms delete with a verb and keeps Cancel focused', () => {
        const source = read('scripts/data-maid-dialog.js');
        expect(source.match(/okButton: t`Delete`/g)).toHaveLength(2);
        expect(source.match(/defaultResult: POPUP_RESULT\.NEGATIVE/g)).toHaveLength(2);
    });

    test('Data Maid no longer looks for a header slot that the Popup frame does not build', () => {
        expect(read('scripts/data-maid-dialog.js')).not.toContain('sb-dialog__header-end');
    });

    test.each([
        ['scripts/extensions/in-chat-agents/ui/agent-editor-dialogs.js'],
        ['scripts/extensions/in-chat-agents/index.js'],
    ])('%s starts an explicit-action dialog header with Cancel, never Discard', path => {
        expect(read(path)).not.toMatch(/cancelButton: (?:t`Discard`|'Discard Changes')/);
    });

    test('the agent alerts that had no heading carry a title', () => {
        const index = read('scripts/extensions/in-chat-agents/index.js');
        expect(index).toContain('title: t`Convert Trackers to Companions`');
        expect(index).toContain('title: t`Update All Agents`');
        expect(index).toContain('title: t`Update Agent`');
        expect(read('scripts/extensions/in-chat-agents/ui/agent-list.js')).toContain('heading: item.id === \'delete\'');
    });

    test('a destructive confirm takes the shared solid fill, not a tint of it', () => {
        const css = read('css/sillybunny-message-actions.css');
        const rule = css.slice(css.indexOf('.sb-popup-destructive-confirm .menu_button.sb-popup-destructive'));
        expect(rule).toContain('background: var(--sb-color-danger);');
        expect(css).not.toMatch(/--sb-color-danger\) 18%/);
        expect(read('scripts/sillybunny-delete-confirm.js').match(/'sb-popup-destructive', 'is-destructive'/g)).toHaveLength(2);
        expect(read('scripts/sillybunny-conversation/dialogs.js')).toContain('\'sb-popup-destructive\', \'is-destructive\'');
    });
});
