import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { MAX_SVG_BYTES, checkFinalSvg } from '../scripts/lib/svg-checks.mjs';

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path fill="#8b64aa" d="M0 0L10 0L10 10Z"/></svg>\n';

test('a plain SVG with a viewBox passes and reports its size raw and gzipped and its viewBox', () => {
    const result = checkFinalSvg(GOOD, 'good.svg');
    assert.deepEqual(result, { bytes: Buffer.byteLength(GOOD), gzipBytes: gzipSync(GOOD).length, viewBox: [0, 0, 1024, 1024] });
});

test('an SVG with no viewBox, or one that is not an SVG at all, is refused', () => {
    assert.throws(() => checkFinalSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'a.svg'), /a\.svg has no viewBox/);
    assert.throws(() => checkFinalSvg('<svg viewBox="0 0 10"></svg>', 'a.svg'), /no viewBox/);
    assert.throws(() => checkFinalSvg('<html></html>', 'a.svg'), /does not start with an <svg>/);
});

test('a width or a height on the root element is refused, but one on an inner element is not the root\'s', () => {
    assert.throws(() => checkFinalSvg(GOOD.replace('<svg ', '<svg width="100" '), 'a.svg'), /width or a height/);
    assert.throws(() => checkFinalSvg(GOOD.replace('<svg ', '<svg height="100" '), 'a.svg'), /width or a height/);
    assert.doesNotThrow(() => checkFinalSvg(GOOD.replace('<path ', '<path stroke-width="2" '), 'a.svg'));
});

test('every kind of metadata is refused by name', () => {
    const cases = [
        ['<metadata>x</metadata>', /<metadata>/],
        ['<title>Logo</title>', /<title>/],
        ['<desc>Logo</desc>', /<desc>/],
        ['<!-- made by -->', /a comment/],
        ['<g inkscape:label="x"/>', /namespaces/],
        ['<script>1</script>', /script or style/],
        ['<style>p{}</style>', /script or style/],
    ];
    for (const [extra, message] of cases) {
        assert.throws(() => checkFinalSvg(GOOD.replace('</svg>', `${extra}</svg>`), 'a.svg'), message, extra);
    }
    assert.throws(() => checkFinalSvg(`<?xml version="1.0"?>${GOOD}`, 'a.svg'), /does not start with an <svg>/);
    assert.throws(() => checkFinalSvg(GOOD.replace('<svg ', '<svg data-x="<!DOCTYPE" '), 'a.svg'), /doctype/);
});

test('a file must be under 12 KB, and exactly 12000 bytes is not under', () => {
    assert.equal(MAX_SVG_BYTES, 12000);
    const padded = (bytes) => GOOD.replace('Z"/>', `Z${' '.repeat(bytes - Buffer.byteLength(GOOD))}"/>`);
    assert.equal(checkFinalSvg(padded(11999), 'a.svg').bytes, 11999);
    assert.throws(() => checkFinalSvg(padded(12000), 'a.svg'), /12000 bytes, which is not under 12000/);
    assert.throws(() => checkFinalSvg(GOOD, 'a.svg', 50), /not under 50/);
});
