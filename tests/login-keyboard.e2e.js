import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const USERS = [
    { handle: 'kb-user', name: 'Keyboard User', created: 1, avatar: '/img/ai4.png', password: true },
    { handle: 'kb-guest', name: 'Second User', created: 2, avatar: '/img/ai4.png', password: true },
];

async function openLogin(page) {
    await page.route('**/api/users/*', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/users/list') return route.fulfill({ json: USERS });
        if (pathname === '/api/users/login') return route.fulfill({ status: 403, json: { error: 'Incorrect credentials' } });
        return route.fallback();
    });
    await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
    await page.locator('#userList .userSelect').first().waitFor({ state: 'visible' });
}

test.describe('the login page, by keyboard', () => {
    test('Tab reaches a user card, which is a named button, and Enter and Space select it', async ({ page }) => {
        await openLogin(page);
        const card = page.locator('#userList .userSelect').first();
        await expect(card).toHaveAttribute('role', 'button');
        await expect(card).toHaveAccessibleName(/^Keyboard User/);

        await page.keyboard.press('Tab');
        await expect(card).toBeFocused();
        await expect(card).toHaveCSS('outline-style', 'solid');

        await page.keyboard.press('Enter');
        await expect(page.locator('#passwordEntryBlock')).toBeVisible();

        await page.locator('#passwordEntryBlock').evaluate(node => { node.style.display = 'none'; });
        await card.focus();
        const before = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Space');
        await expect(page.locator('#passwordEntryBlock')).toBeVisible();
        expect(await page.evaluate(() => window.scrollY)).toBe(before);
    });

    test('the error line is an alert that is present before a message is written', async ({ page }) => {
        await openLogin(page);
        const alert = page.locator('#errorMessage');
        await expect(alert).toHaveAttribute('role', 'alert');
        await expect(alert).toBeEmpty();

        await page.locator('#userList .userSelect').first().focus();
        await page.keyboard.press('Enter');
        await page.locator('#loginButton').click();
        await expect(page.getByRole('alert')).toHaveText('Incorrect credentials');
    });
});
