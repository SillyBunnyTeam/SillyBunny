import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const normalizedTabsSource = tabsSource.replace(/\r\n/g, '\n');

function getFunctionSource(name) {
    const match = tabsSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

describe('Backend shortcut routes', () => {
    const migrate = new Function(`${getFunctionSource('migrateLegacyWorldInfoRoute')}\n${getFunctionSource('migrateTabId')}\n${getFunctionSource('migrateShortcutTarget')}\nreturn migrateShortcutTarget;`)();

    test.each([
        ['left:presets', 'left:prompting'],
        ['left:api', 'left:connections'],
        ['left:advanced-formatting', 'left:context'],
        ['left:world-info', 'characters:world-info'],
        ['left:editor', 'left:editor'],
        ['characters:editor', 'characters:editor'],
        ['right:extensions', 'right:extensions'],
        [null, null],
    ])('migrates %s to %s without crossing shell boundaries', (stored, expected) => {
        expect(migrate(stored)).toBe(expected);
    });

    test('migrates before validating saved shortcuts against the canonical registry', () => {
        const registry = tabsSource.match(/const SB_SHORTCUT_TARGETS = Object\.freeze\(\[[\s\S]*?\n\]\);/)[0];
        const values = [...registry.matchAll(/value: '([^']+)'/g)].map(match => match[1]);
        expect(values.filter(value => value.startsWith('left:'))).toEqual([
            'left:connections', 'left:sampling', 'left:prompting', 'left:editor', 'left:context', 'left:agents',
        ]);
        expect(getFunctionSource('getShortcutTarget')).toContain('const stored = migrateShortcutTarget(');
    });
});

describe('topbar label title', () => {
    test('flushes configured label settings immediately after storage writes', () => {
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts, JSON.stringify(sbState.topbarLabel.desktopParts));\n    flushSbStorageWrites();');
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelMobilePart, nextPart);\n    flushSbStorageWrites();');
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelCustomText, nextText);\n    flushSbStorageWrites();');
    });

    test('binds accessible pointer and keyboard activation on the title', () => {
        const bindSource = getFunctionSource('bindTopBarTitle');
        expect(bindSource).toContain('title.addEventListener(\'click\'');
        expect(bindSource).toContain('title.addEventListener(\'keydown\'');
        expect(bindSource).toContain('event.key !== \'Enter\' && event.key !== \' \'');
        expect(bindSource).toContain('event.preventDefault();');
        expect(bindSource).toContain('returnToChatSurface();');

        expect(tabsSource).toContain('role="button"');
        expect(tabsSource).toContain('tabindex="0"');
        expect(tabsSource).toContain('title.setAttribute(\'aria-label\'');
    });

    test('title activation returns to the chat without closing it', () => {
        const returnSource = getFunctionSource('returnToChatSurface');
        expect(returnSource).toContain('closeShell(\'left\');');
        expect(returnSource).toContain('closeShell(\'right\');');
        expect(returnSource).toContain('closeCharacterPanel();');
        expect(returnSource).not.toContain('closeCurrentChat');
    });

    test('has no click-to-preview label cycle or setting', () => {
        expect(tabsSource).not.toContain('cycleTopBarLabel');
        expect(tabsSource).not.toContain('sb-topbar-label-click-cycle');
        expect(tabsSource).not.toContain('Click To Preview Label Options');
        expect(cssSource).not.toContain('.sb-brand-title.is-previewing');
    });

    test('marks the title as a visible tappable affordance', () => {
        const titleRuleMatch = cssSource.match(/\.sb-brand-title\s*\{[^}]*\}/);
        expect(titleRuleMatch).not.toBeNull();

        const titleRule = titleRuleMatch[0];
        expect(titleRule).toContain('cursor: pointer;');
        expect(titleRule).toContain('touch-action: manipulation;');
        expect(titleRule).toContain('-webkit-user-select: none;');
        expect(titleRule).toContain('user-select: none;');
        expect(cssSource).toContain('.sb-brand-title:focus-visible');
    });

    test('does not subtract focus padding from the visible label width', () => {
        const titleRuleMatch = cssSource.match(/\.sb-brand-title\s*\{[^}]*\}/);
        expect(titleRuleMatch).not.toBeNull();

        const titleRule = titleRuleMatch[0];
        expect(titleRule).toContain('padding: 0 6px;');
        expect(titleRule).not.toMatch(/margin:\s*-/);
    });
});

describe('icons only top bar', () => {
    const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

    function getConstSource(name) {
        const match = normalizedTabsSource.match(new RegExp(`const ${name} = [\\s\\S]*?\\n\\}\\);|const ${name} = [^\\n]*;`));
        expect(match).not.toBeNull();
        return match[0];
    }

    function getGroupOrder() {
        return new Function('TOPBAR_EXTENSION_SLOT_ID', `${getConstSource('SB_TOPBAR_GROUP_ORDER')}\nreturn SB_TOPBAR_GROUP_ORDER;`)('sb-topbar-extension-slot');
    }

    test('names the three sections and the button that opens each', () => {
        const sections = getConstSource('SB_TOPBAR_SECTIONS');

        expect([...sections.matchAll(/leadId: '([^']+)'/g)].map(match => match[1]))
            .toEqual(['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-character-toggle']);
        expect([...sections.matchAll(/shellKey: '([^']+)'/g)].map(match => match[1])).toEqual(['left', 'right', 'characters']);
    });

    test('has no page icon rails, cluster dividers or anything that kept them', () => {
        for (const removed of [
            'SB_TOPBAR_CLUSTERS', 'SB_TOPBAR_PAGE_TARGETS', 'SB_TOPBAR_ANCHOR_IDS', 'buildTopbarPageRail', 'createTopbarPageButton',
            'getTopbarPageConfig', 'syncTopbarIconsOnlyDedupe', 'syncTopbarIconsOnlyLayout', 'syncTopbarGroupOrder', 'getTopbarGroupOrder',
            'syncTopbarBrandFit', 'sb-topbar-pages', 'sb-topbar-cluster-lead', 'sb-topbar-shortcut-duplicate', 'sb-topbar-page-button',
            'data-sb-topbar-page', 'sbTopbarPage', 'sbTopbarBrandCramped', 'sbTopbarScroll', 'sb-topbar-divider-customize',
            'sb-topbar-divider-home', 'sb-topbar-divider-characters',
        ]) {
            expect(normalizedTabsSource).not.toContain(removed);
            expect(cssSource).not.toContain(removed);
            expect(mobileCss).not.toContain(removed);
        }
        expect(cssSource).not.toContain('sb-topbar-cluster-workspace');
        expect(cssSource).not.toContain('data-sb-topbar-brand-cramped');
        expect(cssSource).not.toContain('data-sb-topbar-scroll');
        expect(normalizedTabsSource).not.toContain('SB_TOPBAR_PARKED_IDS');
        expect(normalizedTabsSource).not.toContain('sb-topbar-parked');
    });

    test('keeps the shell registries that the settings sidebar reads their page icons from', () => {
        for (const entry of [
            'id: \'context\',',
            'id: \'agents\',',
            'id: \'data-security\',',
            'id: \'logs\',',
        ]) {
            expect(normalizedTabsSource).toContain(entry);
        }
        expect(normalizedTabsSource).toMatch(/id: 'editor',\s+label: 'Editor',\s+icon: 'fa-pen-to-square'/);
        expect(normalizedTabsSource).toMatch(/id: 'import',\s+label: 'Import',\s+icon: 'fa-file-import'/);
    });

    test('has one child order, the labelled bar\'s, whatever the mode or the width', () => {
        const order = getGroupOrder();

        // Backend, Customize, Search, Quick Access | title | Quick Access, Mode, Home, Characters.
        expect(order.left).toEqual([
            'sb-left-shell-toggle',
            'sb-right-shell-toggle',
            'sb-topbar-divider-search-mobile',
            'sb-topbar-search-toggle',
            'sb-topbar-divider-quick-left',
            'sb-shortcut-left',
            'sb-shortcut-slot3',
            'sb-shortcut-slot4',
        ]);
        expect(order.right).toEqual([
            'sb-topbar-extension-slot',
            'sb-shortcut-slot6',
            'sb-shortcut-slot5',
            'sb-shortcut-right',
            'sb-topbar-overflow-toggle',
            'sb-topbar-divider-quick-right',
            'sb-mode-toggle',
            'sb-topbar-divider-mode-mobile',
            'sb-home-toggle',
            'sb-character-toggle',
        ]);
        expect(new Set([...order.left, ...order.right]).size).toBe(order.left.length + order.right.length);
        for (const id of [...order.left, ...order.right]) {
            expect(id).not.toMatch(/cluster|rail|pages/);
        }

        // Nothing replays or branches on the mode: buildTopBar appends each group once from the list.
        const buildSource = getFunctionSource('buildTopBar');
        expect(buildSource).toContain('leftGroup.append(...SB_TOPBAR_GROUP_ORDER.left.map(id => controls.get(id)));');
        expect(buildSource).toContain('rightGroup.append(...SB_TOPBAR_GROUP_ORDER.right.map(id => controls.get(id)));');
        expect(getConstSource('SB_TOPBAR_GROUP_ORDER')).not.toMatch(/iconsOnly|isMobile/);
    });

    test('puts every control the order names into the bar', () => {
        const buildSource = getFunctionSource('buildTopBar');
        const controlsSource = buildSource.match(/const controls = new Map\(\[([\s\S]*?)\]\.map/)[1];
        const built = controlsSource.split(',').map(name => name.trim()).filter(Boolean);

        // Every name in the list is a control of buildTopBar, so the Map holds exactly the ids of the order.
        expect(built).toHaveLength(getGroupOrder().left.length + getGroupOrder().right.length);
        expect(new Set(built).size).toBe(built.length);
    });

    test('opens the Characters anchor as a settings page in every mode', () => {
        const activationSource = getFunctionSource('activateCharacterTopbarButton');
        expect(activationSource).toContain('toggleSettingsPage(\'characters\');');
        expect(activationSource).not.toContain('if (isTopbarIconsOnlyActive())');

        const buildSource = getFunctionSource('buildTopBar');
        expect(buildSource).toContain('activateCharacterTopbarButton,');

        // The button reads the same in both modes: no branch on the setting.
        const proxyStateSource = getFunctionSource('syncProxyButtonState');
        expect(proxyStateSource).toContain('const isCharacterButton = proxyButton.id === \'sb-character-toggle\';');
        expect(proxyStateSource).not.toContain('isTopbarIconsOnlyActive');
        expect(proxyStateSource).toContain('proxyButton.classList.toggle(\'is-open\', isOpen);');
        expect(proxyStateSource).toContain('proxyButton.classList.toggle(\'is-pinned\', isPinned);');

        expect(getFunctionSource('syncTopbarSectionButtonStates')).toContain('syncCharacterTopbarButtonState();');
        expect(getFunctionSource('observeProxyButton')).not.toContain('isTopbarIconsOnlyActive');
    });

    test('lights the open section\'s button from the settings page state', () => {
        const activeSource = getFunctionSource('syncSettingsPageActiveButton');
        expect(activeSource).toContain('for (const section of SB_TOPBAR_SECTIONS) {');
        expect(activeSource).toContain('sbSettingsState.activeShell === section.shellKey');
        expect(getFunctionSource('closeSettingsPage')).toContain('SB_TOPBAR_SECTIONS.find(section => section.shellKey === closingShell)?.leadId');
    });

    test('keeps one destination active: Home gives way to an open settings page and returns when it closes', () => {
        expect(getFunctionSource('syncHomeButtonState')).toContain('const isHomeVisible = isHomeActive() && !sbSettingsState.open;');
        // Both opening and closing a page go through this sync, so Home follows without its own listener.
        expect(getFunctionSource('syncSettingsPageActiveButton')).toContain('syncHomeButtonState();');
        expect(getFunctionSource('openSettingsPage')).toContain('syncSettingsPageActiveButton();');
        expect(getFunctionSource('closeSettingsPage')).toContain('syncSettingsPageActiveButton();');
    });

    test('marks the boundaries of Quick Access and of the phone utility buttons, in both modes', () => {
        expect(normalizedTabsSource).toContain('function createTopbarClusterDivider(');

        const baseRule = cssSource.match(/\.sb-topbar-cluster-divider \{[^}]*\}/);
        expect(baseRule).not.toBeNull();
        expect(baseRule[0]).toContain('display: none;');
        expect(baseRule[0]).toContain('width: 0;');
        expect(baseRule[0]).toContain('border-inline-start: 1px solid var(--sb-shell-border);');

        // The rule shows because a side has a Quick Access button, never because of the setting.
        expect(cssSource).toMatch(/> #sb-topbar-divider-quick-left,\n\.sb-topbar-group-right:has\([^\n]*> #sb-topbar-divider-quick-right \{\n\s*display: inline-block;\n\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-icons-only='true'\][^{]*\.sb-topbar-cluster-divider/);
        expect(mobileCss).toMatch(/\.sb-topbar-cluster-divider \{\n\s*height: calc\(var\(--sb-mobile-toggle-size\) \* 0\.5\);\n\s*\}/);
    });

    test('holds three tracks in CSS, with the groups never narrower than their controls', () => {
        const innerRule = cssSource.match(/#sb-topbar-inner \{[^}]*\}/)[0];
        expect(innerRule).toContain('grid-template-columns: minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr);');
        expect(innerRule).toContain('min-width: 0;');
        expect(cssSource).toMatch(/#sb-topbar-primary \{[^}]*min-width: 0;/);
        expect(cssSource).toMatch(/#sb-topbar-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);

        // One grid for every width: the phone sheet does not define a second one.
        expect(mobileCss).not.toMatch(/#sb-topbar-inner \{[^}]*grid-template-columns/);
        expect(cssSource).not.toMatch(/\.sb-topbar-group-right \{[^}]*flex-wrap: wrap/);
        expect(cssSource).toMatch(/\.sb-topbar-group \{[^}]*flex-wrap: nowrap;/);
        for (const rule of cssSource.match(/\.sb-topbar-group(-left|-right)? \{[^}]*\}/g)) {
            expect(rule).not.toMatch(/overflow/);
        }
    });

    test('truncates the title with an ellipsis before anything else gives way', () => {
        const brandRule = cssSource.match(/^\.sb-topbar-brand \{[^}]*\}/m)[0];
        expect(brandRule).toContain('min-width: 0;');
        expect(brandRule).toContain('max-width: 100%;');
        expect(brandRule).toContain('overflow: hidden;');

        const titleRule = cssSource.match(/\.sb-brand-title \{[^}]*\}/)[0];
        expect(titleRule).toContain('display: block;');
        expect(titleRule).toContain('overflow: hidden;');
        expect(titleRule).toContain('text-overflow: ellipsis;');
        expect(titleRule).toContain('white-space: nowrap;');
    });

    test('draws the title as the Title role on every viewport', () => {
        const titleRule = cssSource.match(/\.sb-brand-title \{[^}]*\}/)[0];
        expect(titleRule).toContain('font-size: var(--sb-type-title);');
        expect(titleRule).toContain('font-weight: var(--sb-weight-title);');
        expect(titleRule).toContain('border-radius: var(--sb-radius-control);');
        expect(cssSource).not.toContain('.sb-brand-title.is-chat');
        expect(mobileCss).not.toContain('.sb-brand-title');
        expect(cssSource.match(/\.sb-brand-title[^{]*\{[^}]*font-size/g)).toHaveLength(1);
    });

    test('hides the title through one attribute and a two-track grid', () => {
        expect(cssSource).toMatch(/:root\[data-sb-topbar-title='hidden'\] #sb-topbar-inner \{\n\s*grid-template-columns: minmax\(min-content, 1fr\) minmax\(min-content, 1fr\);\n\}/);
        expect(cssSource).toMatch(/:root\[data-sb-topbar-title='hidden'\] \.sb-topbar-brand \{\n\s*display: none;\n\}/);
        // It is not hidden on phones by CSS: phones decide by width like every other viewport.
        expect(mobileCss).not.toMatch(/\.sb-topbar-brand/);
    });

    test('gives the controls the Control radius, flat at rest and neutral when on', () => {
        const buttonRule = cssSource.match(/\.sb-proxy-button \{[^}]*\}/)[0];
        expect(buttonRule).toContain('border-radius: var(--sb-shell-control-radius);');
        expect(buttonRule).toContain('background: transparent;');
        expect(mobileCss).not.toMatch(/#sb-topbar-primary \.sb-proxy-button \{[^}]*sb-radius-pill/);
        expect(mobileCss).toMatch(/#sb-topbar-primary \.sb-proxy-button \{[^}]*border-radius: var\(--sb-radius-control\) !important;/);

        // On: a neutral fill, with Accent on the icon only.
        expect(cssSource).toMatch(/\.sb-proxy-button\.is-open,\n\.sb-proxy-button\.is-active,\n\.sb-proxy-button\.is-current,\n\.sb-proxy-button\.sb-settings-active \{\n\s*background: var\(--sb-flat-selected-bg\);/);
        expect(cssSource).toMatch(/\.sb-proxy-button\.sb-settings-active i \{\n\s*color: var\(--color-primary, var\(--sb-accent\)\);/);
        expect(cssSource).not.toMatch(/\.sb-proxy-button\.sb-settings-active \{\n\s*color:/);
    });

    test('draws the icons-only bar by the same button sizes as the labelled one', () => {
        expect(cssSource).toMatch(/#sb-topbar-inner \.sb-proxy-button-icon-only \{\n\s*width: var\(--sb-proxy-button-height\);\n\s*min-width: var\(--sb-proxy-button-height\);\n\}/);
        expect(cssSource).toMatch(/:root:is\(\[data-sb-topbar-icons-only='true'\], \[data-sb-topbar-labels='off'\]\) #sb-topbar-inner \.sb-proxy-button span \{\n\s*display: none;\n\}/);
        // Phones size every bar button themselves.
        expect(mobileCss).toMatch(/#sb-topbar-primary \.sb-proxy-button span \{\n\s*display: none !important;/);
        // Backend stays on a phone in both modes.
        expect(mobileCss).not.toContain('#sb-left-shell-toggle {\n        display: none;');
    });

    test('keeps search as a permanent top bar button in every mode', () => {
        // Search left the Quick Access slots for a fixed top bar button, so the default right
        // slot is free for Extensions while users can still assign Search to any slot.
        expect(normalizedTabsSource).not.toContain('SB_TOPBAR_SEARCH_TARGET');
        expect(getGroupOrder().left).toContain('sb-topbar-search-toggle');
        expect(cssSource).toContain('#sb-topbar-search-toggle');
        expect(normalizedTabsSource).toContain('right: \'right:extensions\',');
        expect(normalizedTabsSource).toContain('{ value: \'action:search\', label: \'Search\', icon: \'fa-magnifying-glass\' },');
    });

    test('keeps Quick Access fully live in both modes and refits when a slot is reassigned', () => {
        expect(normalizedTabsSource).not.toContain('.sb-shortcut-rows\')?.classList.toggle(\'is-disabled\'');
        expect(cssSource).not.toContain('.sb-shortcut-rows.is-disabled');

        const updateSource = getFunctionSource('updateShortcutButton');
        expect(updateSource).not.toContain('syncTopbarIconsOnlyDedupe');
        expect(updateSource).toContain('queueTopbarFit();');
    });

    test('mounts the toggle in the Desktop group only', () => {
        // Geechan review: nesting it inside the Quick Access Shortcuts drawer is a nested menu,
        // and the desktop navigation options are where a top bar layout option is intuitively expected. The phone bar
        // never has labels, so a phone switch would change nothing.
        const rowSource = getFunctionSource('createTopbarIconsOnlyRow');
        expect(rowSource).toContain('id: \'sb-desktop-topbar-icons-only-input\',');
        expect(rowSource).toContain('label: \'Icons only top bar\',');
        expect(rowSource).toContain('subtitle: \'Show only icons in the desktop top bar.\',');
        expect(rowSource).toContain('onChange: checked => setTopbarIconsOnly(\'desktop\', checked),');
        expect(rowSource).not.toContain('\'mobile\'');
        expect(normalizedTabsSource).toContain('const desktopBody = createInterfaceGroupBody(\'sb-desktop-settings-outlet\', [\n        createTopbarIconsOnlyRow(),');

        expect(normalizedTabsSource).not.toContain('createTopbarIconsOnlySettingsGroup');
        expect(normalizedTabsSource).not.toContain('createMobileNavLayoutSettingsGroup');
        expect(normalizedTabsSource).not.toContain('createDesktopNavLayoutSettingsGroup');
        expect(normalizedTabsSource).not.toContain('createNavigationSettingsGroup');
        expect(normalizedTabsSource).not.toContain('sb-mobile-topbar-icons-only-input');
        expect(normalizedTabsSource).not.toContain('Show page icons in the');
        expect(normalizedTabsSource.match(/createTopbarIconsOnlyRow\(/g)).toHaveLength(2);
        expect(getFunctionSource('createShortcutSettingsGroup')).toContain('group.append(...rows);');
        expect(normalizedTabsSource.match(/'Icons only top bar'/g)).toHaveLength(1);
    });

    test('stores the toggle per device and applies only the active viewport\'s setting', () => {
        // A phone value stored by an earlier build is still read and kept; no control writes it.
        expect(normalizedTabsSource).toContain('desktopTopbarIconsOnly: \'sb-desktop-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('mobileTopbarIconsOnly: \'sb-mobile-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('function setTopbarIconsOnly(mode, enabled');

        const activeSource = getFunctionSource('isTopbarIconsOnlyActive');
        expect(activeSource).toContain('isMobileViewport() ? sbState.topbarIconsOnly.mobile : sbState.topbarIconsOnly.desktop');

        // Crossing the breakpoint can change which device's setting is in force.
        const listenerMatch = normalizedTabsSource.match(/window\.matchMedia\(SB_MOBILE_MEDIA_QUERY\)\.addEventListener\('change', \(\) => \{[\s\S]*?\}\);/);
        expect(listenerMatch).not.toBeNull();
        expect(listenerMatch[0]).toContain('applyTopbarIconsOnlyPreference();');

        // The one checkbox reflects the desktop value, not the viewport-active state.
        expect(normalizedTabsSource).not.toContain('data-sb-topbar-icons-only-input');
        expect(normalizedTabsSource).toContain('topbarIconsOnlyInput.checked = sbState.topbarIconsOnly.desktop;');
    });

    test('seeds both devices from the legacy single toggle key', () => {
        // The pre-split key stays as a read-only fallback so an existing choice carries over.
        const readSource = getFunctionSource('readTopbarIconsOnlySetting');
        expect(readSource).toContain('safeGetItem(SB_STORAGE_KEYS.topbarIconsOnly)');
        expect(normalizedTabsSource).toContain('desktop: readTopbarIconsOnlySetting(SB_STORAGE_KEYS.desktopTopbarIconsOnly),');
        expect(normalizedTabsSource).toContain('mobile: readTopbarIconsOnlySetting(SB_STORAGE_KEYS.mobileTopbarIconsOnly),');
        // But nothing writes it back; the per-device keys are the live state.
        expect(normalizedTabsSource).not.toContain('safeSetItem(SB_STORAGE_KEYS.topbarIconsOnly,');
    });

    test('no longer ships the removed shell tab icon-only setting', () => {
        expect(normalizedTabsSource).toContain('topbarIconsOnly: \'sb-topbar-icons-only\',');
        expect(normalizedTabsSource).not.toContain('desktopNavIconOnly');
        expect(normalizedTabsSource).not.toContain('mobileNavIconOnly');
        expect(normalizedTabsSource).not.toContain('Icons only in shell tabs');
        expect(normalizedTabsSource).not.toContain('setMobileNavIconOnly');
        expect(normalizedTabsSource).not.toContain('setDesktopNavIconOnly');
    });

    test('clears stale retired navigation presentation state before building the top bar', () => {
        const attributesMatch = normalizedTabsSource.match(/const SB_LEGACY_NAVIGATION_DATA_ATTRIBUTES = Object\.freeze\(\[[\s\S]*?\n\]\);/);
        expect(attributesMatch).not.toBeNull();

        for (const attribute of [
            'data-sb-mobile-nav-layout',
            'data-sb-mobile-nav-mode',
            'data-sb-mobile-nav-customize',
            'data-sb-mobile-nav-quick-actions',
            'data-sb-mobile-nav-replacement',
            'data-sb-desktop-nav-layout',
            'data-sb-desktop-nav-mode',
            'data-sb-desktop-nav-customize',
            'data-sb-desktop-nav-quick-actions',
            'data-sb-desktop-nav-replacement',
        ]) {
            expect(attributesMatch[0]).toContain(`'${attribute}'`);
        }

        expect(attributesMatch[0]).not.toContain('data-sb-topbar-icons-only');
        expect(normalizedTabsSource).toContain('function migrateLegacyNavigationState()');
        expect(normalizedTabsSource).toContain('root.removeAttribute(attribute);');
        expect(normalizedTabsSource).toContain('restorePersistedTopbarState();\n    migrateLegacyNavigationState();\n    seedTopbarScaleDefaults();');
    });

    test('toggles state without rebuilding the top bar, and writes no value for the setting\'s other keys', () => {
        const setterSource = getFunctionSource('setTopbarIconsOnly');
        expect(setterSource).not.toContain('buildTopBar(');
        expect(setterSource).toContain('isDesktop ? SB_STORAGE_KEYS.desktopTopbarIconsOnly : SB_STORAGE_KEYS.mobileTopbarIconsOnly');
        expect(setterSource).toContain('updateThemePickerUi();');
        expect(normalizedTabsSource).toContain('sbState.topbarIconsOnly.desktop = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopTopbarIconsOnly), sbState.topbarIconsOnly.desktop);');
        expect(normalizedTabsSource).toContain('sbState.topbarIconsOnly.mobile = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileTopbarIconsOnly), sbState.topbarIconsOnly.mobile);');

        // The fit never writes a stored setting: it only sets attributes of the root.
        const fitSource = [getFunctionSource('fitTopbar'), getFunctionSource('setTopbarFitState'), getFunctionSource('resolveTopbarFit')].join('\n');
        expect(fitSource).not.toMatch(/safeSetItem|localStorage|setTopbarIconsOnly/);
    });

    test('keeps the character toggle measurable for anchored extension dropdowns', () => {
        const applySource = getFunctionSource('applyTopbarIconsOnlyPreference');
        expect(applySource).toContain('scheduleCharacterToggleGhostSync();');
        expect(applySource).not.toContain('style.display');
    });

    test('keeps button touch handlers off WebKit slow path', () => {
        // A non-passive touchstart on every button pulls WebKit off compositor scrolling, which
        // stalls scrolling on iOS. The handler only stops propagation, so passive is correct.
        const propagationSource = getFunctionSource('stopProxyPointerPropagation');
        expect(propagationSource).toContain('element.addEventListener(\'touchstart\', stop, { passive: true });');
        expect(propagationSource).toContain('stopPropagation');
    });
});

describe('top bar fit', () => {
    const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
    const resolve = new Function('SB_TOPBAR_BRAND_MIN_WIDTH', `${getFunctionSource('resolveTopbarFit')}\nreturn resolveTopbarFit;`)(60);

    // Natural widths of the groups in each form: labelled, icons only, icons only with the overflow button.
    const FORMS = {
        labelled: { start: 340, end: 340, title: 400 },
        icons: { start: 190, end: 190, title: 400 },
        overflow: { start: 90, end: 140, title: 400 },
    };
    const run = (available, { forced = false, canOverflow = true, forms = FORMS, gap = 10 } = {}) => {
        const asked = [];
        const verdict = resolve({
            available,
            gap,
            labelsForcedOff: forced,
            canOverflow,
            measure: step => {
                asked.push(step);
                return forms[step.overflow ? 'overflow' : step.labelsOff ? 'icons' : 'labelled'];
            },
        });
        return { verdict, asked };
    };

    test('keeps the labelled bar with its title while everything fits', () => {
        expect(run(1000).verdict).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
        // 340 + 340 + 2 gaps + the 60px a title needs
        expect(run(760).verdict).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
    });

    test('drops the labels as soon as the labelled bar leaves too little for the title, and keeps the title', () => {
        expect(run(759).verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
        // 190 + 190 + 2 gaps + 60
        expect(run(460).verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
    });

    test('hides the title only after the labels, when less than a few characters of it would show', () => {
        expect(run(459).verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: true });
        // Two tracks and one gap: the icons alone still fit.
        expect(run(390).verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: true });
    });

    test('moves Quick Access into the overflow menu last, with the title still hidden', () => {
        expect(run(389).verdict).toEqual({ labelsOff: true, overflow: true, titleHidden: true });
        expect(run(240).verdict).toEqual({ labelsOff: true, overflow: true, titleHidden: true });
    });

    test('never shows a labelled bar without its title', () => {
        const offenders = [];
        for (let available = 150; available <= 1200; available++) {
            for (const forced of [false, true]) {
                const verdict = run(available, { forced }).verdict;
                if (verdict.labelsOff === false && verdict.titleHidden) {
                    offenders.push(`${available}px, forced ${forced}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('goes only further as the bar narrows, one width after the other', () => {
        // 0 overflow, 1 icons without the title, 2 icons with it, 3 labels with it.
        const stepOf = ({ labelsOff, overflow, titleHidden }) => {
            if (overflow) {
                return titleHidden ? 0 : -1;
            }
            if (labelsOff) {
                return titleHidden ? 1 : 2;
            }
            return titleHidden ? -1 : 3;
        };
        for (const options of [{}, { forced: true }, { canOverflow: false }, { forms: { ...FORMS, labelled: { start: 340, end: 340, title: 40 } } }]) {
            const steps = [];
            for (let available = 150; available <= 1200; available++) {
                steps.push(stepOf(run(available, options).verdict));
            }
            expect({ options, outside: steps.filter(step => step < 0) }).toEqual({ options, outside: [] });
            expect({ options, back: steps.filter((step, index) => index > 0 && step < steps[index - 1]) }).toEqual({ options, back: [] });
        }
    });

    test('reads each form once and stops at the first one that fits', () => {
        expect(run(1000).asked).toEqual([{ labelsOff: false, overflow: false }]);
        expect(run(500).asked).toEqual([{ labelsOff: false, overflow: false }, { labelsOff: true, overflow: false }]);
        // The icons-only reading answers both whether the title fits and whether the bar fits without it.
        expect(run(420).asked).toEqual([{ labelsOff: false, overflow: false }, { labelsOff: true, overflow: false }]);
        expect(run(200).asked).toEqual([{ labelsOff: false, overflow: false }, { labelsOff: true, overflow: false }]);
    });

    test('starts at the icons-only form when the setting turns the labels off', () => {
        expect(run(1000, { forced: true }).verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
        expect(run(1000, { forced: true }).asked).toEqual([{ labelsOff: true, overflow: false }]);
        expect(run(389, { forced: true }).verdict).toEqual({ labelsOff: true, overflow: true, titleHidden: true });
    });

    test('offers no overflow menu where there is nothing to put in it', () => {
        const { verdict, asked } = run(200, { canOverflow: false });
        expect(verdict).toEqual({ labelsOff: true, overflow: false, titleHidden: true });
        expect(asked.some(step => step.overflow)).toBe(false);
    });

    test('shows a title shorter than the minimum as soon as all of it fits', () => {
        const forms = { ...FORMS, labelled: { start: 340, end: 340, title: 40 } };
        expect(run(740, { forms }).verdict).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
        expect(run(739, { forms }).verdict.labelsOff).toBe(true);
    });

    test('takes the verdict from natural widths, never from the state on screen', () => {
        const fitSource = getFunctionSource('fitTopbar');
        // The forms are applied for the reading and then replaced by the verdict, in one task.
        expect(fitSource).toContain('setTopbarFitState({ ...step, titleHidden: false });');
        expect(fitSource).toContain('setTopbarFitState(verdict);');
        expect(fitSource).toContain('const labelsForcedOff = isTopbarIconsOnlyActive();');
        expect(fitSource).toContain('canOverflow: !isMobileViewport() && getTopbarQuickAccessTargets().length > 0,');
    });

    test('is driven by one observer and no resize listener', () => {
        expect(normalizedTabsSource.match(/new ResizeObserver\(queueTopbarFit\)/g)).toHaveLength(1);
        expect(normalizedTabsSource).not.toContain('addEventListener(\'resize\', queueTopbarFit');
        expect(getFunctionSource('buildTopBar')).toContain('observeTopbarFit();');
    });

    test('hides the Quick Access buttons and shows the overflow button through one attribute', () => {
        expect(cssSource).toMatch(/#sb-topbar-overflow-toggle \{\n\s*display: none;\n\}/);
        expect(cssSource).toMatch(/:root\[data-sb-topbar-overflow='true'\] #sb-topbar-overflow-toggle \{\n\s*display: inline-flex;\n\}/);
        const hide = cssSource.match(/:root\[data-sb-topbar-overflow='true'\] :is\(([^)]*)\) \{\n\s*display: none;/)[1];
        for (const id of ['sb-shortcut-left', 'sb-shortcut-slot3', 'sb-shortcut-slot4', 'sb-shortcut-slot5', 'sb-shortcut-slot6', 'sb-shortcut-right']) {
            expect(hide).toContain(`#${id}`);
        }
        expect(mobileCss).not.toContain('sb-topbar-overflow');
    });

    test('names the overflow button after what it holds and lists the Quick Access targets', () => {
        const buildSource = getFunctionSource('buildTopBar');
        expect(buildSource).toContain('id: \'sb-topbar-overflow-toggle\',');
        expect(buildSource).toContain('icon: \'fa-ellipsis-vertical\',');
        expect(buildSource).toContain('title: getTopbarOverflowLabel(),');
        expect(buildSource).toContain('overflowToggle.setAttribute(\'aria-haspopup\', \'menu\');');
        expect(getFunctionSource('getTopbarOverflowLabel')).toContain('return t`Quick Access`;');
        expect(normalizedTabsSource).not.toContain('Actions for ${\'Quick Access\'}');

        const menuSource = getFunctionSource('openTopbarOverflowMenu');
        expect(menuSource).toContain('openActionMenu({ trigger, title: getTopbarOverflowLabel(), sections: [{ items }] });');
        expect(menuSource).toContain('onSelect: () => activateShortcutTarget(target),');
    });
});
