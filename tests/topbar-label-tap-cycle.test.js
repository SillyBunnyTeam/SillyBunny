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

describe('topbar label tap cycle', () => {
    test('keeps preview cycle state transient', () => {
        expect(tabsSource).toContain('const SB_TOPBAR_LABEL_CYCLE_RESET_MS = 5000;');
        expect(tabsSource).toContain('cyclePart: \'\'');
        expect(tabsSource).toContain('cycleResetTimer: 0');
        expect(tabsSource).toContain('function resetTopBarLabelCycle');
        expect(tabsSource).toContain('window.clearTimeout(sbState.topbarLabel.cycleResetTimer);');
    });

    test('cycles configured, context size, character name, and custom text when applicable', () => {
        const cyclePartsSource = getFunctionSource('getTopbarLabelCycleParts');
        expect(cyclePartsSource).toContain('const cycleParts = [\'\', \'ctx\', \'char\'];');
        expect(cyclePartsSource).toContain('if (sbState.topbarLabel.customText)');
        expect(cyclePartsSource).toContain('cycleParts.push(\'custom\');');

        const cycleSource = getFunctionSource('cycleTopBarLabel');
        expect(cycleSource).toContain('const nextPart = cycleParts[nextIndex % cycleParts.length];');
        expect(cycleSource).toContain('if (nextPart === \'ctx\')');
        expect(cycleSource).toContain('scheduleTopbarContextRefresh(0);');
    });

    test('renders preview labels without changing configured label settings', () => {
        const labelSource = getFunctionSource('getTopBarLabel');
        expect(labelSource).toContain('const previewPart = normalizeTopbarLabelPart(sbState.topbarLabel.cyclePart, \'\');');
        expect(labelSource).toContain('return getTopBarLabelPreviewText(previewPart, context);');

        const previewSource = getFunctionSource('getTopBarLabelPreviewText');
        expect(previewSource).toContain('if (normalizedPart === \'ctx\')');
        expect(previewSource).toContain('return \'...\';');
        expect(previewSource).toContain('return getTopbarLabelPartOption(normalizedPart)?.label ?? \'\';');
    });

    test('flushes configured label settings immediately after storage writes', () => {
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts, JSON.stringify(sbState.topbarLabel.desktopParts));\n    flushSbStorageWrites();');
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelMobilePart, nextPart);\n    flushSbStorageWrites();');
        expect(normalizedTabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelCustomText, nextText);\n    flushSbStorageWrites();');
    });

    test('binds accessible pointer and keyboard activation on the title', () => {
        const bindSource = getFunctionSource('bindTopBarTitleCycle');
        expect(bindSource).toContain('title.addEventListener(\'click\'');
        expect(bindSource).toContain('title.addEventListener(\'keydown\'');
        expect(bindSource).toContain('event.key !== \'Enter\' && event.key !== \' \'');
        expect(bindSource).toContain('event.preventDefault();');
        expect(bindSource).toContain('handleTopBarTitleActivation();');

        expect(tabsSource).toContain('role="button"');
        expect(tabsSource).toContain('tabindex="0"');
        expect(tabsSource).toContain('title.setAttribute(\'aria-label\'');
    });

    test('title activation respects the click-to-cycle toggle', () => {
        const activationSource = getFunctionSource('handleTopBarTitleActivation');
        expect(activationSource).toContain('if (sbState.topbarLabel.clickCycle)');
        expect(activationSource).toContain('cycleTopBarLabel();');
        expect(activationSource).toContain('returnToChatSurface();');

        const returnSource = getFunctionSource('returnToChatSurface');
        expect(returnSource).toContain('closeShell(\'left\');');
        expect(returnSource).toContain('closeShell(\'right\');');
        expect(returnSource).toContain('closeCharacterPanel();');
        expect(returnSource).not.toContain('closeCurrentChat');

        const setterSource = getFunctionSource('setTopbarLabelClickCycle');
        expect(setterSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarLabelClickCycle, String(nextValue));');
        expect(setterSource).toContain('resetTopBarLabelCycle({ refresh: false });');
        expect(tabsSource).toContain('topbarLabelClickCycle: \'sb-topbar-label-click-cycle\'');
        expect(tabsSource).toContain('normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.topbarLabelClickCycle), true)');
    });

    test('resets preview on chat and context-changing events', () => {
        const resetEventsMatch = tabsSource.match(/const resetCycleEvents = new Set\(\[[\s\S]*?\]\.filter\(Boolean\)\);/);
        expect(resetEventsMatch).not.toBeNull();

        const resetEventsSource = resetEventsMatch[0];
        expect(resetEventsSource).toContain('eventTypes.CHAT_CHANGED');
        expect(resetEventsSource).toContain('eventTypes.CHAT_CREATED');
        expect(resetEventsSource).toContain('eventTypes.GROUP_CHAT_CREATED');
        expect(resetEventsSource).toContain('eventTypes.MAIN_API_CHANGED');
        expect(tabsSource).toContain('resetTopBarLabelCycle({ refresh: false });');
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
        expect(cssSource).toContain('.sb-brand-title.is-previewing');
    });

    test('does not subtract focus padding from the visible label width', () => {
        const titleRuleMatch = cssSource.match(/\.sb-brand-title\s*\{[^}]*\}/);
        expect(titleRuleMatch).not.toBeNull();

        const titleRule = titleRuleMatch[0];
        expect(titleRule).toContain('margin: -2px 0;');
        expect(titleRule).toContain('padding: 2px 6px;');
        expect(titleRule).not.toContain('margin: -2px -6px;');
    });
});

describe('icons only top bar', () => {
    const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

    function getClustersSource() {
        const match = normalizedTabsSource.match(/const SB_TOPBAR_CLUSTERS = Object\.freeze\(\[[\s\S]*?\n\]\);/);
        expect(match).not.toBeNull();
        return match[0];
    }

    test('expands each layer 2 anchor into its own cluster', () => {
        // The bar is not a flat strip: every anchor keeps its prescribed slot and grows a cluster
        // of that section's own pages beside it, in the PRODUCT.md left-to-right order.
        const clustersSource = getClustersSource();
        const leadIds = [...clustersSource.matchAll(/leadId: '([^']+)'/g)].map(match => match[1]);

        expect(leadIds).toEqual(['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-character-toggle']);
        expect([...clustersSource.matchAll(/key: '([^']+)'/g)].map(match => match[1]))
            .toEqual(['workspace', 'customize', 'characters']);
    });

    test('keeps every requested page in its canonical cluster order', () => {
        const pageLists = [...getClustersSource().matchAll(/pages: Object\.freeze\(\[([\s\S]*?)\]\),/g)]
            .map(match => [...match[1].matchAll(/value: '([^']+)'/g)].map(pageMatch => pageMatch[1]));

        expect(pageLists).toEqual([
            ['left:presets', 'left:api', 'left:sampling', 'left:advanced-formatting', 'left:agents'],
            ['right:settings', 'right:extensions', 'right:background', 'right:server', 'right:console-logs'],
            ['characters:groups', 'characters:editor', 'characters:world-info', 'characters:persona', 'characters:import'],
        ]);
    });

    test('derives page labels and icons from the shell registries', () => {
        const clustersSource = getClustersSource();
        expect(clustersSource).not.toContain('label:');
        expect(clustersSource).not.toContain('icon:');
        expect(normalizedTabsSource).toContain('const SB_TOPBAR_PAGE_TARGETS = Object.freeze(SB_TOPBAR_CLUSTERS.flatMap(cluster => cluster.pages));');

        const configSource = getFunctionSource('getTopbarPageConfig');
        expect(configSource).toContain('getCharacterPanelTabConfig(page.tabId)');
        expect(configSource).toContain('getShellConfig(page.shellKey)');

        const buttonSource = getFunctionSource('createTopbarPageButton');
        expect(buttonSource).toContain('icon: config?.icon ?? \'fa-circle-dot\'');
        for (const entry of [
            "id: 'advanced-formatting',",
            "id: 'agents',",
            "id: 'server',",
            "id: 'console-logs',",
            "{ id: 'editor', label: 'Editor', icon: 'fa-pen-to-square' }",
            "{ id: 'import', label: 'Import', icon: 'fa-file-import' }",
        ]) {
            expect(normalizedTabsSource).toContain(entry);
        }
    });

    test('hides only redundant section anchors in icons-only mode and parks nothing', () => {
        const anchorMatch = normalizedTabsSource.match(/const SB_TOPBAR_ANCHOR_IDS = Object\.freeze\(\[[\s\S]*?\]\);/);
        expect(anchorMatch).not.toBeNull();

        for (const anchorId of ['sb-home-toggle', 'sb-character-toggle']) {
            expect(anchorMatch[0]).toContain(`'${anchorId}'`);
        }
        for (const anchorId of ['sb-left-shell-toggle', 'sb-right-shell-toggle']) {
            expect(anchorMatch[0]).not.toContain(`'${anchorId}'`);
        }

        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-left-shell-toggle,\n:root\[data-sb-topbar-icons-only='true'\] #sb-right-shell-toggle \{\n\s*display: none;\n\}/);
        expect(mobileCss).toContain(":root:not([data-sb-topbar-icons-only='true'])[data-sb-mobile-nav-layout='horizontal'][data-sb-mobile-nav-customize='shown'] #sb-left-shell-toggle");
        expect(mobileCss).toContain(":root:not([data-sb-topbar-icons-only='true'])[data-sb-mobile-nav-replacement='shown'] #sb-left-shell-toggle");

        // The parking machinery and its bay are gone entirely.
        expect(normalizedTabsSource).not.toContain('SB_TOPBAR_PARKED_IDS');
        expect(normalizedTabsSource).not.toContain('rememberTopbarGroupOrder');
        expect(normalizedTabsSource).not.toContain('sb-topbar-parked');
        expect(cssSource).not.toContain('#sb-topbar-parked');
    });

    test('uses the Characters anchor as a page only in icons-only mode', () => {
        const activationSource = getFunctionSource('activateCharacterTopbarButton');
        expect(activationSource).toContain('if (isTopbarIconsOnlyActive())');
        expect(activationSource).toContain('openCharacterPanelTab(SB_CHARACTER_PANEL_DEFAULT_TAB);');
        expect(activationSource).toContain('toggleCharacterPanel();');

        const buildSource = getFunctionSource('buildTopBar');
        expect(buildSource).toContain('activateCharacterTopbarButton,');

        const proxyStateSource = getFunctionSource('syncProxyButtonState');
        expect(proxyStateSource).toContain("const isCharacterButton = proxyButton.id === 'sb-character-toggle';");
        expect(proxyStateSource).toContain('if (isCharacterButton && isTopbarIconsOnlyActive())');
        expect(proxyStateSource).toContain('isCharacterPanelTabOpen(SB_CHARACTER_PANEL_DEFAULT_TAB)');
        expect(proxyStateSource).toContain("proxyButton.classList.remove('is-open', 'is-pinned');");
        expect(proxyStateSource).toContain("proxyButton.classList.toggle('is-current', isCurrent);");
        expect(proxyStateSource).toContain("proxyButton.classList.toggle('is-open', isOpen);");
        expect(proxyStateSource).toContain("proxyButton.classList.toggle('is-pinned', isPinned);");

        const pageStateSource = getFunctionSource('syncTopbarPageButtonStates');
        expect(pageStateSource).toContain('syncCharacterTopbarButtonState();');
    });

    test('clears shell page highlights after native drawer dismissal only in icons-only mode', () => {
        const activeStateSource = getFunctionSource('isTopbarPageActive');
        expect(activeStateSource).toContain('isShellTabOpen(page.shellKey, page.tabId)');

        const shellTabSource = getFunctionSource('isShellTabOpen');
        expect(shellTabSource).toContain('isShellOpen(shellKey) && shellState.activeTabId === tabId');

        const observerSource = getFunctionSource('observeProxyButton');
        expect(observerSource).toContain('syncProxyButtonState(proxyButton, sourceIcon);');
        expect(observerSource).toContain('if (isTopbarIconsOnlyActive()) {\n            queueTopbarPageStateSync();\n        }');
    });

    test('keeps one canonical button order per mode instead of moving buttons around', () => {
        // appendChild on a node the group already holds is a move, so replaying a whole order is
        // idempotent -- unlike remembering a nextSibling that a neighbouring move can detach.
        const orderSource = getFunctionSource('getTopbarGroupOrder');
        const replaySource = getFunctionSource('syncTopbarGroupOrder');

        expect(orderSource).toContain('const [workspace, customize, characters] = SB_TOPBAR_CLUSTERS;');
        expect(replaySource).toContain('group.appendChild(element);');
        expect(normalizedTabsSource).not.toContain('syncTopbarRightClusterOrder');
        expect(normalizedTabsSource).not.toContain('syncTopbarRailSplit');

        // Right half follows PRODUCT.md Layer 2: quick access, then Home, then Characters.
        const homeIndex = orderSource.indexOf('\'sb-home-toggle\'');
        expect(orderSource.indexOf('quickAccessIds')).toBeLessThan(homeIndex);
        expect(homeIndex).toBeLessThan(orderSource.indexOf('characters.leadId'));
    });

    test('leaves the button sequence unchanged when the option is off', () => {
        // The clusters are display:none while the mode is off, so the "off" order has to reproduce
        // the bar exactly as it has always been -- toggling must not reshuffle anything else.
        const orderSource = getFunctionSource('getTopbarGroupOrder');
        expect(orderSource).toContain('left.push(\'sb-shortcut-left\', \'sb-shortcut-slot3\', \'sb-shortcut-slot4\');');
        expect(orderSource).toContain('right.push(\'sb-shortcut-slot6\', \'sb-shortcut-slot5\', \'sb-shortcut-right\');');
        expect(cssSource).toMatch(/\.sb-topbar-pages \{\n(?:[^}]*\n)?\s*display: none;/);
    });

    test('folds the characters cluster left on phones only', () => {
        // The right group is pinned at its natural width in the overflow state, so on a phone a
        // four-icon right cluster would starve the scrolling left strip.
        const orderSource = getFunctionSource('getTopbarGroupOrder');
        expect(orderSource).toContain('if (iconsOnly && mobile) {');
        expect(orderSource).toContain('left.push(\'sb-topbar-divider-characters\', characters.railId);');
        expect(orderSource).toContain('right.push(\'sb-topbar-divider-characters\', characters.leadId, characters.railId);');
        expect(getFunctionSource('syncTopbarGroupOrder')).toContain('mobile: isMobileViewport(),');
        expect(normalizedTabsSource).toContain('window.matchMedia(SB_MOBILE_MEDIA_QUERY).addEventListener(\'change\'');
    });

    test('marks the cluster boundaries at every size while the mode is on', () => {
        // A 1px theme-derived rule marks where one cluster ends and the next begins --
        // Workspace|Customize on the left half, Home|Characters on the right -- with or without
        // the brand label between them.
        expect(normalizedTabsSource).toContain('function createTopbarClusterDivider(');
        const orderSource = getFunctionSource('getTopbarGroupOrder');
        expect(orderSource).toContain('\'sb-topbar-divider-customize\',');
        expect(orderSource).toContain('right.push(\'sb-home-toggle\', \'sb-topbar-divider-home\');');

        const baseRule = cssSource.match(/\.sb-topbar-cluster-divider \{[^}]*\}/);
        expect(baseRule).not.toBeNull();
        expect(baseRule[0]).toContain('display: none;');
        expect(baseRule[0]).toContain('width: 1px;');
        expect(baseRule[0]).toContain('background: var(--sb-shell-border);');

        // Gated on the mode itself, not on the label being squeezed out.
        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] \.sb-topbar-cluster-divider \{\n\s*display: inline-block;\n\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-brand-cramped='true'\] [^{]*\.sb-topbar-cluster-divider/);

        // The home divider owns Home|Characters everywhere; the characters divider is the phone
        // strip's marker, so desktop hides it or the boundary would carry a double rule.
        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-divider-characters \{\n\s*display: none;\n\}/);
        expect(mobileCss).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-divider-characters \{\n\s*display: inline-block;\n\s*\}/);

        // The divider takes over the seam so it sits centred in it; phones shorten the rule to
        // their smaller squares and keep the Home|Characters boundary marked in every mode.
        expect(cssSource).toContain('.sb-topbar-cluster-divider + .sb-topbar-cluster-lead');
        expect(mobileCss).toMatch(/\.sb-topbar-cluster-divider \{\n\s*height: calc\(var\(--sb-mobile-toggle-size\) \* 0\.5\);\n\s*\}/);
        expect(mobileCss).toMatch(/#sb-topbar-divider-home \{\n\s*display: inline-block;\n\s*\}/);
    });

    test('separates the clusters with a wider seam than the icons inside one', () => {
        // "The different buttons should be placed in more appropriate locations, with some
        // appropriate gaps." Derived from the group gap so it tracks the user's top bar scale.
        expect(cssSource).toContain('--sb-topbar-cluster-gap: calc(var(--sb-topbar-group-gap) * 2.5);');
        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-cluster-workspace \{\n\s*margin-inline-start: calc\(var\(--sb-topbar-cluster-gap\) - var\(--sb-topbar-group-gap\)\);\n\}/);

        const railRule = cssSource.match(/\.sb-topbar-pages \{[^}]*\}/);
        expect(railRule[0]).toContain('gap: var(--sb-topbar-group-gap);');
        expect(normalizedTabsSource).toContain('document.getElementById(cluster.leadId)?.classList.add(\'sb-topbar-cluster-lead\');');
    });

    test('keeps the clusters pinned to their own edge of the bar', () => {
        // Workspace stays hard left and Characters hard right at every width. The old rules pulled
        // both groups toward the brand label, which is the opposite of the requested layout.
        expect(cssSource).not.toContain('.sb-topbar-group-left {\n        justify-content: flex-end;');
        expect(cssSource).not.toContain('#sb-home-toggle {\n        margin-left: auto;');

        // display:none takes the hidden label out of the grid, and with only two items left the
        // right group would auto-place into the centre `auto` column and drift toward the middle,
        // under the left group's overflow. Cramped mode collapses the grid to two columns.
        expect(cssSource).toMatch(/:root\[data-sb-topbar-brand-cramped='true'\] #sb-topbar-inner \{\n\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, auto\);\n\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-brand-cramped='true'\][^{]*\{\n[^}]*justify-content: center/);
    });

    test('sizes the icons to match the labelled buttons beside them', () => {
        // They were 30px wide in a 36px-tall bar on desktop, and 26px next to 40px anchors on
        // phones, which is what made them small targets.
        expect(cssSource).toMatch(/\.sb-topbar-page-button,\n:root\[data-sb-topbar-icons-only='true'\] \.sb-proxy-button-icon-only \{\n\s*width: var\(--sb-proxy-button-height\);\n\s*min-width: var\(--sb-proxy-button-height\);\n\}/);
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] #sb-home-toggle {\n    min-width: var(--sb-proxy-button-height);\n}');

        // Phones key off the hamburger/Home/Characters size instead.
        const mobileRule = mobileCss.match(/:root\[data-sb-topbar-icons-only='true'\] \.sb-proxy-button-icon-only,\n\s*:root\[data-sb-topbar-icons-only='true'\] #sb-home-toggle \{[^}]*\}/);
        expect(mobileRule).not.toBeNull();
        expect(mobileRule[0]).toContain('min-width: var(--sb-mobile-toggle-size);');
        expect(mobileRule[0]).toContain('height: var(--sb-mobile-toggle-size);');
        expect(mobileCss).toContain('.sb-topbar-page-button i,');
    });

    test('reaches search through a quick access slot, exactly as with the option off', () => {
        // A dedicated Search button silently suppressed the user's own slot, which is the
        // inconsistent-patterns-across-contexts anti-pattern.
        expect(normalizedTabsSource).not.toContain('SB_TOPBAR_SEARCH_TARGET');
        expect(normalizedTabsSource).not.toContain('sb-topbar-search-toggle');
        expect(cssSource).not.toContain('#sb-topbar-search-toggle');
        expect(getClustersSource()).not.toContain('action:search');
        expect(normalizedTabsSource).toContain('right: \'action:search\',');
        expect(getFunctionSource('syncTopbarPageButtonStates')).toContain('for (const page of SB_TOPBAR_PAGE_TARGETS) {');
    });

    test('keeps canonical cluster icons and yields duplicate quick access slots', () => {
        expect(normalizedTabsSource).not.toContain('.sb-shortcut-rows\')?.classList.toggle(\'is-disabled\'');
        expect(cssSource).not.toContain('.sb-shortcut-rows.is-disabled');

        const dedupeSource = getFunctionSource('syncTopbarIconsOnlyDedupe');
        expect(dedupeSource).not.toContain('style.setProperty(\'display\'');
        expect(dedupeSource).toContain('const claimedByClusters = new Set(Array.from(clusterButtons, button => button.dataset.sbTopbarPage));');
        expect(dedupeSource).toContain("'sb-topbar-shortcut-duplicate'");
        expect(dedupeSource).toContain('iconsOnly && claimedByClusters.has(getShortcutTarget(side))');
        expect(normalizedTabsSource).not.toContain('sb-topbar-page-duplicate');
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] .sb-topbar-shortcut-duplicate');
    });

    test('re-runs dedupe and refit when a quick action is reassigned', () => {
        // The slot dropdown calls updateShortcutButton, so the top bar must settle from there
        // rather than waiting for the next toggle or resize.
        const updateSource = getFunctionSource('updateShortcutButton');
        expect(updateSource).toContain('syncTopbarIconsOnlyDedupe();');
        expect(updateSource).toContain('queueTopbarBrandFit();');
    });

    test('mounts the toggle in the desktop and mobile navigation groups', () => {
        // Geechan review: nesting it inside the Quick Access Shortcuts drawer is a nested menu,
        // and Navigation is where a top bar layout option is intuitively expected.
        const navSource = getFunctionSource('createNavigationSettingsGroup');
        expect(navSource).toContain('id: `sb-${modePrefix}-topbar-icons-only-input`');
        expect(navSource).toContain('label: \'Icons only top bar\',');
        expect(navSource).toContain('onChange: input => setTopbarIconsOnly(modePrefix, input.checked),');
        expect(navSource).toContain('topbarIconsOnlyChoice,');

        expect(normalizedTabsSource).not.toContain('createTopbarIconsOnlySettingsGroup');
        expect(getFunctionSource('createShortcutSettingsGroup')).toContain('content: [description, rows],');
        // One shared factory builds both groups, so the label exists once in source.
        expect(normalizedTabsSource.match(/'Icons only top bar'/g)).toHaveLength(1);
    });

    test('stores the toggle per device and applies only the active viewport\'s setting', () => {
        // The Desktop Navigation copy governs desktop viewports and the Mobile Navigation copy
        // governs phones, so turning the dense bar on for a phone does not restyle the desktop.
        expect(normalizedTabsSource).toContain('desktopTopbarIconsOnly: \'sb-desktop-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('mobileTopbarIconsOnly: \'sb-mobile-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('function setTopbarIconsOnly(mode, enabled');

        const activeSource = getFunctionSource('isTopbarIconsOnlyActive');
        expect(activeSource).toContain('isMobileViewport() ? sbState.topbarIconsOnly.mobile : sbState.topbarIconsOnly.desktop');

        // Crossing the breakpoint can change which device's setting is in force.
        const listenerMatch = normalizedTabsSource.match(/window\.matchMedia\(SB_MOBILE_MEDIA_QUERY\)\.addEventListener\('change', \(\) => \{[\s\S]*?\}\);/);
        expect(listenerMatch).not.toBeNull();
        expect(listenerMatch[0]).toContain('applyTopbarIconsOnlyPreference();');

        // Each checkbox reflects its own device's stored value, not the viewport-active state.
        expect(normalizedTabsSource).toContain('topbarIconsOnlyChoice.querySelector(\'input\')?.setAttribute(\'data-sb-topbar-icons-only-input\', modePrefix);');
        expect(normalizedTabsSource).toContain('input.getAttribute(\'data-sb-topbar-icons-only-input\') === \'desktop\'');
        expect(normalizedTabsSource).not.toContain('getElementById(\'sb-topbar-icons-only-input\')');
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

    test('stays distinct from the shell tab icon-only setting', () => {
        expect(normalizedTabsSource).toContain('topbarIconsOnly: \'sb-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('desktopNavIconOnly: \'sb-desktop-nav-icon-only\',');
        expect(normalizedTabsSource).toContain('mobileNavIconOnly: \'sb-mobile-nav-icon-only\',');
        expect(normalizedTabsSource).toContain('label: \'Icons only in shell tabs\',');
    });

    test('toggles state without rebuilding the top bar', () => {
        const setterSource = getFunctionSource('setTopbarIconsOnly');
        expect(setterSource).not.toContain('buildTopBar(');
        expect(setterSource).toContain('isDesktop ? SB_STORAGE_KEYS.desktopTopbarIconsOnly : SB_STORAGE_KEYS.mobileTopbarIconsOnly');
        expect(setterSource).toContain('updateThemePickerUi();');
        expect(normalizedTabsSource).toContain('sbState.topbarIconsOnly.desktop = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopTopbarIconsOnly), sbState.topbarIconsOnly.desktop);');
        expect(normalizedTabsSource).toContain('sbState.topbarIconsOnly.mobile = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileTopbarIconsOnly), sbState.topbarIconsOnly.mobile);');
    });

    test('keeps shell focus on a visible control', () => {
        // Workspace and Customize are hidden in icons-only mode, so shell-close focus falls back
        // to the active page icon instead of silently dropping to <body>.
        const proxySource = getFunctionSource('getShellProxyButton');
        expect(proxySource).toContain('isActuallyVisible(proxyButton)');
        expect(proxySource).toContain('data-sb-topbar-page');
    });

    test('keeps the character toggle measurable for anchored extension dropdowns', () => {
        const layoutSource = getFunctionSource('syncTopbarIconsOnlyLayout');
        expect(layoutSource).toContain('classList.toggle(\'sb-proxy-button-icon-only\', iconsOnly)');
        expect(layoutSource).not.toContain('style.display');

        const applySource = getFunctionSource('applyTopbarIconsOnlyPreference');
        expect(applySource).toContain('scheduleCharacterToggleGhostSync();');
    });

    test('hides the brand label once the icons outgrow the bar', () => {
        const fitSource = getFunctionSource('syncTopbarBrandFit');
        // The verdict must not depend on the label's current state, or showing it would make it
        // overflow, which would hide it again, which would make it fit -- an oscillation.
        expect(fitSource).toContain('const reservation = sbState.topbarPages.brandWidth || SB_TOPBAR_BRAND_MIN_WIDTH;');
        expect(fitSource).toContain('child.classList.contains(\'sb-topbar-pages\') ? child.scrollWidth : child.offsetWidth');
        // Cluster seams and divider centring live in margins, which offsetWidth omits; leaving
        // them uncounted opens a dead band where the bar overflows but scroll never trips.
        expect(fitSource).toContain('childStyle.marginInlineStart');
        expect(fitSource).toContain('childStyle.marginInlineEnd');
        expect(fitSource).toContain('dataset.sbTopbarBrandCramped');
        expect(cssSource).toMatch(/:root\[data-sb-topbar-brand-cramped='true'\] \.sb-topbar-brand \{\n\s*display: none;\n\}/);
    });

    test('drops the centre brand label on phones only', () => {
        // Desktop has room for the label, so the hide lives in the phone-gated sheet alone.
        // (0,3,0) outranks the plain .sb-topbar-brand rules in both fork sheets, no !important.
        expect(mobileCss).toMatch(/:root\[data-sb-topbar-icons-only='true'\] \.sb-topbar-brand \{\n\s*display: none;\n\s*\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-icons-only='true'\]\s+\.sb-topbar-brand/);
    });

    test('scrolls the whole bar rather than each cluster', () => {
        // A nested scroll region ended mid-button and left an unreadable sliver of an icon at
        // its boundary, so the clusters no longer scroll on their own.
        const railRuleMatch = cssSource.match(/\.sb-topbar-pages\s*\{[^}]*\}/);
        expect(railRuleMatch).not.toBeNull();
        expect(railRuleMatch[0]).not.toContain('overflow-x: auto;');
        expect(railRuleMatch[0]).toContain('flex-wrap: nowrap;');

        // The leading group is the scroll region; the inner row itself only lays it out.
        const scrollerRule = cssSource.match(/:root\[data-sb-topbar-scroll='true'\] \.sb-topbar-group-left \{[^}]*\}/);
        expect(scrollerRule).not.toBeNull();
        expect(scrollerRule[0]).toContain('overflow-x: auto;');
        // The min-content floor propagates through every flex/grid ancestor, and the shrink
        // permission must be gated on icons-only rather than on the scroll state: the overflow
        // verdict is read from the inner's client width, so gating it on the verdict lets the
        // bar inflate to fit its own content and a small overflow is never detected.
        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-stack,\n:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-primary,\n:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-inner \{\n\s*min-width: 0;\n\}/);
        expect(cssSource).not.toMatch(/:root\[data-sb-topbar-scroll='true'\] #sb-topbar-stack/);
        // Snapping pulled the bar past the hamburger on load, because the first snap point is
        // the leading page icon rather than the start of the bar.
        expect(scrollerRule[0]).not.toContain('scroll-snap-type');
        expect(cssSource).not.toContain('scroll-snap-align: start;');
    });

    test('keeps the trailing controls beside the scrolling icons, never under them', () => {
        // Scrolling icons *under* the trailing group needs that group to paint over them, and
        // its only theme-correct backing is the bar's own translucent background: repainting
        // double-darkens, and backdrop-filter silently no-ops in WebKit when nested inside
        // another backdrop-filtered element, leaving icons showing through it on iOS.
        const rightRule = cssSource.match(/:root\[data-sb-topbar-scroll='true'\] \.sb-topbar-group-right \{[^}]*\}/);
        expect(rightRule).not.toBeNull();
        expect(rightRule[0]).toContain('flex: 0 0 auto;');
        expect(rightRule[0]).not.toContain('position: sticky;');
        expect(rightRule[0]).not.toContain('backdrop-filter');

        const leftRule = cssSource.match(/:root\[data-sb-topbar-scroll='true'\] \.sb-topbar-group-left \{[^}]*\}/);
        expect(leftRule).not.toBeNull();
        expect(leftRule[0]).toContain('overflow-x: auto;');
        // WebKit needs the pan axis declared or the buttons swallow the gesture.
        expect(leftRule[0]).toContain('touch-action: pan-x;');
        expect(leftRule[0]).toContain('-webkit-overflow-scrolling: touch;');

        // Only engages when the icons actually outrun the bar.
        const fitSource = getFunctionSource('syncTopbarBrandFit');
        expect(fitSource).toContain('if (needed > available) {');
        expect(fitSource).toContain('dataset.sbTopbarScroll');
    });

    test('keeps button touch handlers off WebKit slow path', () => {
        // A non-passive touchstart on every button pulls WebKit off compositor scrolling, which
        // stalls the strip on iOS. The handler only stops propagation, so passive is correct.
        const propagationSource = getFunctionSource('stopProxyPointerPropagation');
        expect(propagationSource).toContain('element.addEventListener(\'touchstart\', stop, { passive: true });');
        expect(propagationSource).toContain('stopPropagation');
    });

    test('keeps one spacing rhythm across the mobile bar', () => {
        // Cluster gap, group gap and the grid seam were three different widths between identical
        // square buttons, which is what read as awkward spacing. All key off the group gap.
        const innerRule = mobileCss.match(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-inner \{[^}]*\}/);
        expect(innerRule).not.toBeNull();
        expect(innerRule[0]).toContain('gap: var(--sb-topbar-group-gap);');
        expect(mobileCss).toContain('.sb-topbar-group-left');
    });
});
