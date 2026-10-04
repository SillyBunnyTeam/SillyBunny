import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const welcomeSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8');
const onboardingSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'templates', 'welcomePanelOnboarding.html'), 'utf8');
const defaultContentIndex = JSON.parse(readFileSync(path.join(repoRoot, 'default', 'content', 'index.json'), 'utf8'));
const reisenCard = readFileSync(path.join(repoRoot, 'public', 'img', 'reisen-character-card.png'));

test('Reisen is the active default assistant and Bunny Guide remains archived', () => {
    expect(welcomeSource).toContain('const DEFAULT_BUNDLED_ASSISTANT_ID = \'reisen\';');
    expect(welcomeSource).toContain('id: \'reisen\'');
    expect(welcomeSource).toContain('const ARCHIVED_BUNDLED_ASSISTANTS = Object.freeze([');
    expect(welcomeSource).toContain('id: \'guide\'');
    expect(welcomeSource).toContain('bundledAssistantGuideAvatar');
    expect(welcomeSource).toContain('const WELCOME_BUNDLED_ASSISTANTS = Object.freeze([');
    expect(welcomeSource).toContain('for (const assistant of getAllBundledAssistantConfigs())');
});

test('new-install welcome actions do not point at the archived Bunny Guide', () => {
    expect(onboardingSource).toContain('data-assistant-id="reisen"');
    expect(onboardingSource).not.toContain('data-assistant-id="guide"');
    expect(defaultContentIndex.some(item => item.filename === 'default_SillyBunnyGuide.png')).toBe(false);
    expect(defaultContentIndex.some(item => item.filename === 'default_ReisenUdongeinInaba.png')).toBe(false);
    expect(reisenCard.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(reisenCard.includes(Buffer.from('chara'))).toBe(true);
});
