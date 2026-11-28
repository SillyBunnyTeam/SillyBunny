/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static markup/CSS checks. */
import { afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import { importOpenAiModule } from './util/openai-harness.js';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const jquerySource = fs.readFileSync(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8');
const inputTags = indexHtml.match(/<input\b[^>]*>/gi) ?? [];

function getInputById(id) {
    return inputTags.find(tag => tag.includes(`id="${id}"`));
}

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai } = await importOpenAiModule();

describe('secret inputs', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('keeps the proxy access key out of password manager form detection', () => {
        const input = getInputById('openai_proxy_access_key');

        expect(input).toBeDefined();
        expect(input).toContain('type="text"');
        expect(input).toContain('masked-secret');
        expect(input).not.toMatch(/\sform=/i);
        expect(indexHtml).not.toContain('id="openai_proxy_password"');
        expect(styleCss).toMatch(/\.masked-secret\s*{[^}]*-webkit-text-security:\s*disc;/s);

        // Verify openai.js maps proxy_password to #openai_proxy_access_key and guards masked copy/cut.
        expect(openai.settingsToUpdate.proxy_password).toEqual(['#openai_proxy_access_key', 'proxy_password', false, true]);

        document.body.innerHTML = `
            <input id="openai_proxy_access_key" type="text" class="masked-secret" value="secret-token" />
            <button id="openai_proxy_access_key_show" type="button"></button>
        `;
        openai.initOpenAI();

        const keyInput = document.getElementById('openai_proxy_access_key');
        const showButton = document.getElementById('openai_proxy_access_key_show');

        const maskedCopy = new Event('copy', { bubbles: true, cancelable: true });
        keyInput.dispatchEvent(maskedCopy);
        expect(maskedCopy.defaultPrevented).toBe(true);

        const maskedCut = new Event('cut', { bubbles: true, cancelable: true });
        keyInput.dispatchEvent(maskedCut);
        expect(maskedCut.defaultPrevented).toBe(true);

        // Clicking reveal removes masked-secret so copying works when explicitly unmasked.
        showButton.click();
        expect(keyInput.classList.contains('masked-secret')).toBe(false);
        const unmaskedCopy = new Event('copy', { bubbles: true, cancelable: true });
        keyInput.dispatchEvent(unmaskedCopy);
        expect(unmaskedCopy.defaultPrevented).toBe(false);

        showButton.click();
        expect(keyInput.classList.contains('masked-secret')).toBe(true);
    });

    test('uses a regular text input for the Azure API key', () => {
        const input = getInputById('api_key_azure_openai');

        expect(input).toBeDefined();
        expect(input).toContain('type="text"');
    });
});
