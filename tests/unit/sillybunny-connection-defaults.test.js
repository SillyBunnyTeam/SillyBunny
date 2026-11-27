import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { importOpenAiModule } from '../util/openai-harness.js';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const { openai } = await importOpenAiModule();

/** The values that a `<select id>` of index.html lists. */
function optionValues(documentHtml, id) {
    const select = documentHtml.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? '';
    return [...select.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
}

describe('Connections model selects list the default of their setting', () => {
    test.each([
        ['moonshot_model', 'model_moonshot_select'],
        ['pollinations_model', 'model_pollinations_select'],
    ])('%s is an option of #%s', (setting, id) => {
        const value = openai.oai_settings[setting];
        expect(value).toBeTruthy();
        expect(optionValues(html, id)).toContain(value);
    });
});
