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
    test('parks only the redundant shell toggles', () => {
        // Every page the Workspace and Customize toggles lead to has its own rail icon, so they
        // step aside. Home, Characters, the hamburger and the Quick Access slots all stay.
        const parkedMatch = normalizedTabsSource.match(/const SB_TOPBAR_PARKED_IDS = Object\.freeze\(\[[\s\S]*?\]\);/);
        expect(parkedMatch).not.toBeNull();

        const parkedSource = parkedMatch[0];
        expect(parkedSource).toContain('\'sb-left-shell-toggle\'');
        expect(parkedSource).toContain('\'sb-right-shell-toggle\'');

        for (const keptId of ['sb-hamburger', 'sb-home-toggle', 'sb-character-toggle', 'sb-shortcut-left', 'sb-shortcut-right', 'sb-shortcut-slot3']) {
            expect(parkedSource).not.toContain(`'${keptId}'`);
        }
    });

    test('keeps shell focus on a visible control once the toggles are parked', () => {
        // Focusing a display:none button silently drops focus to <body> when a shell closes.
        const proxySource = getFunctionSource('getShellProxyButton');
        expect(proxySource).toContain('isActuallyVisible(proxyButton)');
        expect(proxySource).toContain('data-sb-topbar-page');
    });

    test('hides the brand label once the icons outgrow the bar', () => {
        const fitSource = getFunctionSource('syncTopbarBrandFit');
        // The verdict must not depend on the label's current state, or showing it would make it
        // overflow, which would hide it again, which would make it fit -- an oscillation.
        expect(fitSource).toContain('const reservation = sbState.topbarPages.brandWidth || SB_TOPBAR_BRAND_MIN_WIDTH;');
        expect(fitSource).toContain('child.classList.contains(\'sb-topbar-pages\') ? child.scrollWidth : child.offsetWidth');
        expect(fitSource).toContain('dataset.sbTopbarBrandCramped');
        expect(cssSource).toMatch(/:root\[data-sb-topbar-brand-cramped='true'\] \.sb-topbar-brand \{\n\s*display: none;\n\}/);
    });

    test('drops the centre brand label on phones only', () => {
        // Desktop has room for the label, so the hide lives in the phone-gated sheet alone.
        // (0,3,0) outranks the plain .sb-topbar-brand rules in both fork sheets, no !important.
        const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
        expect(mobileCss).toMatch(/:root\[data-sb-topbar-icons-only='true'\] \.sb-topbar-brand \{\n\s*display: none;\n\s*\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-icons-only='true'\]\s+\.sb-topbar-brand/);
    });

    test('keeps the character toggle measurable for anchored extension dropdowns', () => {
        const layoutSource = getFunctionSource('syncTopbarIconsOnlyLayout');
        expect(layoutSource).toContain('classList.toggle(\'sb-proxy-button-icon-only\', iconsOnly)');
        expect(layoutSource).not.toContain('style.display');

        const applySource = getFunctionSource('applyTopbarIconsOnlyPreference');
        expect(applySource).toContain('scheduleCharacterToggleGhostSync();');
    });

    test('restores parked slots by replaying recorded group order', () => {
        // Restoring via a remembered nextSibling is unsafe: neighbouring slots are parked too,
        // so moveElementBefore would insertBefore a reference node that left the parent.
        const layoutSource = getFunctionSource('syncTopbarIconsOnlyLayout');
        expect(layoutSource).toContain('for (const [group, children] of sbState.topbarPages.groupOrder)');
        expect(layoutSource).toContain('group.appendChild(child);');
        expect(normalizedTabsSource).toContain('function rememberTopbarGroupOrder(');
        expect(normalizedTabsSource).toContain('rememberTopbarGroupOrder(leftGroup, rightGroup);');
    });

    test('derives page labels and icons from the shell registries', () => {
        const targetsMatch = normalizedTabsSource.match(/const SB_TOPBAR_PAGE_TARGETS = Object\.freeze\(\[[\s\S]*?\]\);/);
        expect(targetsMatch).not.toBeNull();

        const targetsSource = targetsMatch[0];
        expect(targetsSource).not.toContain('\'none\'');
        expect(targetsSource).not.toContain('label:');
        expect(targetsSource).not.toContain('icon:');

        const configSource = getFunctionSource('getTopbarPageConfig');
        expect(configSource).toContain('getCharacterPanelTabConfig(page.tabId)');
        expect(configSource).toContain('getShellConfig(page.shellKey)');
    });

    test('toggles state without rebuilding the top bar', () => {
        const setterSource = getFunctionSource('setTopbarIconsOnly');
        expect(setterSource).not.toContain('buildTopBar(');
        expect(setterSource).toContain('safeSetItem(SB_STORAGE_KEYS.topbarIconsOnly, String(nextEnabled));');
        expect(setterSource).toContain('updateThemePickerUi();');
        expect(normalizedTabsSource).toContain('sbState.topbarIconsOnly = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.topbarIconsOnly), sbState.topbarIconsOnly);');
    });

    test('stays distinct from the shell tab icon-only setting', () => {
        expect(normalizedTabsSource).toContain('topbarIconsOnly: \'sb-topbar-icons-only\',');
        expect(normalizedTabsSource).toContain('desktopNavIconOnly: \'sb-desktop-nav-icon-only\',');
        expect(normalizedTabsSource).toContain('mobileNavIconOnly: \'sb-mobile-nav-icon-only\',');
        expect(normalizedTabsSource).toContain('\'sb-topbar-icons-only-input\'');
        expect(normalizedTabsSource).toContain('\'sb-desktop-nav-icon-only-input\'');
    });

    test('mounts the toggle in the quick access shortcuts drawer', () => {
        const groupSource = getFunctionSource('createShortcutSettingsGroup');
        expect(groupSource).toContain('createTopbarIconsOnlySettingsGroup()');
        expect(normalizedTabsSource.match(/'Icons only top bar'/g)).toHaveLength(1);
        expect(normalizedTabsSource).not.toContain('lorum ipsum');
    });

    test('splits customize pages onto a second rail beside the brand label', () => {
        expect(normalizedTabsSource).toContain('const leftPages = SB_TOPBAR_PAGE_TARGETS.filter(page => page.shellKey !== \'right\');');
        expect(normalizedTabsSource).toContain('const rightPages = SB_TOPBAR_PAGE_TARGETS.filter(page => page.shellKey === \'right\');');
        expect(normalizedTabsSource).toContain('buildTopbarPageRail(\'sb-topbar-pages-right\', rightPages);');
        expect(normalizedTabsSource).toContain('rightGroup.append(customizeRail,');
    });

    test('folds both rails back together on phones', () => {
        // The split fills the gap either side of the brand label; phones hide that label and
        // have no width to spare, so the right group's fixed buttons would starve the left rail.
        const splitSource = getFunctionSource('syncTopbarRailSplit');
        expect(splitSource).toContain('const shouldMerge = isMobileViewport();');
        expect(splitSource).toContain('leftRail.appendChild(button);');
        expect(splitSource).toContain('rightRail.appendChild(button);');
        expect(splitSource).toContain('classList.toggle(\'sb-topbar-pages-empty\', shouldMerge);');
        expect(normalizedTabsSource).toContain('window.matchMedia(SB_MOBILE_MEDIA_QUERY).addEventListener(\'change\'');
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] .sb-topbar-pages-empty');
    });

    test('evens out the whitespace either side of the brand label', () => {
        // Equal side tracks already put the label on the true centre, but both groups fill from
        // the outer edge inward, so the leftover slack lands next to the label unequally and
        // reads as off-centre. Clustering each group against the label evens that out.
        const desktopBlocks = cssSource.match(/@media screen and \(min-width: 769px\) \{[\s\S]*?\n\}/g) ?? [];
        const clusterBlock = desktopBlocks.find(block => block.includes('data-sb-topbar-icons-only'));
        expect(clusterBlock).toBeDefined();
        expect(clusterBlock).toContain('.sb-topbar-group-left {\n        justify-content: flex-end;');
        expect(clusterBlock).toContain('.sb-topbar-group-right {\n        justify-content: flex-start;');
        expect(clusterBlock).toContain('#sb-home-toggle {\n        margin-left: auto;');
    });

    test('centres the whole row once the brand label is dropped', () => {
        // Equal side tracks with no centre column strand the icons left of centre, so the grid
        // collapses to a centred flex row. Must come after the margin-left: auto rule to win.
        const desktopBlocks = cssSource.match(/@media screen and \(min-width: 769px\) \{[\s\S]*?\n\}/g) ?? [];
        const clusterBlock = desktopBlocks.find(block => block.includes('data-sb-topbar-brand-cramped'));
        expect(clusterBlock).toBeDefined();
        expect(clusterBlock).toContain('#sb-topbar-inner {\n        display: flex;\n        justify-content: center;');
        expect(clusterBlock).toContain('#sb-home-toggle {\n        margin-left: 0;');
        expect(clusterBlock.indexOf('margin-left: auto')).toBeLessThan(clusterBlock.indexOf('margin-left: 0'));
    });

    test('pins quick actions, search, home and characters to the right in that order', () => {
        const orderSource = getFunctionSource('syncTopbarRightClusterOrder');
        const ids = ['sb-topbar-pages-right', 'sb-topbar-search-toggle', 'sb-home-toggle', 'sb-character-toggle'];
        const positions = ids.map(id => orderSource.indexOf(id));
        expect(positions.every(position => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        // Quick Actions sit between the rail and Search.
        expect(orderSource.indexOf('SB_SHORTCUT_SLOTS')).toBeGreaterThan(positions[0]);
        expect(orderSource.indexOf('SB_SHORTCUT_SLOTS')).toBeLessThan(positions[1]);
    });

    test('keeps the rightmost copy when a quick action duplicates a rail icon', () => {
        const dedupeSource = getFunctionSource('syncTopbarIconsOnlyDedupe');
        // The rail icon yields to the slot, and a slot pointed at Search yields to the dedicated
        // Search button, which sits further right still.
        expect(dedupeSource).toContain('claimed.add(target);');
        expect(dedupeSource).toContain('button.classList.toggle(\'sb-topbar-page-duplicate\', claimed.has(button.dataset.sbTopbarPage));');
        expect(dedupeSource).toContain('if (isSearchShortcutTarget(target)) {');
        // Workspace pages are the exception: they keep the left rail berth and the slot yields.
        expect(dedupeSource).toContain('if (target.startsWith(\'left:\') && railByTarget.has(target)) {');
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] .sb-topbar-page-duplicate');
    });

    test('re-runs dedupe and refit when a quick action is reassigned', () => {
        // The slot dropdown calls updateShortcutButton, so the top bar must settle from there
        // rather than waiting for the next toggle or resize.
        const updateSource = getFunctionSource('updateShortcutButton');
        expect(updateSource).toContain('syncTopbarIconsOnlyDedupe();');
        expect(updateSource).toContain('queueTopbarBrandFit();');
    });

    test('keeps search off the rail and gives it a fixed berth', () => {
        const targetsMatch = normalizedTabsSource.match(/const SB_TOPBAR_PAGE_TARGETS = Object\.freeze\(\[[\s\S]*?\]\);/);
        expect(targetsMatch[0]).not.toContain('action:search');
        expect(normalizedTabsSource).toContain('const SB_TOPBAR_SEARCH_TARGET = Object.freeze({ value: \'action:search\'');
        expect(normalizedTabsSource).toContain('searchButton.id = \'sb-topbar-search-toggle\';');
        // Still reflects open/closed state alongside the page icons.
        expect(getFunctionSource('syncTopbarPageButtonStates')).toContain('[...SB_TOPBAR_PAGE_TARGETS, SB_TOPBAR_SEARCH_TARGET]');
    });

    test('scrolls the whole bar rather than each rail', () => {
        // A nested scroll region ended mid-button and left an unreadable sliver of an icon at
        // its boundary, so the rails no longer scroll on their own.
        const railRuleMatch = cssSource.match(/\.sb-topbar-pages\s*\{[^}]*\}/);
        expect(railRuleMatch).not.toBeNull();
        expect(railRuleMatch[0]).not.toContain('overflow-x: auto;');
        expect(railRuleMatch[0]).toContain('flex-wrap: nowrap;');

        const innerRule = cssSource.match(/:root\[data-sb-topbar-scroll='true'\] #sb-topbar-inner \{[^}]*\}/);
        expect(innerRule).not.toBeNull();
        expect(innerRule[0]).toContain('overflow-x: auto;');
        // The min-content floor propagates through every flex/grid ancestor, and the shrink
        // permission must be gated on icons-only rather than on the scroll state: the overflow
        // verdict is read from the inner's client width, so gating it on the verdict lets the
        // bar inflate to fit its own content and a small overflow is never detected.
        expect(cssSource).toMatch(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-stack,\n:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-primary,\n:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-inner \{\n\s*min-width: 0;\n\}/);
        expect(cssSource).not.toMatch(/:root\[data-sb-topbar-scroll='true'\] #sb-topbar-stack/);
        // Snapping pulled the bar past the hamburger on load, because the first snap point is
        // the leading page icon rather than the start of the bar.
        expect(innerRule[0]).not.toContain('scroll-snap-type');
        expect(cssSource).not.toContain('scroll-snap-align: start;');
    });

    test('pins the trailing controls while the icons scroll under them', () => {
        const stickyRule = cssSource.match(/:root\[data-sb-topbar-scroll='true'\] \.sb-topbar-group-right \{[^}]*\}/);
        expect(stickyRule).not.toBeNull();
        expect(stickyRule[0]).toContain('position: sticky;');
        expect(stickyRule[0]).toContain('right: 0;');
        // Repainting the bar's themeable translucent background would double-darken and seam,
        // so the pinned cluster reuses the bar's own glass treatment instead.
        expect(stickyRule[0]).toContain('backdrop-filter: blur(12px);');
        expect(stickyRule[0]).toContain('-webkit-backdrop-filter: blur(12px);');
        expect(stickyRule[0]).toContain('-webkit-mask-image:');

        // Only engages when the icons actually outrun the bar.
        const fitSource = getFunctionSource('syncTopbarBrandFit');
        expect(fitSource).toContain('if (needed > available) {');
        expect(fitSource).toContain('dataset.sbTopbarScroll');
    });

    test('keeps one spacing rhythm across the mobile bar', () => {
        // Rail gap, group gap and the grid seam were three different widths between identical
        // square buttons, which is what read as awkward spacing. All key off the group gap.
        const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
        expect(mobileCss).toMatch(/:root\[data-sb-topbar-icons-only='true'\] \.sb-topbar-pages \{\n\s*gap: var\(--sb-topbar-group-gap\);\n\s*\}/);
        const innerRule = mobileCss.match(/:root\[data-sb-topbar-icons-only='true'\] #sb-topbar-inner \{[^}]*\}/);
        expect(innerRule).not.toBeNull();
        expect(innerRule[0]).toContain('gap: var(--sb-topbar-group-gap);');
        expect(cssSource).toContain('#sb-topbar-parked {\n    display: none;\n}');
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] #sb-home-toggle');
    });
});
