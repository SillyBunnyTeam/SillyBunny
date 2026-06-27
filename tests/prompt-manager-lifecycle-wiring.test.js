import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptManagerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'PromptManager.js'), 'utf8');

function getMethodSource(name) {
    const markers = [`\n    ${name}(`, `\n    async ${name}(`];
    const start = markers.reduce((match, marker) => {
        const index = promptManagerSource.indexOf(marker);
        return match === -1 || (index !== -1 && index < match) ? index : match;
    }, -1);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = promptManagerSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < promptManagerSource.length; index++) {
        const char = promptManagerSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return promptManagerSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find method source for ${name}`);
}

describe('prompt manager lifecycle wiring', () => {
    test('imports prompt manager lifecycle decisions into PromptManager', () => {
        expect(promptManagerSource).toContain('resolvePromptManagerRenderState');
        expect(promptManagerSource).toContain('resolvePromptManagerScrollRestore');
    });

    test('routes scroll restoration through the lifecycle seam', () => {
        const source = getMethodSource('#setScrollPosition');

        expect(source).toContain('resolvePromptManagerScrollRestore({ scrollPosition })');
        expect(source).toContain('restoreState.shouldRestore');
        expect(source).toContain('container.scrollTo(0, restoreState.scrollPosition)');
        expect(source).toContain('restoreState.shouldRestoreAfterAnimationFrame');
        expect(source).not.toContain('scrollPosition === undefined || scrollPosition === null');
    });

    test('preserves desktop prompt list scroll before shell fallback', () => {
        const source = getMethodSource('#getScrollContainer');

        expect(source).toContain('this.isDesktopSplitLayout()');
        expect(source).toContain('prompt_manager_list');
        expect(source.indexOf('return listElement;')).toBeLessThan(source.indexOf('closest(\'.sb-shell-panel-scroller, .scrollableInner\')'));
    });

    test('captures prompt manager scroll before save-triggered render', () => {
        const saveStart = promptManagerSource.indexOf('this.handleSavePrompt = (event) => {');
        const saveEnd = promptManagerSource.indexOf('// Reset prompt should it be a system prompt', saveStart);
        const saveSource = promptManagerSource.slice(saveStart, saveEnd);

        expect(saveSource).toContain('this.#queuePromptManagerScrollRestore();');
        expect(saveSource.indexOf('this.#queuePromptManagerScrollRestore();')).toBeLessThan(saveSource.indexOf('this.render(false);'));
        expect(promptManagerSource).toContain('pendingPromptManagerScrollPosition');
        expect(promptManagerSource).toContain('resolvePromptManagerScrollRestore({ scrollPosition: this.#readScrollPosition() })');
    });

    test('routes render gating through the lifecycle seam before waiting', () => {
        const source = getMethodSource('render');

        expect(source).toContain('resolvePromptManagerRenderState({');
        expect(source).toContain('mainApi: main_api');
        expect(source).toContain('promptOrderStrategy: this.configuration.promptOrder.strategy');
        expect(source).toContain('hasActiveCharacter: this.activeCharacter !== null');
        expect(source).toContain('isSendPressed: is_send_press');
        expect(source).toContain('isGroupGenerating: is_group_generating');
        expect(source).toContain('!renderState.shouldRender && !renderState.shouldWaitForGeneration');
        expect(source).not.toContain('if (main_api !== \'openai\') return;');
        expect(source).not.toContain('\'character\' === this.configuration.promptOrder.strategy && null === this.activeCharacter');
    });

    test('routes ready render mode through the lifecycle seam after waiting', () => {
        const source = getMethodSource('render');

        expect(source).toContain('const readyRenderState = resolvePromptManagerRenderState({');
        expect(source).toContain('if (!readyRenderState.shouldRender)');
        expect(source).toContain('if (readyRenderState.shouldRunDryGenerate)');
        expect(source).not.toContain('if (true === afterTryGenerate)');
    });

    test('guards async render writes with a current render token', () => {
        const renderSource = getMethodSource('render');
        const promptManagerRenderSource = getMethodSource('renderPromptManager');
        const promptListRenderSource = getMethodSource('renderPromptManagerListItems');

        expect(promptManagerSource).toContain('this.renderRequestId = 0;');
        expect(promptManagerSource).toContain('#isRenderCurrent(renderRequestId)');
        expect(renderSource).toContain('const renderRequestId = ++this.renderRequestId;');
        expect(renderSource).toContain('const renderedPromptManager = await this.renderPromptManager(renderRequestId);');
        expect(renderSource).toContain('const renderedListItems = await this.renderPromptManagerListItems(renderRequestId);');
        expect(renderSource).toContain('!this.#isRenderCurrent(renderRequestId)');

        const headerAwaitIndex = promptManagerRenderSource.indexOf('const headerHtml = await renderTemplateAsync(\'promptManagerHeader\'');
        const promptManagerClearIndex = promptManagerRenderSource.indexOf('promptManagerDiv.innerHTML = \'\';');
        const promptManagerHeaderGuardIndex = promptManagerRenderSource.indexOf('if (!this.#isRenderCurrent(renderRequestId))', headerAwaitIndex);

        expect(promptManagerRenderSource).toContain('async renderPromptManager(renderRequestId = this.renderRequestId)');
        expect(headerAwaitIndex).toBeGreaterThanOrEqual(0);
        expect(promptManagerHeaderGuardIndex).toBeGreaterThan(headerAwaitIndex);
        expect(promptManagerClearIndex).toBeGreaterThan(promptManagerHeaderGuardIndex);
        expect(promptManagerRenderSource).toContain('return false;');
        expect(promptManagerRenderSource).toContain('return true;');

        const listHeaderAwaitIndex = promptListRenderSource.indexOf('let listItemHtml = await renderTemplateAsync(\'promptManagerListHeader\'');
        const promptListClearIndex = promptListRenderSource.indexOf('promptManagerList.innerHTML = \'\';');
        const promptListGuardIndex = promptListRenderSource.indexOf('if (!this.#isRenderCurrent(renderRequestId) || promptManagerList !== this.listElement)', listHeaderAwaitIndex);

        expect(promptListRenderSource).toContain('async renderPromptManagerListItems(renderRequestId = this.renderRequestId)');
        expect(listHeaderAwaitIndex).toBeGreaterThanOrEqual(0);
        expect(promptListGuardIndex).toBeGreaterThan(listHeaderAwaitIndex);
        expect(promptListClearIndex).toBeGreaterThan(promptListGuardIndex);
        expect(promptListRenderSource).toContain('return false;');
        expect(promptListRenderSource).toContain('return true;');
    });
});
