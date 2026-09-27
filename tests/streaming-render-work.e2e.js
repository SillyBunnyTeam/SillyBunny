import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const scriptSource = read('../public/script.js');
const copyFunction = scriptSource.match(/^export function addCopyToCodeBlocks\([\s\S]*?^}/m)[0];
const modules = new Map([
    ['/scripts/util/stream-fadein.js', read('../public/scripts/util/stream-fadein.js')],
    ['/scripts/a11y.js', read('../public/scripts/a11y.js')],
    ['/lib.js', 'export { default as morphdom } from \'/morphdom.js\';'],
    ['/morphdom.js', read('../node_modules/morphdom/dist/morphdom-esm.js')],
    ['/jquery.js', read('../public/lib/jquery-3.5.1.min.js')],
    ['/copy.js', copyFunction],
]);

test.beforeEach(async ({ page }) => {
    // Isolated browser fixture: no running server, provider, account, or persisted chat data.
    await page.route('http://stream-render.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        await route.fulfill({
            status: 200,
            contentType: pathname === '/' ? 'text/html' : 'text/javascript',
            body: pathname === '/' ? '<!doctype html><html><body></body></html>' : modules.get(pathname) ?? '',
        });
    });
    await page.goto('http://stream-render.test/');
});

for (const mode of ['plain', 'fade', 'bypass']) {
    test(`preserves unchanged blocks and still revises earlier formatting with ${mode}`, async ({ page }) => {
        const result = await page.evaluate(async mode => {
            const { applyStreamDomPatch, applyStreamFadeIn } = await import('/scripts/util/stream-fadein.js');
            const element = document.createElement('div');
            document.body.append(element);
            const update = html => mode === 'plain' ? applyStreamDomPatch(element, html)
                : applyStreamFadeIn(element, html, { bypassFadeIn: mode === 'bypass' });
            update('<p>Finished <em>paragraph</em>.</p><p>Beginning</p>');
            const firstBlock = element.firstChild;
            const emphasis = element.querySelector('em');
            let clicks = 0;
            emphasis.addEventListener('click', () => clicks++);
            const observer = new MutationObserver(() => {});
            observer.observe(firstBlock, { childList: true, subtree: true, attributes: true, characterData: true });
            update('<p>Finished <em>paragraph</em>.</p><p>Beginning and more</p>');
            const unchangedMutations = observer.takeRecords().length;
            const sameBlock = firstBlock === element.firstChild;
            const sameEmphasis = emphasis === element.querySelector('em');
            emphasis.click();

            // A late Markdown reference or a whole-message regex can revise a previously complete block.
            update('<p>Revised <a href="/reference">paragraph</a>.</p><p>Beginning and more</p>');
            const revised = element.querySelector('a')?.getAttribute('href');
            const extensionNode = document.createElement('aside');
            extensionNode.textContent = 'extension replacement';
            element.firstChild.append(extensionNode);
            update('<p>Revised <a href="/reference">paragraph</a>.</p><p>Final text</p>');
            observer.disconnect();
            return { unchangedMutations, sameBlock, sameEmphasis, clicks, revised, extensionStillPresent: element.contains(extensionNode), finalText: element.textContent };
        }, mode);
        expect(result).toEqual({
            unchangedMutations: 0, sameBlock: true, sameEmphasis: true, clicks: 1,
            revised: '/reference', extensionStillPresent: false, finalText: 'Revised paragraph.Final text',
        });
    });
}

test('initializes accessibility once and scans nested additions only once', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const OriginalObserver = window.MutationObserver;
        let observers = 0;
        window.MutationObserver = class extends OriginalObserver {
            constructor(callback) { super(callback); observers++; }
        };
        const { initAccessibility } = await import('/scripts/a11y.js');
        initAccessibility();
        initAccessibility();
        window.MutationObserver = OriginalObserver;

        const parent = document.createElement('div');
        let parentScans = 0;
        let childScans = 0;
        const parentQuery = parent.querySelectorAll.bind(parent);
        parent.querySelectorAll = selector => { parentScans++; return parentQuery(selector); };
        document.body.append(parent);
        const child = document.createElement('div');
        child.className = 'mes_button';
        child.innerHTML = '<span class="menu_button">Extension control</span>';
        const childQuery = child.querySelectorAll.bind(child);
        child.querySelectorAll = selector => { childScans++; return childQuery(selector); };
        parent.append(child);
        await new Promise(resolve => queueMicrotask(resolve));
        return { observers, parentScans, childScans, roles: [child.getAttribute('role'), child.firstChild.getAttribute('role')] };
    });
    expect(result).toEqual({ observers: 1, parentScans: 1, childScans: 0, roles: ['button', 'button'] });
});

test('repeated message refreshes keep one working copy button per code block', async ({ page }) => {
    await page.addScriptTag({ url: 'http://stream-render.test/jquery.js' });
    const result = await page.evaluate(async () => {
        let highlights = 0;
        const copied = [];
        window.hljs = { highlightElement: () => highlights++ };
        window.copyText = async text => copied.push(text);
        window.toastr = { info() {} };
        window.t = strings => strings.join('');
        const { addCopyToCodeBlocks } = await import('/copy.js');
        const message = document.createElement('div');
        message.innerHTML = '<pre><code>const answer = 42;</code></pre>';
        document.body.append(message);
        addCopyToCodeBlocks(message);
        const button = message.querySelector('.code-copy');
        addCopyToCodeBlocks(message);
        addCopyToCodeBlocks(message);
        button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await Promise.resolve();
        return { highlights, copies: message.querySelectorAll('.code-copy').length, sameButton: button === message.querySelector('.code-copy'), copied };
    });
    expect(result).toEqual({ highlights: 1, copies: 1, sameButton: true, copied: ['const answer = 42;'] });
});
