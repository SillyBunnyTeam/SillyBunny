import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { SETTINGS_COPY } from './helpers/copy-settings.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

test('the Use Character Lorebooks switch of the Conversation settings explains itself in full', async ({ page }) => {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });

    const hint = await page.evaluate(async () => {
        const { buildSettingsDrawerContent } = await import('/scripts/sillybunny-conversation/timeline-render.js');
        const drawer = document.createElement('div');
        drawer.append(buildSettingsDrawerContent());
        const row = drawer.querySelector('#sb_conv_lorebooks_enabled').closest('.ds-row');
        const note = row.querySelector('.ds-row-subtitle');
        return { text: note.textContent, marked: note.hasAttribute('data-sb-copy-placeholder') };
    });

    expect(hint).toEqual({ text: SETTINGS_COPY.lorebooksHint, marked: false });
});
