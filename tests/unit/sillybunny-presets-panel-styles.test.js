/* eslint-disable playwright/no-standalone-expect -- Jest contract for a static file. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';

const tabs = fs.readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-tabs.js', import.meta.url)), 'utf8');

test('the Presets page loads the entity list sheet, because NovelAI\'s Logit Bias entries are entity rows', () => {
    const block = /'left:prompting': \[([^\]]*)\]/.exec(tabs)?.[1] ?? '';
    expect(block).toContain('css/sillybunny-entity-list.css?v=');
});
