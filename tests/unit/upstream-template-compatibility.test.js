/** @jest-environment jsdom */
import { expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const templates = [
    'public/scripts/templates/dataMaidCategory.html',
    'public/scripts/templates/dataMaidDialog.html',
    'public/scripts/extensions/regex/debugger.html',
];

function templateAttributes(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const elements = [...template.content.querySelectorAll('*')];
    return {
        classes: new Set(elements.flatMap(element => [...element.classList])),
        ids: new Set(elements.map(element => element.id).filter(Boolean)),
        i18n: new Set(elements.flatMap(element => (element.getAttribute('data-i18n') ?? '').split(';').filter(Boolean))),
    };
}

test.each(templates)('%s retains every upstream class, id and i18n key', path => {
    const upstream = execFileSync('git', ['show', `HEAD:${path}`], { cwd: repositoryRoot, encoding: 'utf8' });
    const working = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    const original = templateAttributes(upstream);
    const current = templateAttributes(working);

    for (const attribute of ['classes', 'ids', 'i18n']) {
        expect([...current[attribute]]).toEqual(expect.arrayContaining([...original[attribute]]));
    }
});
