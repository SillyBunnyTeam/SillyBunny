import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/css/sillybunny-conversation.css', import.meta.url)), 'utf8');
const ast = parse(css, { source: 'sillybunny-conversation.css' });

function findMediaRule(predicate) {
    return ast.stylesheet.rules.find(rule => rule.type === 'media' && predicate(rule.media));
}

function getDeclarations(media, selector) {
    const rule = media.rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    expect(rule).toBeDefined();
    return Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));
}

function getRuleDeclarations(selector) {
    const rule = ast.stylesheet.rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    expect(rule).toBeDefined();
    return Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));
}

describe('Conversation mobile controls', () => {
    test('44px touch targets apply to coarse pointers and the 1000px project mobile breakpoint', () => {
        const media = findMediaRule(query => query.includes('pointer: coarse') && query.includes('max-width: 1000px'));
        expect(media).toBeDefined();
        // Comma-separated query: either condition alone is sufficient.
        expect(media.media).toMatch(/\(pointer: coarse\)\s*,\s*\(max-width: 1000px\)/);

        expect(getDeclarations(media, '.sb-conversation-selfie-action')).toMatchObject({
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
        expect(getDeclarations(media, '.sb-conversation-reply-cancel')).toMatchObject({
            'inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'block-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
    });

    test('touch-target sizing is not confined to the 768px phone breakpoint', () => {
        const phoneMedia = findMediaRule(query => query.includes('max-width: 768px') && !query.includes('pointer: coarse'));
        expect(phoneMedia).toBeDefined();
        const phoneSelectors = phoneMedia.rules
            .filter(rule => rule.type === 'rule')
            .flatMap(rule => rule.selectors);
        expect(phoneSelectors).not.toContain('.sb-conversation-selfie-action');
        expect(phoneSelectors).not.toContain('.sb-conversation-reply-cancel');
    });

    test('mobile pages are driven by data-sb-conversation-page', () => {
        const media = findMediaRule(query => query === '(max-width: 768px)');
        expect(media).toBeDefined();
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] #sb_conversation_pals_rail")).toMatchObject({
            position: 'absolute',
            inset: '0',
            'grid-area': 'unset',
            transform: 'translateX(-100%)',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'][data-sb-conversation-page='pals'] #sb_conversation_pals_rail")).toMatchObject({
            visibility: 'visible',
            transform: 'none',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'][data-sb-conversation-page='pals'] :is(#sb_conversation_header, #sb_conversation_stage)")).toMatchObject({
            visibility: 'hidden',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-header-back")).toMatchObject({
            display: 'inline-grid',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-header-settings")).toMatchObject({
            display: 'none',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-header-title")).toMatchObject({
            flex: '1 1 auto',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer-more")).toMatchObject({
            display: 'inline-grid',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer-attach")).toMatchObject({
            display: 'none',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer-actions")).toMatchObject({
            display: 'none',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-picker:not([hidden])")).toMatchObject({
            inset: 'auto 0 0',
        });
        expect(getDeclarations(media, '.sb-conversation-mobile-menu-trigger')).toMatchObject({
            position: 'relative',
            inset: 'auto',
            transform: 'none',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on']")).toMatchObject({
            border: '0',
            height: 'calc(var(--sb-shell-viewport-height, 100dvh) - var(--sb-topbar-layout-offset, var(--topBarBlockSize))) !important',
        });
        expect(getDeclarations(media, "body:not(.movingUI) #sheld[data-sb-conversation-mode='on']")).toMatchObject({
            border: '0',
            height: 'calc(var(--sb-shell-viewport-height, 100dvh) - var(--sb-topbar-layout-offset, var(--topBarBlockSize))) !important',
        });
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on']")).not.toHaveProperty('position');
        expect(getDeclarations(media, "#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer")).toMatchObject({
            'padding-block-end': 'max(8px, env(safe-area-inset-bottom, 0px))',
        });
    });

    test('settings is a non-modal pane that docks as a split column', () => {
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] #sb_conversation_settings_backdrop")).toMatchObject({
            display: 'none',
        });
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'][data-sb-conversation-layout='split'] #sb_conversation_settings_drawer")).toMatchObject({
            'grid-area': 'settings',
            position: 'relative',
        });
    });

    test('surfaces are opaque layers without backdrop-filter', () => {
        expect(css).not.toMatch(/backdrop-filter\s*:/);
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] #sb_conversation_header").background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] #sb_conversation_pals_rail").background).toBe('var(--sb-conv-sidebar-bg)');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-search-bar").background).toBe('var(--sb-conv-sidebar-bg)');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer").padding).toBe('8px 12px');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on']")['border-radius']).toBe('0');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on']").height).toBe('calc(100dvh - var(--sb-topbar-layout-offset, var(--topBarBlockSize)))');
        expect(css).not.toMatch(/\.sb-conversation-message\[data-role='user'\] \.sb-conversation-message-actions/);
        expect(getRuleDeclarations('.sb-conversation-message-actions').transform).toBe('translate(0, -8px)');
        expect(getRuleDeclarations('.sb-conversation-message-actions')['inset-inline-end']).toBe('0');
        expect(getRuleDeclarations('.sb-conversation-message-actions')['inset-inline-start']).toBe('auto');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] #sb_conversation_settings_drawer").background).toBe('var(--sb-layer-drawer)');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] #sb_conversation_stage").background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-header-back").display).toBe('none');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-header-title").flex).toBe('0 1 auto');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-composer-more").display).toBe('none');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'][data-sb-conversation-layout='split']")['grid-template-columns']).toBe('var(--sb-conv-sidebar-width) minmax(0, 1fr) 0px');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on']")['--sb-conv-column-gutter']).toBe('20px');
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on']")['--sb-conv-column-width']).toBe('100%');
        expect(getRuleDeclarations('.sb-conversation-message[data-role=\'user\']').justifyContent || getRuleDeclarations('.sb-conversation-message[data-role=\'user\']')['justify-content']).toBe('flex-end');
        expect(css).not.toMatch(/\.sb-conversation-message\[data-role='user'\] \{\s*flex-direction:\s*row-reverse/);
        expect(getRuleDeclarations('.sb-conversation-message-body')['max-inline-size']).toBe('min(80%, 840px)');
    });

    test('inline editor uses libadwaita pill buttons, not legacy menu buttons', () => {
        expect(getRuleDeclarations('.sb-conversation-message-edit-control')).toMatchObject({
            'border-radius': '999px',
            background: 'var(--sb-raised-bg)',
        });
        expect(getRuleDeclarations('.sb-conversation-message-edit-save')).toMatchObject({
            background: 'var(--sb-accent)',
            color: 'var(--sb-on-solid-accent)',
        });
        expect(getRuleDeclarations('.sb-conversation-message-edit-delete')).toMatchObject({
            background: 'transparent',
            color: 'var(--sb-color-danger)',
            'margin-inline-end': 'auto',
        });
        expect(css).not.toContain('.sb-conversation-message-edit-control.menu_button');
    });

    test('mobile composer shares the Roleplay composer size tokens', () => {
        const mobileShell = readFileSync(fileURLToPath(new URL('../public/css/sillybunny-mobile-shell.css', import.meta.url)), 'utf8');
        expect(mobileShell).toMatch(/:root\s*\{\s*--sb-mobile-composer-action-size:/);
        expect(mobileShell).toMatch(/:root\[data-sb-compact-mode='true'\]\s*\{\s*--sb-mobile-composer-action-size:/);
        expect(mobileShell).toMatch(/#nonQRFormItems\s*\{[^}]*--sb-composer-action-size:\s*var\(--sb-mobile-composer-action-size\);/);
        expect(css).toMatch(/\.sb-conversation-composer\s*\{[^}]*--sb-conv-button-size:\s*var\(--sb-mobile-composer-action-size/);
        expect(css).toMatch(/\.sb-conversation-composer\s*\{[^}]*--sb-composer-action-icon-size:\s*var\(--sb-mobile-composer-action-icon-size/);
    });

    test('settings groups are boxed lists and boolean rows are switches', () => {
        expect(getRuleDeclarations('.sb-settings-group')).toMatchObject({
            background: 'color-mix(in srgb, var(--SmartThemeBodyColor) 4%, transparent)',
            border: '0',
        });
        expect(getRuleDeclarations('.sb-conversation-pref-row')).toMatchObject({
            display: 'flex',
            'min-block-size': '46px',
        });
        expect(getRuleDeclarations('.sb-conversation-switch')).toMatchObject({
            appearance: 'none',
            '-webkit-appearance': 'none',
            'inline-size': '42px',
            'block-size': '24px',
        });
        expect(getRuleDeclarations('.sb-conversation-switch:checked')).toMatchObject({
            background: 'var(--sb-accent, var(--SmartThemeQuoteColor))',
        });
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-settings-body [hidden]")).toMatchObject({
            display: 'none !important',
        });
        expect(css).not.toMatch(/\.sb-conversation-idle-actions/);
    });

    test('desktop pickers use auto inset so JS can park them on the trigger', () => {
        expect(getRuleDeclarations("#sheld[data-sb-conversation-mode='on'] .sb-conversation-picker:not([hidden])")).toMatchObject({
            position: 'absolute',
            inset: 'auto',
            background: 'var(--sb-layer-popover)',
        });
    });
});
