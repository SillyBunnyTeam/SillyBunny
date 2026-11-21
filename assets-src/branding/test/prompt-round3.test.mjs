import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const kit = loadPromptKit(PROMPTS);
const read = (name) => readFileSync(join(PROMPTS, name), 'utf8');
const tewi = read('character-tewi.md');

const sheet = (characters, refCount = 0) => composePrompt(kit, 'design-sheet-illustrated', { vars: {}, characters, refCount }).prompt;

test('Tewi\'s file never reads as a child', () => {
    for (const banned of [/child/i, /childlike/i, /little girl/i, /youthful-looking/i, /rosy cheeks/i, /small, youthful/i]) {
        assert.ok(!banned.test(tewi), `Tewi's file matches ${banned}`);
    }
});

test('Tewi is petite but mature in proportions and bearing, and her kept traits are still there', () => {
    assert.match(tewi, /petite and slender/);
    assert.match(tewi, /young woman's proportions/);
    assert.match(tewi, /about 6 heads tall/);
    assert.match(tewi, /narrow(er)? face with a defined chin/);
    assert.match(tewi, /less rounded cheeks/);
    assert.match(tewi, /sly, knowing, self-assured/);
    assert.match(tewi, /half-lidded/);
    assert.match(tewi, /confident little smile/);
    assert.match(tewi, /very old and very clever/);
    assert.match(tewi, /smooth, ageless/);
    assert.match(tewi, /Eyes: dark red/);
    assert.match(tewi, /Hair: black, short to shoulder length, slightly wavy and tousled/);
    assert.match(tewi, /ankle-length plain white socks and no shoes/i);
    assert.match(tewi, /lucky carrot necklace/);
    assert.match(tewi, /small round fluffy white rabbit tail/);
    assert.match(tewi, /twitch one at a time/);
});

test('Tewi\'s file no longer says she is barefoot', () => {
    assert.ok(!/barefoot|bare feet|no socks/i.test(tewi));
});

test('Tewi wears the simple pink dress, ankle socks and the carrot necklace from the approved sheet', () => {
    assert.match(tewi, /simple pink dress with short puffed sleeves and frilled cuffs/);
    assert.match(tewi, /small ruffled collar/);
    assert.match(tewi, /simple flared skirt falling just below the knee/);
    assert.match(tewi, /single ruffle at the hem and a thin red trim line/);
    for (const banned of ['layered petticoats', 'lace', 'polka dots', 'white panels', 'large bow']) {
        assert.match(tewi, new RegExp(`no ${banned}`), `the outfit should rule out ${banned}`);
    }
    assert.ok(!/pink and white|dotted|gathered waist|wide flared|no necklace/i.test(tewi), 'the old outfit wording is gone');
    assert.match(tewi, /small orange carrot pendant with a short green leafy top on a long, loose, thin dark cord/);
    assert.match(tewi, /pendant rests at mid-chest/);
    assert.match(tewi, /cord hangs naturally with gravity and swings with her movement/);
    assert.match(tewi, /In back views only the cord shows, crossing her bare nape below the hair, with no pendant at the back/);
});

test('mature means proportions and expression: Tewi stays modest and SFW', () => {
    const prompt = sheet(['tewi']);
    assert.match(prompt, /Modest clothing exactly as described/);
    assert.match(prompt, /no suggestive poses/i);
    assert.ok(!/(curvy|busty|seductive|sultry|sexy|voluptuous|alluring)/i.test(prompt));
});

test('a character file never compares itself with another character; only the line-up does', () => {
    for (const name of ['character-tewi.md', 'character-reisen.md']) {
        assert.ok(!/taller character|than reisen|shorter than|taller than/i.test(read(name)), name);
    }
    const single = sheet(['tewi']);
    assert.ok(!/taller|smaller than/i.test(single));
    const lineup = composePrompt(kit, 'lineup', { vars: {}, refCount: 2 }).prompt;
    assert.match(lineup, /Character 2's head reaches roughly to character 1's shoulder/);
    assert.match(lineup, /character 2 is clearly (shorter|smaller) and more petite/);
    assert.ok(!/younger-looking/.test(lineup));
});

test('with a reference attached, the design sheet says it is a style reference for a different character', () => {
    const prompt = sheet(['tewi'], 1);
    assert.match(prompt, /The attached image is a style reference only/);
    assert.match(prompt, /design sheet of a different character/);
    for (const matched of ['sticker outline', 'line art', 'shading', 'colour treatment', 'proportions style', 'sheet layout']) {
        assert.ok(prompt.includes(matched), `style reference should name ${matched}`);
    }
    assert.match(prompt, /Do not copy that character's hair, outfit, rabbit ears or face/);
    assert.ok(!/approved references for the same characters/.test(prompt));
});

test('without a reference the style-reference paragraph is absent', () => {
    assert.ok(!/style reference only/.test(sheet(['tewi'], 0)));
});

test('the line-up and card keep the same-character references paragraph', () => {
    for (const [template, vars] of [['lineup', {}], ['card-portrait', { pose: 'waving' }]]) {
        const { prompt } = composePrompt(kit, template, { vars, refCount: 2 });
        assert.match(prompt, /approved references for the same characters/);
        assert.ok(!/style reference only/.test(prompt));
    }
});
