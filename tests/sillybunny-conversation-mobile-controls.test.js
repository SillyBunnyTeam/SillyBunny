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
        // The layout is decided from the #sheld width in settings-panel.js, so a viewport query here would disagree with it.
        expect(findMediaRule(query => query.includes('max-width: 768px') && !query.includes('max-height'))
            ?.rules.flatMap(rule => rule.selectors ?? []).filter(selector => selector.includes('#sb_conversation_pals_rail'))).toEqual([]);
        expect(css).not.toMatch(/@media \(max-width: 450px\)/);
    });

    test('mobile pages are driven by data-sb-conversation-page', () => {
        const media = ast.stylesheet;
        expect(getDeclarations(media, `${PAGES} #sb_conversation_pals_rail`)).toMatchObject({
            position: 'absolute',
            inset: '0',
            'grid-area': 'unset',
            transform: 'translateX(-100%)',
        });
        expect(getDeclarations(media, `${PAGES}[data-sb-conversation-page='pals'] #sb_conversation_pals_rail`)).toMatchObject({
            visibility: 'visible',
            transform: 'none',
        });
        expect(getDeclarations(media, `${PAGES}[data-sb-conversation-page='pals'] :is(#sb_conversation_header, #sb_conversation_stage)`)).toMatchObject({
            visibility: 'hidden',
        });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-header-back`)).toMatchObject({ display: 'inline-grid' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-header-settings`)).toMatchObject({ display: 'none' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-header-title`)).toMatchObject({ flex: '1 1 auto' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-composer-more`)).toMatchObject({ display: 'inline-grid' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-composer-attach`)).toMatchObject({ display: 'none' });
        expect(getDeclarations(media, `${PAGES} .sb-conversation-composer-actions`)).toMatchObject({ display: 'none' });
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

    test('settings is a non-modal pane that docks as a split column', () => {
        // Hidden by default; only an overlay pane shows it, so a split pane or a page gets no shade.
        expect(getRuleDeclarations('#sb_conversation_settings_backdrop')).toMatchObject({ display: 'none' });
        const OVERLAY = '#sheld[data-sb-conversation-layout=\'overlay\']';
        expect(getRuleDeclarations(`${OVERLAY} #sb_conversation_settings_backdrop:not([hidden])`)).toMatchObject({ display: 'block' });
        expect(css.match(/#sb_conversation_settings_backdrop/g)).toHaveLength(3);
        // Half the dialog backdrop over the whole workspace (the rail included), under the pane: the page transition shade of an overlay split view.
        const shade = getRuleDeclarations(`${OVERLAY} #sb_conversation_settings_backdrop`);
        expect(shade).toMatchObject({
            inset: '0',
            background: 'color-mix(in srgb, var(--sb-dialog-backdrop) 50%, transparent)',
        });
        expect(shade).not.toHaveProperty('inset-inline-start');
        const drawer = getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_settings_drawer');
        expect(drawer).toMatchObject({ 'box-shadow': 'var(--sb-conv-pane-shadow)' });
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\']')['--sb-conv-pane-shadow']).toBe('0 0 56px var(--sb-dialog-backdrop)');
        expect(drawer['z-index']).toBe('calc(var(--sb-z-raised) + 4)');
        expect(shade['z-index']).toBe('calc(var(--sb-z-raised) + 3)');
        expect(getRuleDeclarations(`${PAGES} #sb_conversation_settings_drawer`)).toMatchObject({ 'box-shadow': 'none' });
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'][data-sb-conversation-layout=\'split\'] #sb_conversation_settings_drawer')).toMatchObject({
            'grid-area': 'settings',
            position: 'relative',
        });
    });

    test('surfaces are opaque layers without backdrop-filter', () => {
        expect(css).not.toMatch(/backdrop-filter\s*:/);
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_header').background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_pals_rail').background).toBe('var(--sb-conv-sidebar-bg)');
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
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_settings_drawer').background).toBe('var(--sb-layer-drawer)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_stage').background).toBe('var(--sb-layer-view)');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-header-back').display).toBe('none');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-header-title').flex).toBe('0 1 auto');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-composer-more').display).toBe('none');
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'][data-sb-conversation-layout=\'split\']')['grid-template-columns']).toBe('var(--sb-conv-sidebar-width) minmax(0, 1fr) 0px');
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

    test('settings groups are shared boxed-list rows and boolean rows are shared switches', () => {
        expect(getRuleDeclarations('.sb-conversation-settings-body')).toMatchObject({
            gap: 'var(--sb-settings-group-gap)',
            padding: 'var(--sb-settings-inset-top) var(--sb-settings-inset) var(--sb-settings-inset)',
        });
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-settings-body [hidden]')).toMatchObject({
            display: 'none !important',
        });
        expect(getRuleDeclarations('.sb-conversation-members-wrapper:not([hidden])')).toMatchObject({ display: 'contents' });
        // The group, row and switch looks come from the shared .ds-* and .sb-switch rules; no local copy is left.
        expect(css).not.toMatch(/\.sb-settings-group|\.sb-conversation-pref-|\.sb-conversation-switch/);
        expect(css).not.toMatch(/\.sb-conversation-idle-actions/);
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

    test('an overlay settings pane stays beside the rail, so the header keeps its width', () => {
        expect(getRuleDeclarations('#sheld[data-sb-conversation-mode=\'on\'][data-sb-conversation-layout=\'overlay\'] #sb_conversation_settings_drawer')).toMatchObject({
            'inline-size': 'min(var(--sb-conv-pane-width), calc(100% - var(--sb-conv-sidebar-width)))',
        });
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
