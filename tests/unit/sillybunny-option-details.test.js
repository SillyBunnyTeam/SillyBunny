/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { describe, test, expect } from '@jest/globals';
import {
    badge,
    createDetailsMapper,
    detailsToText,
    hasOptionDetails,
    icon,
    link,
    registerOptionDetails,
    renderDetails,
    toDetails,
} from '../../public/scripts/sillybunny-editor/option-details.js';

const HOSTILE = '<img src=x onerror="window.__injected = true">';

function html(markup) {
    const host = document.createElement('div');
    host.innerHTML = markup;
    return host.firstElementChild;
}

function rendered(details) {
    const host = document.createElement('span');
    host.append(renderDetails(details));
    return host;
}

describe('toDetails with segments', () => {
    test('joins strings and icons by a middle dot and keeps icons named', () => {
        const details = toDetails(['128000 ctx', '$0.15/$0.6 in/out Mtoken', [icon('fa-solid fa-eye fa-sm', 'This model supports vision'), ' ', icon('fa-solid fa-brain', 'This model supports reasoning')]]);
        expect(detailsToText(details)).toBe('128000 ctx · $0.15/$0.6 in/out Mtoken · This model supports vision This model supports reasoning');
        const host = rendered(details);
        expect(host.textContent.trim()).toBe('128000 ctx · $0.15/$0.6 in/out Mtoken ·');
        const icons = [...host.querySelectorAll('i')];
        expect(icons.map(node => node.getAttribute('aria-label'))).toEqual(['This model supports vision', 'This model supports reasoning']);
        expect(icons.map(node => node.getAttribute('title'))).toEqual(['This model supports vision', 'This model supports reasoning']);
        expect(icons.every(node => node.getAttribute('role') === 'img')).toBe(true);
        expect(icons[0].className).toBe('fa-solid fa-eye fa-sm');
    });

    test('drops empty segments and reports nothing to show as null', () => {
        expect(toDetails(['', null, false, ['  ']])).toBeNull();
        expect(toDetails(null)).toBeNull();
        expect(toDetails([])).toBeNull();
        expect(detailsToText(toDetails(['', 'Free', undefined]))).toBe('Free');
    });

    test('a badge keeps its tooltip and hides its decorative icon', () => {
        const details = toDetails([[badge('Sub (2x)', { title: 'Included in subscription - Input Multiplier: 2x', classes: 'fa-solid fa-crown fa-xs' })]]);
        const host = rendered(details);
        const small = host.querySelector('small');
        expect(small.getAttribute('title')).toBe('Included in subscription - Input Multiplier: 2x');
        expect(small.textContent.trim()).toBe('Sub (2x)');
        expect(small.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        expect(small.querySelector('i').hasAttribute('role')).toBe(false);
        expect(detailsToText(details)).toBe('Sub (2x)');
    });

    test('hostile text stays text, wherever it appears', () => {
        const details = toDetails([`${HOSTILE} ctx`, [badge(HOSTILE, { title: HOSTILE })], [icon('fa-solid fa-eye', HOSTILE)]]);
        const host = rendered(details);
        expect(host.querySelectorAll('img')).toHaveLength(0);
        expect(host.textContent).toContain(`${HOSTILE} ctx`);
        expect(host.querySelector('small').getAttribute('title')).toBe(HOSTILE);
        expect(window.__injected).toBeUndefined();
    });
});

describe('toDetails allow-list', () => {
    test('keeps only span, small and i, with title, aria-label, aria-hidden and Font Awesome classes', () => {
        const node = html(`<div>
            <script>window.__injected = true</script>
            <b onclick="window.__injected = true">bold</b>
            <small title="Tip" onmouseover="window.__injected = true" style="color: red" data-x="1" id="x">small</small>
            <i class="fa-solid fa-eye evil-class onclick" title="Eye" aria-label="Eye" aria-hidden="false" onclick="window.__injected = true"></i>
            <span class="fa-solid" title="Span title">span text</span>
            <a href="javascript:window.__injected = true" title="Link">link text</a>
            <iframe src="javascript:window.__injected = true"></iframe>
            <img src="javascript:window.__injected = true" onerror="window.__injected = true">
        </div>`);
        const host = rendered(toDetails(node));
        expect(host.querySelectorAll('script, iframe, img, a, b')).toHaveLength(0);
        expect(host.querySelector('[onclick], [onmouseover], [onerror], [style], [href], [src], [id], [data-x]')).toBeNull();
        expect(host.textContent).toContain('bold');
        expect(host.textContent).not.toContain('link text');
        expect(host.textContent).not.toContain('__injected');
        const small = host.querySelector('small');
        expect(small.getAttributeNames()).toEqual(['title']);
        const eye = host.querySelector('i');
        expect(eye.getAttribute('class')).toBe('fa-solid fa-eye');
        expect(eye.getAttribute('aria-hidden')).toBeNull();
        const span = host.querySelector('span[title]');
        expect(span.hasAttribute('class')).toBe(false);
        expect(window.__injected).toBeUndefined();
    });

    test('a javascript: URL or event handler in a template result never reaches the DOM', () => {
        const node = html('<div><a href="javascript:alert(1)">x</a><span onclick="alert(1)">visible</span> <i class="fa-solid fa-star" onclick="alert(1)" title="Popular"></i></div>');
        const host = rendered(toDetails(node));
        expect(host.innerHTML).not.toMatch(/javascript:|onclick|href/);
        expect(detailsToText(toDetails(node))).toBe('visible Popular');
    });

    test('limits attribute values to text of a sane length', () => {
        const details = toDetails([[{ tag: 'small', attrs: { title: 'x'.repeat(2000) }, children: ['Sub'] }]]);
        expect(rendered(details).querySelector('small').getAttribute('title')).toHaveLength(300);
    });

    test('an unknown tag in a tree is unwrapped to its text and its attributes are dropped', () => {
        const details = toDetails([[{ tag: 'img', attrs: { src: 'x', onerror: 'y' }, children: ['alt text'] }, { tag: 'b', attrs: { onclick: 'y' }, children: ['bold'] }]]);
        expect(rendered(details).innerHTML).toBe('alt textbold');
    });
});

describe('toDetails with select2 template output', () => {
    test('splits the OpenRouter-style template at the | separators and leaves out the name', () => {
        const node = html('<div class="flex-container flexFlowColumn" title="vendor/model"><div><strong>Model Name</strong> | 128000 ctx | <small>Free</small></div></div>');
        expect(detailsToText(toDetails(node))).toBe('128000 ctx · Free');
    });

    test('reads a jQuery object and the NanoGPT shape: icons and a badge after the price', () => {
        const row = html(`<span class="flex-container" title="gpt-4o-mini"><strong>Nano Tiny</strong> | 128000 ctx | <small>$0.15/$0.6 in/out Mtoken</small> | <span>
            <i class="fa-solid fa-eye fa-sm" title="This model supports vision" aria-label="This model supports vision"></i>
            <i class="fa-solid fa-brain fa-sm" title="This model supports reasoning" aria-label="This model supports reasoning"></i>
            <small title="Included in subscription"><i class="fa-solid fa-crown fa-xs" aria-hidden="true"></i> Sub</small></span></span>`);
        const details = toDetails({ jquery: '3', toArray: () => [row] });
        expect(detailsToText(details)).toBe('128000 ctx · $0.15/$0.6 in/out Mtoken · This model supports vision This model supports reasoning Sub');
        const host = rendered(details);
        expect(host.querySelectorAll('i[aria-label]')).toHaveLength(2);
        expect(host.querySelector('small[title="Included in subscription"]').textContent.trim()).toBe('Sub');
        expect(host.querySelector('strong')).toBeNull();
    });

    test('a hostile name in the bold part is dropped; a hostile field stays text', () => {
        const row = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = HOSTILE;
        row.append(name, document.createTextNode(` | ${HOSTILE} ctx`));
        const details = toDetails(row);
        expect(detailsToText(details)).toBe(`${HOSTILE} ctx`);
        expect(rendered(details).querySelectorAll('img')).toHaveLength(0);
    });

    test('block elements separate segments and a string means no details', () => {
        const node = html('<div><div><strong>Name</strong> | 4096 tokens</div><div><small>A description</small></div></div>');
        expect(detailsToText(toDetails(node))).toBe('4096 tokens · A description');
        expect(toDetails('Plain option text')).toBeNull();
    });
});

describe('links in details', () => {
    const linked = (url, text = 'inner') => ['Name', [{ tag: 'a', attrs: { href: url, class: 'fa-solid fa-circle-question' }, children: [text] }]];

    test('a valid https URL with a query is kept as its normalised address, with target and rel forced', () => {
        const details = toDetails([[link('https://example.com/models?id=1&tag=a b#top', { classes: 'fa-solid fa-circle-question evil', label: 'Details' })]]);
        const anchor = rendered(details).querySelector('a');
        expect(anchor.getAttribute('href')).toBe('https://example.com/models?id=1&tag=a%20b#top');
        expect(anchor.getAttribute('target')).toBe('_blank');
        expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
        expect(anchor.getAttribute('class')).toBe('fa-solid fa-circle-question');
        expect(anchor.getAttribute('title')).toBe('Details');
        expect(anchor.getAttribute('aria-label')).toBe('Details');
        expect(anchor.getAttributeNames().sort()).toEqual(['aria-label', 'class', 'href', 'rel', 'target', 'title']);
    });

    test.each([
        ['javascript:', 'javascript:alert(1)'],
        ['data:', 'data:text/html,<script>alert(1)</script>'],
        ['protocol-relative', '//example.com/page'],
        ['relative path', '/models/page'],
        ['scheme-less', 'example.com/page'],
        ['credentials', 'http://user:pass@example.com/'],
        ['username only', 'https://user@example.com/'],
        ['ftp', 'ftp://example.com/file'],
        ['missing slashes', 'https:example.com'],
        ['not a string', 42],
        ['empty', ''],
    ])('a link to %s is dropped with its content', (_name, url) => {
        const details = toDetails(linked(url, 'link text'));
        expect(rendered(details).querySelector('a')).toBeNull();
        expect(rendered(details).textContent).toBe('Name');
        expect(detailsToText(details)).toBe('Name');
    });

    test('target, rel and other attributes from the catalogue are never copied', () => {
        const node = html('<div><a href="http://example.com/a" target="_self" rel="opener" onclick="window.__injected = true" style="color: red" id="x" download title="Tip" class="model-details-link fa-solid fa-circle-question"> </a></div>');
        const anchor = rendered(toDetails(node)).querySelector('a');
        expect(anchor.getAttribute('target')).toBe('_blank');
        expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
        expect(anchor.getAttributeNames().sort()).toEqual(['class', 'href', 'rel', 'target', 'title']);
        expect(anchor.getAttribute('class')).toBe('fa-solid fa-circle-question');
        expect(window.__injected).toBeUndefined();
    });

    test('select2 template output goes through the same check', () => {
        const valid = html('<div><strong>Name</strong> <a href="https://example.com/m" class="fa-solid fa-circle-question"> </a> | Story</div>');
        expect(rendered(toDetails(valid)).querySelectorAll('a')).toHaveLength(1);
        const bad = html('<div><strong>Name</strong> <a href="javascript:alert(1)">gone</a> | Story</div>');
        const details = toDetails(bad);
        expect(rendered(details).querySelector('a')).toBeNull();
        expect(detailsToText(details)).toBe('Story');
        const nested = rendered(toDetails(['x', [{ tag: 'a', attrs: { href: 'https://a.example/' }, children: [{ tag: 'a', attrs: { href: 'https://b.example/' }, children: ['inner'] }] }]]));
        expect(nested.querySelectorAll('a')).toHaveLength(1);
    });

    test('a link adds nothing to the plain text that search matches, and a link alone still renders', () => {
        const details = toDetails([['128000 ctx'], ['Name', ' ', link('https://example.com/', { classes: 'fa-solid fa-circle-question', label: 'Details' })]]);
        expect(detailsToText(details)).toBe('128000 ctx · Name');
        const only = toDetails([[link('https://example.com/', { label: 'Details' })]]);
        expect(detailsToText(only)).toBe('');
        expect(rendered(only).querySelectorAll('a')).toHaveLength(1);
    });

    test('the mapper keeps a link-only result as details with an empty subtitle', () => {
        registerOptionDetails({ link_only_select: () => [[link('https://example.com/', { label: 'Details' })]] });
        const mapped = createDetailsMapper('link_only_select')({ value: 'a', label: 'a' }, Object.assign(document.createElement('option'), { value: 'a' }));
        expect(mapped.subtitle).toBe('');
        expect(mapped.details).toHaveLength(1);
    });
});

describe('createDetailsMapper', () => {
    const option = value => Object.assign(document.createElement('option'), { value, textContent: value });

    test('adds the subtitle, its plain text and the details to the item of a registered select', () => {
        registerOptionDetails({ mapper_fixture_select: opt => [`${opt.value} ctx`, [icon('fa-solid fa-eye', 'Vision')]] });
        expect(hasOptionDetails('mapper_fixture_select')).toBe(true);
        const mapItem = createDetailsMapper('mapper_fixture_select');
        const item = { value: 'a', label: 'a' };
        const mapped = mapItem(item, option('a'));
        expect(mapped).toMatchObject({ value: 'a', label: 'a', subtitle: 'a ctx · Vision' });
        expect(mapped.details).toHaveLength(2);
        expect(item.subtitle).toBeUndefined();
    });

    test('returns the item as it is for a select with no describer, no result or a failing describer', () => {
        registerOptionDetails({ mapper_empty_select: () => null, mapper_failing_select: () => { throw new Error('bad entry'); } });
        const item = { value: 'a', label: 'a' };
        expect(createDetailsMapper('mapper_unregistered_select')(item, option('a'))).toBe(item);
        expect(createDetailsMapper('mapper_empty_select')(item, option('a'))).toBe(item);
        expect(createDetailsMapper('mapper_failing_select')(item, option('a'))).toBe(item);
    });

    test('looks the describer up on every call, so a late registration applies to an existing mapper', () => {
        const mapItem = createDetailsMapper('mapper_late_select');
        const item = { value: 'a', label: 'a' };
        expect(mapItem(item, option('a'))).toBe(item);
        registerOptionDetails({ mapper_late_select: () => ['Late'] });
        expect(mapItem(item, option('a')).subtitle).toBe('Late');
    });

    test('rejects a describer that is not a function', () => {
        expect(() => registerOptionDetails({ mapper_bad_select: 'x' })).toThrow(TypeError);
    });
});
