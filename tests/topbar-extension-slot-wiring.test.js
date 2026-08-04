import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
const settingsTabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-settings-tabs.js'), 'utf8');

function getFunctionSource(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    // Skip the parameter list before hunting for the body brace: destructured parameters such as
    // createElement(tagName, { id = '' }) would otherwise close the scan on the first argument.
    let parenDepth = 0;
    let bodyStart = -1;

    for (let index = source.indexOf('(', start); index < source.length; index++) {
        const char = source[index];
        if (char === '(') {
            parenDepth++;
        } else if (char === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                bodyStart = source.indexOf('{', index);
                break;
            }
        }
    }

    expect(bodyStart).toBeGreaterThan(start);

    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function getCssRule(css, selector) {
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = css.indexOf('}', start);
    expect(end).toBeGreaterThan(start);
    return css.slice(start, end + 1);
}

describe('top-bar extension slot wiring', () => {
    test('imports the adoption decisions from the pure module', () => {
        expect(tabsSource).toContain('from \'./topbar-extension-slot/index.js\';');
        expect(tabsSource).toContain('resolveTopbarAdoptionPlan');
        expect(tabsSource).toContain('resolveCharacterBadgeMirrorPlan');
        expect(tabsSource).toContain('TOPBAR_EXTENSION_SLOT_ID');
    });

    test('tracks element ownership by identity rather than id prefix', () => {
        expect(tabsSource).toContain('const sbOwnedElements = new WeakSet();');
        expect(getFunctionSource(tabsSource, 'createElement')).toContain('sbOwnedElements.add(element);');

        const buildTopBarSource = getFunctionSource(tabsSource, 'buildTopBar');
        expect(buildTopBarSource).toContain('!isSillyBunnyOwnedElement(child)');
        expect(buildTopBarSource).not.toContain('child.id.startsWith(\'sb-\')');
    });

    test('builds the slot and adopts into it instead of appending bare siblings', () => {
        const buildTopBarSource = getFunctionSource(tabsSource, 'buildTopBar');

        expect(buildTopBarSource).toContain('id: TOPBAR_EXTENSION_SLOT_ID,');
        expect(buildTopBarSource).toContain('rightGroup.append(extensionSlot,');
        expect(buildTopBarSource).toContain('topBar.append(stack);');
        expect(buildTopBarSource).toContain('adoptTopbarExtensionNodes(preservedExtensionChildren);');
        expect(buildTopBarSource).toContain('bindTopbarExtensionAdoption();');
        expect(buildTopBarSource).not.toContain('topBar.append(stack, ...preservedExtensionChildren);');
    });

    test('pins the slot in the canonical right-group order', () => {
        expect(getFunctionSource(tabsSource, 'getTopbarGroupOrder'))
            .toContain('const right = [TOPBAR_EXTENSION_SLOT_ID];');
    });

    test('moves adopted nodes and guards the pass against re-entry', () => {
        const adoptSource = getFunctionSource(tabsSource, 'adoptTopbarExtensionNodes');

        expect(adoptSource).toContain('sbState.topbarExtensions.adopting');
        expect(adoptSource).toContain('node.parentElement !== slot');
        expect(adoptSource).toContain('sbState.topbarExtensions.observer?.takeRecords();');
        // Cloning would defeat the extension's own "already injected" guard and drop its listeners;
        // the position-specific move helpers would re-append every node but the last on each pass.
        expect(adoptSource).not.toContain('cloneNode(');
        expect(adoptSource).not.toContain('moveElementBefore(');
        expect(adoptSource).not.toContain('moveElementToStart(');
    });

    test('observes only direct children of the containers extensions inject into', () => {
        const bindSource = getFunctionSource(tabsSource, 'bindTopbarExtensionAdoption');

        expect(bindSource).toContain('observer.disconnect();');
        expect(bindSource).toContain('{ childList: true }');
        expect(bindSource).not.toContain('subtree: true');
        expect(bindSource).toContain('getCanonicalTopSettingsHolder()');
        expect(bindSource).toContain('getNativeCharacterDrawerIcon()');
    });

    test('mirrors extension badges onto the visible Characters proxy button', () => {
        const badgeSource = getFunctionSource(tabsSource, 'syncCharacterToggleBadges');

        expect(badgeSource).toContain('resolveCharacterBadgeMirrorPlan');
        expect(badgeSource).toContain('TOPBAR_ADOPTED_MARKER_ATTRIBUTE');
        expect(badgeSource).toContain('sb-has-adopted-badge');
        expect(badgeSource).not.toContain('cloneNode(');
    });

    test('leaves the proxy button state observer scoped to class changes', () => {
        const observeSource = getFunctionSource(tabsSource, 'observeProxyButton');

        expect(observeSource).toContain('attributeFilter: [\'class\']');
        expect(observeSource).not.toContain('childList');
    });
});

describe('top-bar extension slot styling', () => {
    test('constrains a foreign drawer left in the top strip', () => {
        const rule = getCssRule(tabsCss, '#top-settings-holder > .drawer:not(#ai-config-button)');

        expect(rule).toContain('pointer-events: auto;');
        expect(rule).toContain('width: auto;');
        expect(rule).toContain('flex: 0 0 auto;');
    });

    test('overrides upstream .drawer sizing on specificity alone', () => {
        const rule = getCssRule(tabsCss, '#sb-topbar-extension-slot > .drawer {');

        expect(rule).toContain('width: auto;');
        expect(rule).not.toContain('!important');
    });

    test('hides the slot when empty so the fit measurement is not inflated by a gap', () => {
        const rule = getCssRule(tabsCss, '#sb-topbar-extension-slot[data-sb-topbar-slot-empty=\'true\']');

        expect(rule).toContain('display: none;');
    });

    test('un-clips the proxy button only when it carries a mirrored badge', () => {
        expect(getCssRule(tabsCss, '.sb-proxy-button.sb-has-adopted-badge')).toContain('overflow: visible;');
    });

    test('re-anchors the CharacterLibrary embedded panel to the real bar height', () => {
        const rule = getCssRule(tabsCss, '#charlib-embedded-container {');

        // Neither operand clears the bar on its own: the layout offset stops just short of the
        // bar's bottom edge on phones, and the upstream height stops short of the chat bar row.
        expect(rule).toContain('--topBarBlockSize: max(var(--sb-host-topbar-block-size), var(--sb-topbar-layout-offset));');
        expect(rule).not.toContain('!important');

        // The alias is what keeps the scoped override from being a self-referential cycle.
        expect(tabsCss).toContain('--sb-host-topbar-block-size: var(--topBarBlockSize);');
        expect(tabsCss.match(/--sb-host-topbar-block-size:/g)).toHaveLength(1);
    });

    test('sizes adopted buttons to the phone target size', () => {
        expect(mobileShellCss).toContain('#sb-topbar-extension-slot .drawer-icon,');
        expect(getCssRule(mobileShellCss, '#sb-topbar-extension-slot .drawer-icon,'))
            .toContain('var(--sb-mobile-toggle-size)');
    });

    test('adds no !important declarations to the new top-bar blocks', () => {
        const slotBlocks = tabsCss.slice(tabsCss.indexOf('#sb-topbar-extension-slot {'), tabsCss.indexOf('#charlib-embedded-container {'));

        expect(slotBlocks).not.toContain('!important');
    });
});

describe('mobile composer third-party buttons', () => {
    test('names what the phone composer hides instead of allow-listing what it keeps', () => {
        expect(mobileShellCss).not.toContain('#rightSendForm > div:not(#send_but)');

        const rule = getCssRule(mobileShellCss, '#rightSendForm > #mes_impersonate,');

        expect(rule).toContain('#rightSendForm > #mes_continue,');
        expect(rule).toContain('#rightSendForm > #sb_prose_polisher_but,');
        expect(rule).toContain('#rightSendForm > .stscript_btn');
        expect(rule).toContain('display: none !important;');
    });

    test('relocates foreign right-rail buttons into the scrollable left rail on phones', () => {
        expect(tabsSource).toContain('const SB_COMPOSER_NATIVE_RIGHT_RAIL_IDS = Object.freeze([');

        for (const id of ['stscript_continue', 'stscript_pause', 'stscript_stop', 'mes_stop', 'mes_impersonate', 'mes_continue', 'sb_prose_polisher_but', 'send_but', 'qig-input-btn']) {
            expect(tabsSource).toContain(`'${id}',`);
        }

        const placeSource = getFunctionSource(tabsSource, 'placeComposerExtensionButtons');

        expect(placeSource).toContain('isMobileViewport()');
        expect(placeSource).toContain('SB_COMPOSER_NATIVE_RIGHT_RAIL_IDS.includes(child.id)');
        expect(placeSource).toContain('leftForm.appendChild(child);');
        expect(placeSource).toContain('rightForm.appendChild(child);');

        expect(getFunctionSource(tabsSource, 'placeComposerControls'))
            .toContain('placeComposerExtensionButtons(leftForm, rightForm);');
    });
});

describe('third-party settings drawers', () => {
    test('only hides drawers that carry a tab tag, so untagged ones fail open', () => {
        expect(settingsTabsSource).toContain('.inline-drawer[data-settings-tab]:not([data-settings-tab="appearance"])');
        expect(settingsTabsSource).toContain('.inline-drawer[data-settings-tab]:not([data-settings-tab="cache-account"])');
        expect(settingsTabsSource).not.toContain('[data-active-tab="appearance"] .inline-drawer:not(');
    });

    test('gives late third-party drawers a default tab and keeps watching for more', () => {
        expect(settingsTabsSource).toContain('const DEFAULT_SETTINGS_TAB = \'system-device\';');

        const tagSource = getFunctionSource(settingsTabsSource, 'tagUntaggedDrawers');
        expect(tagSource).toContain('.inline-drawer:not([data-settings-tab])');
        expect(tagSource).toContain('drawer.parentElement?.closest(\'.inline-drawer[data-settings-tab]\')');

        const watchSource = getFunctionSource(settingsTabsSource, 'watchForLateDrawers');
        expect(watchSource).toContain('new MutationObserver');
        expect(watchSource).toContain('tagUntaggedDrawers();');

        const initializeSource = getFunctionSource(settingsTabsSource, 'initialize');
        expect(initializeSource).toContain('tagUntaggedDrawers();');
        expect(initializeSource).toContain('watchForLateDrawers();');
    });
});
