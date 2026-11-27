/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static markup checks. */
import { afterEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importOpenAiModule } from './util/openai-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const jquerySource = readFileSync(path.join(repoRoot, 'public', 'lib', 'jquery-3.5.1.min.js'), 'utf8');

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai } = await importOpenAiModule({ mockToolCalling: false });
const { ToolManager } = await import('../public/scripts/tool-calling.js');

describe('tool call recurse limit wiring', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        ToolManager.RECURSE_LIMIT = 5;
    });

    test('defaults the slider and number counter to the real runtime cap', () => {
        expect(indexHtml).toContain('id="tool_call_recurse_limit"');
        expect(indexHtml).toContain('id="tool_call_recurse_limit" name="tool_call_recurse_limit" min="1" max="50" step="1" value="5"');
        expect(indexHtml).toContain('id="tool_call_recurse_limit_counter" value="5"');
        expect(ToolManager.RECURSE_LIMIT).toBe(5);
    });

    test('maps the control through OpenAI preset settings', () => {
        expect(openai.settingsToUpdate.tool_call_recurse_limit).toEqual(['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false]);
        expect(openai.oai_settings.tool_call_recurse_limit).toBe(5);
    });

    test('loads and changes the setting through ToolManager.RECURSE_LIMIT', () => {
        document.body.innerHTML = `
            <input id="tool_call_recurse_limit" type="range" min="1" max="50" step="1" value="5" />
            <input id="tool_call_recurse_limit_counter" type="number" value="5" />
        `;

        openai.loadOpenAISettings({ openai_settings: [], openai_setting_names: [] }, {
            tool_call_recurse_limit: 12,
        });
        expect(ToolManager.RECURSE_LIMIT).toBe(12);
        expect(openai.oai_settings.tool_call_recurse_limit).toBe(12);

        openai.initOpenAI();
        $('#tool_call_recurse_limit').val('19').trigger('input');
        expect(ToolManager.RECURSE_LIMIT).toBe(19);
        expect(openai.oai_settings.tool_call_recurse_limit).toBe(19);
    });
});
