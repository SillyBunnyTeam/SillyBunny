/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    resolvePromptManagerRenderState as realResolveRenderState,
    resolvePromptManagerScrollRestore as realResolveScrollRestore,
} from '../public/scripts/prompt-manager-lifecycle/index.js';
import { importOpenAiModule } from './util/openai-harness.js';

const resolvePublic = relativePath => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));
const jquerySource = readFileSync(resolvePublic('lib/jquery-3.5.1.min.js'), 'utf8');
(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const resolveRenderStateSpy = jest.fn(realResolveRenderState);
const resolveScrollRestoreSpy = jest.fn(realResolveScrollRestore);

let waitResolver = null;
const waitUntilConditionMock = jest.fn(() => new Promise(resolve => {
    waitResolver = resolve;
}));
const renderTemplateMock = jest.fn(async name => {
    if (name === 'promptManagerHeader') return '<div class="pm-header">Header</div><ul id="completion_prompt_manager_list"></ul>';
    if (name === 'promptManagerListHeader') return '<li class="pm-list-header">List Header</li>';
    return '';
});

await jest.unstable_mockModule(resolvePublic('scripts/prompt-token-counts.js'), () => ({
    createCommentOnlyContentCheck: () => () => false,
    getPromptDisplayTokenCounts: () => ({}),
    getPromptSourceTokenCounts: async () => ({}),
    getRuntimePreparedPromptContent: () => '',
    mergePromptTokenCounts: () => ({}),
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-marker-preview.js'), () => ({
    getRenderedMarkerPrompt: () => '',
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-order.js'), () => ({
    reorderPromptOrder: order => order,
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-variable-cleanup.js'), () => ({
    clearPromptSetVariables: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-lifecycle/index.js'), () => ({
    resolvePromptManagerRenderState: resolveRenderStateSpy,
    resolvePromptManagerScrollRestore: resolveScrollRestoreSpy,
}));

const { mocks } = await importOpenAiModule({
    mockPromptManager: false,
    templates: { renderTemplateAsync: renderTemplateMock },
});

// Override waitUntilCondition after importOpenAiModule registers utils mock.
const utilsModule = await import('../public/scripts/utils.js');
utilsModule.waitUntilCondition.mockImplementation((...args) => waitUntilConditionMock(...args));

const { PromptManager } = await import('../public/scripts/PromptManager.js');

function createMountedManager({ strategy = 'global', desktopSplit = false } = {}) {
    document.body.innerHTML = `
        <input id="openai_max_context" type="number" value="4096" />
        <input id="openai_max_tokens" type="number" value="256" />
        <textarea id="main_prompt_quick_edit_textarea"></textarea>
        <textarea id="nsfw_prompt_quick_edit_textarea"></textarea>
        <textarea id="jailbreak_prompt_quick_edit_textarea"></textarea>
        <div class="sb-shell-panel-scroller">
            <div id="completion_prompt_manager">
                <ul id="completion_prompt_manager_list"></ul>
            </div>
        </div>
        <div id="completion_prompt_manager_popup" style="display:none">
            <div id="completion_prompt_manager_popup_edit">
                <input id="completion_prompt_manager_popup_entry_form_name" value="Main Prompt" />
                <select id="completion_prompt_manager_popup_entry_form_role"><option value="system">system</option></select>
                <textarea id="completion_prompt_manager_popup_entry_form_prompt">Updated body</textarea>
                <div id="completion_prompt_manager_depth_block">
                    <input id="completion_prompt_manager_popup_entry_form_injection_depth" value="4" />
                </div>
                <div id="completion_prompt_manager_order_block">
                    <input id="completion_prompt_manager_popup_entry_form_injection_order" value="100" />
                </div>
                <select id="completion_prompt_manager_popup_entry_form_injection_position"><option value="0">0</option></select>
                <div id="completion_prompt_manager_forbid_overrides_block">
                    <input id="completion_prompt_manager_popup_entry_form_forbid_overrides" type="checkbox" />
                </div>
                <select id="completion_prompt_manager_popup_entry_form_injection_trigger"></select>
                <div id="completion_prompt_manager_popup_entry_source_block">
                    <span id="completion_prompt_manager_popup_entry_source"></span>
                </div>
                <button id="completion_prompt_manager_popup_entry_form_save" type="button"></button>
                <button id="completion_prompt_manager_popup_entry_form_reset" type="button"></button>
                <button id="completion_prompt_manager_popup_entry_form_close" type="button"></button>
            </div>
            <div id="completion_prompt_manager_popup_inspect">
                <div id="completion_prompt_manager_popup_entry_form_inspect_list"></div>
            </div>
            <button id="completion_prompt_manager_popup_close_button" type="button"></button>
            <button id="completion_prompt_manager_popup_preview_close_button" type="button"></button>
        </div>
    `;
    const shellScroller = document.querySelector('.sb-shell-panel-scroller');
    shellScroller.scrollTo = jest.fn();

    const manager = new PromptManager();
    manager.init({
        prefix: 'completion_',
        containerIdentifier: 'completion_prompt_manager',
        listIdentifier: 'completion_prompt_manager_list',
        promptOrder: { strategy, dummyId: 100001 },
        warningTokenThreshold: 1500,
        dangerTokenThreshold: 500,
        defaultPrompts: [],
        version: 1,
    }, {
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Initial', system_prompt: true },
            { identifier: 'nsfw', name: 'Auxiliary Prompt', role: 'system', content: '', system_prompt: true },
            { identifier: 'jailbreak', name: 'Post-History', role: 'system', content: '', system_prompt: true },
        ],
        prompt_order: [
            { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
        ],
        openai_max_context: 4096,
        openai_max_tokens: 256,
    });
    manager.activeCharacter = { id: 100001, name: 'TestChar' };
    manager.tokenHandler = {
        getCounts: () => ({}),
        getTotal: () => 0,
        resetCounts: () => {},
        countUntrackedAsync: async () => 0,
    };
    manager.saveServiceSettings = jest.fn(async () => {});
    manager.tryGenerate = jest.fn(async () => {});
    manager.isDesktopSplitLayout = jest.fn(() => desktopSplit);
    manager.makeDraggable = jest.fn();
    return { manager, shellScroller };
}

async function flushAsync() {
    for (let i = 0; i < 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

describe('prompt manager lifecycle behaviour', () => {
    let rafCallbacks = [];
    let originalRaf;

    beforeEach(() => {
        rafCallbacks = [];
        originalRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = jest.fn(cb => {
            rafCallbacks.push(cb);
            return rafCallbacks.length;
        });
        resolveRenderStateSpy.mockClear().mockImplementation(realResolveRenderState);
        resolveScrollRestoreSpy.mockClear().mockImplementation(realResolveScrollRestore);
        waitUntilConditionMock.mockReset().mockImplementation(async () => true);
        renderTemplateMock.mockReset().mockImplementation(async name => {
            if (name === 'promptManagerHeader') return '<div class="pm-header">Header</div><ul id="completion_prompt_manager_list"></ul>';
            if (name === 'promptManagerListHeader') return '<li class="pm-list-header">List Header</li>';
            return '';
        });
        mocks.script.main_api = 'openai';
        mocks.script.is_send_press = false;
        document.body.innerHTML = '';
    });

    afterEach(async () => {
        window.requestAnimationFrame = originalRaf;
        document.body.innerHTML = '';
        await Promise.resolve();
    });

    test('gates rendering through resolvePromptManagerRenderState before waiting for generation', () => {
        const { manager } = createMountedManager({ strategy: 'character' });
        manager.activeCharacter = null;

        manager.render(true);

        expect(resolveRenderStateSpy).toHaveBeenCalledWith(expect.objectContaining({
            mainApi: 'openai',
            promptOrderStrategy: 'character',
            hasActiveCharacter: false,
            afterTryGenerate: true,
        }));
        expect(waitUntilConditionMock).not.toHaveBeenCalled();

        // Decision helper returning no-render/no-wait stops render() before waiting.
        resolveRenderStateSpy.mockReturnValueOnce({
            shouldRender: false,
            shouldWaitForGeneration: false,
            shouldRunDryGenerate: false,
        });
        manager.activeCharacter = { id: 100001 };
        manager.render(true);
        expect(waitUntilConditionMock).not.toHaveBeenCalled();
    });

    test('re-checks resolvePromptManagerRenderState after waiting and runs dry generate when requested', async () => {
        waitUntilConditionMock.mockImplementation(() => new Promise(resolve => { waitResolver = resolve; }));
        const { manager } = createMountedManager();

        manager.render(true);
        expect(manager.tryGenerate).not.toHaveBeenCalled();

        waitResolver(true);
        await flushAsync();

        expect(resolveRenderStateSpy).toHaveBeenCalledTimes(2);
        expect(manager.tryGenerate).toHaveBeenCalledTimes(1);
    });

    test('preserves desktop split prompt list scroll before shell fallback and restores via animation frame', async () => {
        const { manager, shellScroller } = createMountedManager({ desktopSplit: true });
        const listElement = document.getElementById('completion_prompt_manager_list');
        listElement.scrollTop = 180;
        listElement.scrollTo = jest.fn();
        shellScroller.scrollTop = 40;

        // Wire scrollTo onto the newly rebuilt list element during renderPromptManager.
        const originalRenderPM = manager.renderPromptManager.bind(manager);
        manager.renderPromptManager = async (...args) => {
            const ok = await originalRenderPM(...args);
            if (manager.listElement) manager.listElement.scrollTo = jest.fn();
            return ok;
        };

        manager.render(false);
        await flushAsync();

        // Restored onto the desktop split list element, not the outer shell scroller.
        expect(resolveScrollRestoreSpy).toHaveBeenCalledWith({ scrollPosition: 180 });
        expect(manager.listElement.scrollTo).toHaveBeenCalledWith(0, 180);
        expect(shellScroller.scrollTo).not.toHaveBeenCalled();

        // Deferred animation-frame restore replays the exact scroll position after reflow.
        expect(rafCallbacks.length).toBeGreaterThan(0);
        rafCallbacks.forEach(cb => cb());
        expect(manager.listElement.scrollTo).toHaveBeenCalledTimes(2);
    });

    test('falls back to the shell panel scroller when not in desktop split layout', async () => {
        const { manager, shellScroller } = createMountedManager({ desktopSplit: false });
        shellScroller.scrollTop = 95;

        manager.render(false);
        await flushAsync();

        expect(shellScroller.scrollTo).toHaveBeenCalledWith(0, 95);
        rafCallbacks.forEach(cb => cb());
        expect(shellScroller.scrollTo).toHaveBeenCalledTimes(2);
    });

    test('captures scroll position before save-triggered render and restores it afterwards', async () => {
        const { manager, shellScroller } = createMountedManager({ desktopSplit: false });
        shellScroller.scrollTop = 210;

        manager.handleSavePrompt({
            currentTarget: { dataset: { pmPrompt: 'main' } },
        });
        // Even if the container scrolls back to 0 during hide/reflow before render reads it, the queued position wins.
        shellScroller.scrollTop = 0;

        await flushAsync();

        expect(shellScroller.scrollTo).toHaveBeenCalledWith(0, 210);
    });

    test('drops stale async render writes when a newer render supersedes them', async () => {
        const { manager } = createMountedManager();
        const headerResolvers = [];
        const listHeaderResolvers = [];
        renderTemplateMock.mockImplementation(name => new Promise(resolve => {
            if (name === 'promptManagerHeader') headerResolvers.push(resolve);
            else if (name === 'promptManagerListHeader') listHeaderResolvers.push(resolve);
            else resolve('');
        }));

        // Start render #1 and pause while awaiting promptManagerHeader.
        manager.render(false);
        await flushAsync();
        expect(headerResolvers).toHaveLength(1);

        // Supersede with render #2.
        manager.render(false);
        await flushAsync();
        expect(headerResolvers).toHaveLength(2);

        // Complete render #2 completely first.
        headerResolvers[1]('<div class="pm-header">Fresh Header</div><ul id="completion_prompt_manager_list"></ul>');
        await flushAsync();
        expect(listHeaderResolvers).toHaveLength(1);
        listHeaderResolvers[0]('<li class="pm-list-header">Fresh List</li>');
        await flushAsync();

        expect(document.querySelector('.pm-header')?.textContent).toBe('Fresh Header');
        expect(document.querySelector('.pm-list-header')?.textContent).toBe('Fresh List');

        // Now resolve stale render #1 — it must NOT overwrite or clear the fresh DOM.
        headerResolvers[0]('<div class="pm-header">Stale Header</div><ul id="completion_prompt_manager_list"></ul>');
        await flushAsync();

        expect(document.querySelector('.pm-header')?.textContent).toBe('Fresh Header');
        expect(document.querySelector('.pm-list-header')?.textContent).toBe('Fresh List');
    });
});
