import { expect, test } from '@playwright/test';
import { visibleContent } from '../helpers/surfaces/content.js';

// The smoke's test for "the root shows something", on roots of each shape. It needs no server: the page is built here.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const CASES = [
    ['an image-only root', `<div id="root" style="width:40px;height:40px"><img src="${PIXEL}" width="40" height="40"></div>`, 'media'],
    ['a root that is an image', `<img id="root" src="${PIXEL}" width="40" height="40">`, 'media'],
    ['a root that is a single button', '<button id="root">Go</button>', 'control'],
    ['a root with a control inside', '<div id="root"><button>Go</button></div>', 'control'],
    ['a canvas root', '<div id="root"><canvas width="20" height="20"></canvas></div>', 'media'],
    ['a root with text', '<div id="root" style="width:40px">Hello</div>', 'text'],
    ['an empty root that only script can focus', '<div id="root" tabindex="-1" style="width:40px;height:40px"></div>', null],
    ['a hidden single button', '<button id="root" style="visibility:hidden">Go</button>', null],
    ['a root with tabbable content', '<div id="root"><span tabindex="0">Go</span></div>', 'control'],
    ['an empty root', '<div id="root" style="width:40px;height:40px"></div>', null],
    ['a root with an image that has not loaded', '<div id="root"><img src="data:image/png;base64,AAAA" width="40" height="40"></div>', null],
    ['a root with a hidden image only', `<div id="root"><img src="${PIXEL}" style="visibility:hidden" width="40" height="40"></div>`, null],
    ['a root with a zero-size image only', `<div id="root"><img src="${PIXEL}" width="0" height="0"></div>`, null],
];

for (const [name, markup, expected] of CASES) {
    test(`${name}`, async ({ page }) => {
        await page.setContent(markup);
        await page.locator('#root img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
        expect(await page.locator('#root').evaluate(visibleContent)).toBe(expected);
    });
}
