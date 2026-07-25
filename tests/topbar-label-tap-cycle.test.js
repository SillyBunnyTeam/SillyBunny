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
    test('parks only the configurable quick access slots', () => {
        // PRODUCT.md layer 2 prescribes the top bar anchors; icons-only mode may drop their
        // labels but must never remove them from the bar.
        const parkedMatch = normalizedTabsSource.match(/const SB_TOPBAR_PARKED_IDS = Object\.freeze\(\[[\s\S]*?\]\);/);
        expect(parkedMatch).not.toBeNull();

        const parkedSource = parkedMatch[0];
        for (const slotId of ['sb-shortcut-left', 'sb-shortcut-right', 'sb-shortcut-slot3', 'sb-shortcut-slot4', 'sb-shortcut-slot5', 'sb-shortcut-slot6']) {
            expect(parkedSource).toContain(`'${slotId}'`);
        }

        for (const anchorId of ['sb-hamburger', 'sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-home-toggle', 'sb-character-toggle']) {
            expect(parkedSource).not.toContain(`'${anchorId}'`);
        }
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
        expect(targetsSource).toContain('\'action:search\'');
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
        // reads as off-centre. Auto margins pull each rail up against the label instead.
        expect(cssSource).toMatch(/#sb-topbar-pages \{\n\s*margin-left: auto;\n\s*\}/);
        expect(cssSource).toMatch(/#sb-topbar-pages-right \{\n\s*margin-right: auto;\n\s*\}/);
        // Desktop only: phones merge the rails and hide the label entirely.
        const desktopBlocks = cssSource.match(/@media screen and \(min-width: 769px\) \{[\s\S]*?\n\}/g) ?? [];
        expect(desktopBlocks.some(block => block.includes('margin-left: auto'))).toBe(true);
    });

    test('scrolls the rail rather than wrapping it', () => {
        const railRuleMatch = cssSource.match(/\.sb-topbar-pages\s*\{[^}]*\}/);
        expect(railRuleMatch).not.toBeNull();

        const railRule = railRuleMatch[0];
        expect(railRule).toContain('overflow-x: auto;');
        expect(railRule).toContain('flex-wrap: nowrap;');
        expect(railRule).toContain('mask-image:');
        expect(railRule).toContain('-webkit-mask-image:');
        expect(cssSource).toContain('#sb-topbar-parked {\n    display: none;\n}');
        expect(cssSource).toContain(':root[data-sb-topbar-icons-only=\'true\'] #sb-home-toggle');
    });
});
