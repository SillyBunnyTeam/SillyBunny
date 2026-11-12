/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { test, expect } from '@jest/globals';
import { initAccessibility } from '../../public/scripts/a11y.js';

test('legacy accessibility preserves display-only metadata without changing actionable tags', async () => {
    document.body.innerHTML = '<div class="ds-entity-row"><div class="ds-entity-row__tags tags">'
        + '<span class="tag">Display</span><span class="tag sb-tag-overflow">+2</span>'
        + '<span class="tag actionable">Action</span><span class="tag clickable-action">Custom action</span><span class="tag">Removable<button class="tag_remove"></button></span>'
        + '</div></div><div class="tags"><span class="tag">Legacy</span></div>';
    initAccessibility();
    const roles = () => [...document.querySelectorAll('.tag')].map(tag => tag.getAttribute('role'));
    expect(roles()).toEqual(['generic', 'generic', 'button', 'button', 'button', 'button']);
    const added = document.createElement('span');
    added.className = 'tag';
    document.querySelector('.ds-entity-row__tags').append(added);
    await Promise.resolve();
    expect(added.getAttribute('role')).toBe('generic');
});
