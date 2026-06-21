import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

function getFunctionSource(name) {
    const match = tabsSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

describe('topbar label tap cycle', () => {
    test('keeps preview cycle state transient', () => {
        expect(tabsSource).toContain('const SB_TOPBAR_LABEL_CYCLE_RESET_MS = 5000;');
        expect(tabsSource).toContain("cyclePart: ''");
        expect(tabsSource).toContain('cycleResetTimer: 0');
        expect(tabsSource).toContain('function resetTopBarLabelCycle');
        expect(tabsSource).toContain('window.clearTimeout(sbState.topbarLabel.cycleResetTimer);');
    });

    test('cycles configured, context size, character name, and custom text when applicable', () => {
        const cyclePartsSource = getFunctionSource('getTopbarLabelCycleParts');
        expect(cyclePartsSource).toContain("const cycleParts = ['', 'ctx', 'char'];");
        expect(cyclePartsSource).toContain('if (sbState.topbarLabel.customText)');
        expect(cyclePartsSource).toContain("cycleParts.push('custom');");

        const cycleSource = getFunctionSource('cycleTopBarLabel');
        expect(cycleSource).toContain('const nextPart = cycleParts[nextIndex % cycleParts.length];');
        expect(cycleSource).toContain("if (nextPart === 'ctx')");
        expect(cycleSource).toContain('scheduleTopbarContextRefresh(0);');
    });

    test('renders preview labels without changing configured label settings', () => {
        const labelSource = getFunctionSource('getTopBarLabel');
        expect(labelSource).toContain('const previewPart = normalizeTopbarLabelPart(sbState.topbarLabel.cyclePart, \'\');');
        expect(labelSource).toContain('return getTopBarLabelPreviewText(previewPart, context);');

        const previewSource = getFunctionSource('getTopBarLabelPreviewText');
        expect(previewSource).toContain("if (normalizedPart === 'ctx')");
        expect(previewSource).toContain("return '...';");
        expect(previewSource).toContain('return getTopbarLabelPartOption(normalizedPart)?.label ?? \'\';');
    });

    test('binds accessible pointer and keyboard activation on the title', () => {
        const bindSource = getFunctionSource('bindTopBarTitleCycle');
        expect(bindSource).toContain("title.addEventListener('click'");
        expect(bindSource).toContain("title.addEventListener('keydown'");
        expect(bindSource).toContain("event.key !== 'Enter' && event.key !== ' '");
        expect(bindSource).toContain('event.preventDefault();');
        expect(bindSource).toContain('cycleTopBarLabel();');

        expect(tabsSource).toContain('role="button"');
        expect(tabsSource).toContain('tabindex="0"');
        expect(tabsSource).toContain('title.setAttribute(\'aria-label\'');
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
});
