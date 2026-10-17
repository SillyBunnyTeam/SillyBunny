import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

test.beforeEach(async ({ page }) => {
    // Browser QA must not change the running instance's saved preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

/** Avatar shape of every group row in the list, plus the hidden template row. */
function readGroupAvatars(page) {
    return page.evaluate(() => ({
        template: Boolean(document.querySelector('#group_list_template .group_select > .avatar')),
        rows: Array.from(document.querySelectorAll('#rm_print_characters_block .group_select'), (row) => ({
            id: row.getAttribute('data-grid'),
            avatar: Boolean(row.querySelector(':scope > .avatar')),
            missing: Boolean(row.querySelector(':scope > .missing-avatar')),
        })),
    }));
}

test('opening Create New Chat Group keeps the group list avatars', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.locator('#sb-character-toggle').click();
    await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Groups' }).click();
    await expect(page.locator('#rm_button_group_chats')).toBeVisible();

    // The hidden template row is what the bug corrupted, so this check holds even
    // on an instance with no saved groups; the row comparison covers the visible symptom.
    const before = await readGroupAvatars(page);
    expect(before.template).toBe(true);

    await page.locator('#rm_button_group_chats').click();
    await expect(page.locator('#sb_group_editor_header')).toBeVisible();
    await page.locator('#sb_group_editor_back').click();
    await expect(page.locator('#rm_print_characters_block .group_select').first()).toBeVisible();

    const after = await readGroupAvatars(page);
    expect(after.template).toBe(true);
    expect(after.rows).toEqual(before.rows);
});
