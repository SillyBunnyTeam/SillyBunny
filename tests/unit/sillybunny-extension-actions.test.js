/** @jest-environment jsdom */
import { expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
const { unobserveRemovedRows } = await import('../../public/scripts/sillybunny-extension-actions.js');

test('unobserves extension rows removed with a manager subtree', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="extensions_info"><div class="extension_block"><div class="extension_block"></div></div></div>';
    const observer = { unobserve: jest.fn() };
    const removed = root.querySelector('.extension_block');

    unobserveRemovedRows(removed, observer);

    expect(observer.unobserve).toHaveBeenCalledTimes(2);
    expect(observer.unobserve).toHaveBeenNthCalledWith(1, removed);
    expect(observer.unobserve).toHaveBeenNthCalledWith(2, removed.firstElementChild);
});
