import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');

/** The values that a `<select id>` of index.html lists. */
function optionValues(html, id) {
    const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? '';
    return [...select.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
}

describe('Connections model selects list the default of their setting', () => {
    const html = read('index.html');
    const openai = read('scripts/openai.js');
    const defaultOf = setting => openai.match(new RegExp(`\\n    ${setting}: '([^']*)',`))?.[1];

    test.each([
        ['moonshot_model', 'model_moonshot_select'],
        ['pollinations_model', 'model_pollinations_select'],
    ])('%s is an option of #%s', (setting, id) => {
        const value = defaultOf(setting);
        expect(value).toBeTruthy();
        expect(optionValues(html, id)).toContain(value);
    });
});
