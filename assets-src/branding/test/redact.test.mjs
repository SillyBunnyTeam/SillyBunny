import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactHeaders, redactText, redactUrl } from '../scripts/lib/redact.mjs';

const KEY = 'sk-test-0123456789abcdefABCDEF';
const GEMINI_KEY = 'AIzaSyFAKE0123456789abcdefghijklmnopq';

test('redactHeaders hides Authorization and x-goog-api-key in any letter case', () => {
    const shown = redactHeaders({
        Authorization: `Bearer ${KEY}`,
        'X-Goog-Api-Key': GEMINI_KEY,
        'content-type': 'application/json',
    });
    assert.equal(shown.Authorization, '[REDACTED]');
    assert.equal(shown['X-Goog-Api-Key'], '[REDACTED]');
    assert.equal(shown['content-type'], 'application/json');
    assert.ok(!JSON.stringify(shown).includes(KEY));
    assert.ok(!JSON.stringify(shown).includes(GEMINI_KEY));
});

test('redactUrl strips key= query values and keeps the rest', () => {
    const shown = redactUrl(`https://relay.example/v1beta/models/m:generateContent?alt=json&key=${GEMINI_KEY}`);
    assert.ok(!shown.includes(GEMINI_KEY));
    assert.match(shown, /alt=json/);
    assert.match(shown, /key=%5BREDACTED%5D|key=\[REDACTED\]/);
});

test('redactUrl leaves text that is not a URL untouched', () => {
    assert.equal(redactUrl('not a url'), 'not a url');
});

test('redactText removes known secrets, bearer tokens, key= pairs and Google key shapes', () => {
    const text = [
        `upstream said: invalid token ${KEY}`,
        `Authorization: Bearer ${KEY}`,
        `GET /x?key=${GEMINI_KEY}&alt=json`,
        `x-goog-api-key: ${GEMINI_KEY}`,
        `stray ${GEMINI_KEY}`,
    ].join('\n');
    const shown = redactText(text, [KEY]);
    assert.ok(!shown.includes(KEY));
    assert.ok(!shown.includes(GEMINI_KEY));
    assert.match(shown, /invalid token/);
});

test('redactText ignores empty secrets instead of blanking the whole text', () => {
    assert.equal(redactText('plain message', ['', undefined]), 'plain message');
});
