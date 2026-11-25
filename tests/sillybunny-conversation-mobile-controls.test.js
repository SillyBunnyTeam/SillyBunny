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
    return getDeclarations(ast.stylesheet, selector);
}

function findContainerRule(query) {
    return ast.stylesheet.rules.find(rule => rule.type === 'container' && rule.container === query);
}

const PAGES = '#sheld[data-sb-conversation-layout=\'pages\']';
const pagesSelectors = ast.stylesheet.rules
    .filter(rule => rule.type === 'rule')
    .flatMap(rule => rule.selectors)
    .filter(selector => selector.includes('data-sb-conversation-layout=\'pages\''));

describe('Conversation mobile controls', () => {
    test('44px touch targets follow the pointer, not a width', () => {
        const media = findMediaRule(query => query === '(pointer: coarse)');
        expect(media).toBeDefined();

        expect(getDeclarations(media, '.sb-conversation-selfie-action')).toMatchObject({
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
        // A coarse pointer has no hover, so the toolbar gives way to the trigger whatever the width.
        expect(getDeclarations(media, '.sb-conversation-message-actions')).toMatchObject({ display: 'none' });
        expect(getDeclarations(media, '.sb-conversation-mobile-menu-trigger')).toMatchObject({
            display: 'inline-flex',
            position: 'relative',
            inset: 'auto',
            transform: 'none',
        });
        expect(pagesSelectors.join(' ')).not.toContain('.sb-conversation-mobile-menu-trigger');
        expect(getDeclarations(media, '.sb-conversation-reply-cancel')).toMatchObject({
            'inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'block-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
    });

    test('touch-target sizing is not confined to the pages layout', () => {
        expect(pagesSelectors.length).toBeGreaterThan(0);
        expect(pagesSelectors).not.toContain(`${PAGES} .sb-conversation-selfie-action`);
        expect(pagesSelectors).not.toContain(`${PAGES} .sb-conversation-reply-cancel`);
    });

    test('the pages layout follows the layout attribute, not a viewport media query', () => {
        // The layout is decided from the #sheld width in conversation-pages.js, so a viewport query here would disagree with it.
        const viewportRules = findMediaRule(query => query.includes('max-width: 768px') && !query.includes('max-height'))?.rules ?? [];
        expect(viewportRules.flatMap(rule => rule.selectors ?? []).filter(selector => selector.includes('#sb_conversation_list'))).toEqual([]);
        expect(css).not.toMatch(/@media \(max-width: 450px\)/);
    });

    test('mobile pages are driven by data-sb-conversation-page', () => {
        const media = ast.stylesheet;
        expect(getDeclarations(media, `${PAGES} #sb_conversation_list`)).toMatchObject({
            position: 'absolute',
            inset: '0',
            'grid-area': 'unset',
            transform: 'translateX(-100%)',
        });
        expect(getDeclarations(media, `${PAGES}[data-sb-conversation-page='list'] #sb_conversation_list`)).toMatchObject({
            visibility: 'visible',
            transform: 'none',
        });
        expect(getDeclarations(media, `${PAGES}[data-sb-conversation-page='list'] :is(#sb_conversation_header, #sb_conversation_stage)`)).toMatchObject({
            visibility: 'hidden',
        });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-header-back`)).toMatchObject({ display: 'inline-grid' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-header-title`)).toMatchObject({ flex: '1 1 auto' });
        // Attach and the "+" menu show in every layout, so the pages layout has no rule that hides or shows either.
        expect(pagesSelectors.join(' ')).not.toMatch(/composer-(more|attach|actions)/);
        expect(getDeclarations(media, PAGES)).toMatchObject({
            border: '0',
            height: 'calc(var(--sb-shell-viewport-height, 100dvh) - var(--sb-topbar-layout-offset, var(--topBarBlockSize))) !important',
        });
        expect(getDeclarations(media, `body:not(.movingUI) ${PAGES}`)).toMatchObject({
            border: '0',
            height: 'calc(var(--sb-shell-viewport-height, 100dvh) - var(--sb-topbar-layout-offset, var(--topBarBlockSize))) !important',
        });
        expect(getDeclarations(media, PAGES)).not.toHaveProperty('position');
        expect(getDeclarations(media, `${PAGES} .sb-conversation-composer`)).toMatchObject({
            'padding-block-end': 'max(8px, env(safe-area-inset-bottom, 0px))',
        });
        // Three rules stay in :where() so the layout selector does not outrank the rules they sat beside as media rules.
        expect(getDeclarations(media, `:where(${PAGES}) .sb-conversation-message-meta`)).toMatchObject({ 'padding-inline-end': '0' });
    });

    test('pickers are bottom sheets under the menu rule: the mobile width or a window too short for a popover', () => {
        const sheet = findMediaRule(query => query === '(max-width: 768px), (max-height: 360px)');
        expect(sheet).toBeDefined();
        expect(getDeclarations(sheet, '#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-picker:not([hidden])')).toMatchObject({
            inset: 'auto 0 0',
        });
        expect(readFileSync(fileURLToPath(new URL('../public/scripts/sillybunny-conversation/pickers.js', import.meta.url)), 'utf8'))
            .toMatch(/PICKER_MOBILE_QUERY = MENU_SHEET_QUERY;/);
    });

    test('surfaces are opaque layers without backdrop-filter', () => {
        expect(css).not.toMatch(/backdrop-filter\s*:/);
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_header').background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_list').background).toBe('var(--sb-conv-sidebar-bg)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-search-bar').background).toBe('var(--sb-conv-sidebar-bg)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-composer').padding).toBe('8px 12px');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\']')['border-radius']).toBe('0');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\']').height).toBe('calc(100dvh - var(--sb-topbar-layout-offset, var(--topBarBlockSize)))');
        expect(css).not.toMatch(/\.sb-conversation-message\[data-role='user'\] \.sb-conversation-message-actions/);
        expect(getRuleDeclarations('.sb-conversation-message-actions').transform).toBe('translate(0, calc(6px - 100%))');
        expect(getRuleDeclarations('.sb-conversation-message-actions')).toMatchObject({
            'grid-area': '1 / 1',
            'align-self': 'start',
            'justify-self': 'end',
            'max-inline-size': '100%',
            'flex-wrap': 'wrap',
        });
        expect(getRuleDeclarations('.sb-conversation-message-content')).toMatchObject({
            display: 'grid',
            'grid-template-columns': 'minmax(0, 1fr)',
            'max-inline-size': '100%',
        });
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_stage').background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-header-back').display).toBe('none');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-header-title').flex).toBe('0 1 auto');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\']')['--sb-conv-column-gutter']).toBe('20px');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\']')['--sb-conv-column-width']).toBe('100%');
        expect(getRuleDeclarations('.sb-conversation-message[data-role=\'user\']').justifyContent || getRuleDeclarations('.sb-conversation-message[data-role=\'user\']')['justify-content']).toBe('flex-end');
        expect(css).not.toMatch(/\.sb-conversation-message\[data-role='user'\] \{\s*flex-direction:\s*row-reverse/);
        expect(getRuleDeclarations('.sb-conversation-message-body')['max-inline-size']).toBe('min(80%, 840px)');
    });

    test('inline editor uses libadwaita pill buttons, not legacy menu buttons', () => {
        expect(getRuleDeclarations('.sb-conversation-message-edit-control')).toMatchObject({
            'border-radius': 'var(--sb-radius-pill)',
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

    test('keeps no pane, filter tab, quick button or local copy of the shared row looks', () => {
        // The details window and the composer menu replaced them; a leftover rule would style nothing.
        expect(css).not.toMatch(/settings_drawer|settings_backdrop|sb-conversation-settings-|channel-tab|composer-actions|composer-quick|header-settings|header-caret/);
        expect(css).not.toMatch(/data-sb-conversation-layout='(?:split|overlay)'/);
        expect(css).not.toMatch(/\.sb-settings-group|\.sb-conversation-pref-|\.sb-conversation-switch|\.sb-conversation-idle-actions/);
    });

    test('the message toolbar is an OSD overlay above the bubble, with no border or shadow of its own', () => {
        const toolbar = getRuleDeclarations('.sb-conversation-message-actions');
        expect(toolbar).toMatchObject({
            background: 'var(--sb-osd-bg)',
            color: 'var(--sb-osd-ink)',
            'border-radius': 'var(--sb-radius-control)',
        });
        expect(toolbar).not.toHaveProperty('border');
        expect(toolbar).not.toHaveProperty('box-shadow');
        expect(getRuleDeclarations('.sb-conversation-message-action')['border-radius']).toBe('var(--sb-radius-inner)');
        // The timeline is a container, so the toolbar follows the width it has, not the viewport's.
        expect(getRuleDeclarations('.sb-conversation-timeline')).toMatchObject({ container: 'sb-conv-timeline / inline-size' });
        const wide = findContainerRule('sb-conv-timeline (min-width: 512px)');
        expect(getDeclarations(wide, '.sb-conversation-message-actions')).toEqual({ 'max-inline-size': 'max(100%, 30rem)' });
        // Narrower, the secondary actions leave the toolbar (the menu keeps them) so it never wraps onto the message above.
        const narrow = findContainerRule('sb-conv-timeline (max-width: 511px)');
        expect(getDeclarations(narrow, '.sb-conversation-message-actions > [data-sb-secondary]')).toEqual({ display: 'none' });
        const narrowest = findContainerRule('sb-conv-timeline (max-width: 339px)');
        expect(Object.keys(getDeclarations(narrowest, '.sb-conversation-message-actions > :is(.sb-conversation-reaction-button, .sb-conversation-message-divider:not([data-sb-secondary]))'))).toEqual(['display']);
        expect(toolbar['--sb-osd-contrast-ring']).toBe('0 0 0 1px var(--sb-osd-ink)');
        const contrast = ast.stylesheet.rules.find(rule => rule.type === 'media' && rule.media === '(prefers-contrast: more)'
            && rule.rules.some(inner => inner.selectors?.includes('.sb-conversation-message-actions')));
        expect(getDeclarations(contrast, '.sb-conversation-message-actions')).toEqual({ 'box-shadow': 'var(--sb-osd-contrast-ring)' });
    });

    test('the composer is a container, and its Emoji button is not drawn in a row that is narrower than a 360px composer', () => {
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-composer')).toMatchObject({ container: 'sb-conv-composer / inline-size' });
        // 360px less the 8px of padding on each side in the pages layout: the entry keeps 144px beside four buttons.
        const folded = findContainerRule('sb-conv-composer (max-width: 343px)');
        // The selector has to outrank the flat-button rule that sets display: inline-grid.
        expect(getDeclarations(folded, '#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-composer-emoji')).toEqual({ display: 'none' });
        expect(findContainerRule('sb-conv-composer (max-width: 359px)')).toBeUndefined();
    });

    test('the drop hint is an accent ring inside a tonal fill, without a dashed border or an outer shadow', () => {
        const hint = getRuleDeclarations('.sb-conversation-drop-hint');
        expect(hint).toMatchObject({
            'border-radius': 'var(--sb-radius-card)',
            background: 'color-mix(in srgb, var(--sb-accent) 10%, var(--sb-layer-window))',
            'box-shadow': 'var(--sb-drop-hint-ring)',
            '--sb-drop-hint-ring': 'inset 0 0 0 2px color-mix(in srgb, var(--sb-accent) 40%, transparent)',
        });
        expect(hint).not.toHaveProperty('border');
    });

    test('the header avatars reach the touch floor with a real box', () => {
        const media = findMediaRule(query => query === '(pointer: coarse)');
        expect(getDeclarations(media, '.sb-conversation-header-avatar .sb-conversation-participant-avatar')).toMatchObject({
            'inline-size': 'var(--sb-density-floor)',
            'block-size': 'var(--sb-density-floor)',
        });
    });

    test('desktop pickers use auto inset so JS can park them on the trigger', () => {
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-picker:not([hidden])')).toMatchObject({
            position: 'absolute',
            inset: 'auto',
            background: 'var(--sb-layer-popover)',
        });
    });
});
