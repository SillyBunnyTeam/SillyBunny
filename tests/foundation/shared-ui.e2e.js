import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const fixture = fs.readFileSync(new URL('./controls.html', import.meta.url), 'utf8');
const themes = {
    dark: { body: '#cfcfc5', panel: '#1d2128', quote: '#c6c197', border: '#454951' },
    light: { body: '#25282d', panel: '#eceef2', quote: '#686344', border: '#747b86' },
    custom: { body: '#e9e7dc', panel: '#25251f', quote: '#f3c985', border: '#78745c' },
};

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === baseURL ? route.continue() : route.abort();
    });
});

const entryIds = ['entry-rest', 'entry-filled', 'entry-focus', 'entry-error', 'entry-disabled', 'entry-password'];

// Resolves a custom property to the value the browser computes for a property, so a state is compared with its token.
function resolved(page, property, value) {
    return page.evaluate(([name, token]) => {
        const probe = document.createElement('div');
        probe.style.setProperty(name, token);
        document.body.append(probe);
        const computed = getComputedStyle(probe).getPropertyValue(name);
        probe.remove();
        return computed;
    }, [property, value]);
}

async function expectEntryRows(page) {
    for (const compact of [false, true]) {
        await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
        // An entry row is a row, not a standalone field: it takes the row height.
        const token = parseFloat(await resolved(page, 'min-height', 'var(--sb-density-row-min-height)'));
        for (const id of entryIds) {
            // The line plus the row's own padding is the row; a caption under the line (an error) is outside it.
            const height = (await page.locator(`#${id}`).evaluate(input => input.closest('.ds-row-entry__line').getBoundingClientRect().height)) + 12;
            expect(height, `${id} takes its height from --sb-density-row-min-height (compact ${compact})`).toBeGreaterThanOrEqual(token);
            expect(height, `${id} does not outgrow --sb-density-row-min-height (compact ${compact})`).toBeLessThanOrEqual(token + 1);
        }
    }
    await page.evaluate(() => delete document.documentElement.dataset.sbCompactMode);

    // The row is the field: the input draws no fill, border or radius, and a state is drawn on the row.
    const drawn = id => page.locator(`#${id}`).evaluate(input => {
        const row = getComputedStyle(input.closest('.ds-row'));
        const style = getComputedStyle(input);
        return { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderTopLeftRadius, outlineStyle: row.outlineStyle, outlineColor: row.outlineColor, shadow: row.boxShadow };
    });
    const danger = await resolved(page, 'color', 'var(--sb-color-danger)');
    for (const id of entryIds) {
        expect(await drawn(id), `${id} draws nothing inside the row`).toMatchObject({ background: 'rgba(0, 0, 0, 0)', border: '0px', radius: '0px' });
    }
    expect(await drawn('entry-rest')).toMatchObject({ outlineStyle: 'none', shadow: 'none' });
    expect(await drawn('entry-error')).toMatchObject({ outlineStyle: 'solid', outlineColor: danger });
    const error = page.locator('#entry-error');
    await expect(error).toHaveAttribute('aria-invalid', 'true');
    const caption = page.locator('.ds-row-entry__error');
    await expect(caption).toHaveText('Name is already taken');
    await expect(caption).toHaveCSS('color', danger);
    expect(await error.getAttribute('aria-describedby')).toContain(await caption.getAttribute('id'));
    await expect(page.locator('#entry-rest')).not.toHaveAttribute('aria-invalid', /.*/);

    // An entry row draws the focus ring around the whole row; the input draws none.
    const focusRing = await resolved(page, 'box-shadow', 'var(--sb-focus-ring-inset)');
    await page.locator('#entry-focus').focus();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-focus)')).toHaveCSS('box-shadow', focusRing);
    await expect(page.locator('#entry-focus')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.ds-row-entry--floating:has(#entry-focus) .ds-row-entry__edit')).toBeHidden();
    await page.locator('#entry-error').focus();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-error)')).toHaveCSS('outline-color', danger);
    await page.locator('#entry-error').blur();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-focus) .ds-row-entry__edit')).toBeVisible();

    const disabled = page.locator('#entry-disabled');
    await expect(disabled).toBeDisabled();
    await disabled.evaluate(input => input.focus());
    await expect(disabled).not.toBeFocused();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-disabled)')).toHaveCSS('opacity', '0.5');
    await expect(page.locator('.ds-row-entry--floating:has(#entry-disabled) label.ds-row-entry__title')).toBeVisible();
    await expect(page.locator('.ds-row-entry--floating:has(#entry-rest)')).toHaveCSS('opacity', '1');

    const password = page.locator('#entry-password');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).not.toHaveClass(/is-masked/);
    await expect(password).toHaveCSS('-webkit-text-security', 'disc');
    await expect(page.locator('.ds-row-entry--floating:has(#entry-password) .ds-row-entry__reveal')).toHaveCount(0);
}

async function expectTextAreaFields(page, isMobile) {
    const rest = page.locator('#area-rest');
    const row = page.locator('.ds-row-textarea:has(#area-rest)');
    const labelRow = row.locator('> .sb-editor-label-row');

    await expect(rest).toHaveAccessibleName('Notes');
    await expect(rest).toHaveAccessibleDescription('One line of help');
    await expect(labelRow.locator('> label')).toHaveAttribute('for', 'area-rest');
    await expect(labelRow.locator('> .ds-row-textarea__count')).toHaveText('Tokens: 12');
    await expect(labelRow.locator('> .editor_maximize')).toHaveAccessibleName('Expand the editor');
    await expect(labelRow.locator('> .editor_maximize')).toHaveAttribute('data-for', 'area-rest');
    await expect(page.locator('.ds-row-textarea:has(#area-disabled) .editor_maximize')).toHaveCount(0);

    // Label, count and Expand read in that order, with Expand flush with the inline end of the field.
    const [label, count, expand, field] = await Promise.all(['> label', '> .ds-row-textarea__count', '> .editor_maximize'].map(selector => labelRow.locator(selector).boundingBox()).concat(rest.boundingBox()));
    expect(label.x + label.width).toBeLessThanOrEqual(count.x + 0.5);
    expect(count.x + count.width).toBeLessThanOrEqual(expand.x + 0.5);
    expect(field.x + field.width - (expand.x + expand.width), 'Expand sits at the inline end of the field').toBeLessThanOrEqual(1);
    const target = parseFloat(await resolved(page, 'height', 'var(--sb-control-icon-physical-size)'));
    expect(target, 'the control size is 44px on touch').toBeGreaterThanOrEqual(isMobile ? 44 : 32);
    expect(expand.width, 'Expand is a full-size icon button').toBeGreaterThanOrEqual(target - 0.5);
    expect(expand.height).toBeGreaterThanOrEqual(target - 0.5);

    for (const compact of [false, true]) {
        await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
        const token = parseFloat(await resolved(page, 'min-height', 'var(--sb-field-min-height)'));
        expect((await rest.boundingBox()).height, `the field has a minimum height from --sb-field-min-height (compact ${compact})`).toBeGreaterThanOrEqual(token * 4 - 0.5);
    }
    await page.evaluate(() => delete document.documentElement.dataset.sbCompactMode);

    await expect(rest).toHaveCSS('border-top-width', '1px');
    await expect(rest).toHaveCSS('border-top-left-radius', await resolved(page, 'border-top-left-radius', 'var(--sb-radius-control)'));
    await expect(rest).toHaveCSS('background-color', await resolved(page, 'background-color', 'var(--sb-input-bg)'));
    await expect(rest).toHaveCSS('padding-left', await resolved(page, 'padding-left', 'var(--sb-field-padding-x)'));
    const focusBorder = await resolved(page, 'border-top-color', 'var(--sb-entry-focus-border)');
    const focusRing = await resolved(page, 'box-shadow', 'var(--sb-entry-focus-ring)');
    await rest.focus();
    await expect(rest).toHaveCSS('border-top-color', focusBorder);
    await expect(rest).toHaveCSS('box-shadow', focusRing);
    await rest.blur();

    const danger = await resolved(page, 'color', 'var(--sb-color-danger)');
    const invalid = page.locator('#area-error');
    await expect(invalid).toHaveAttribute('aria-invalid', 'true');
    await expect(invalid).toHaveCSS('border-top-color', danger);
    await expect(page.locator('.ds-row-textarea__error')).toHaveText('Too long');
    await expect(page.locator('.ds-row-textarea__error')).toHaveCSS('color', danger);
    await expect(invalid).toHaveAccessibleDescription('Too long');

    const disabled = page.locator('#area-disabled');
    await expect(disabled).toBeDisabled();
    await expect(page.locator('.ds-row-textarea:has(#area-disabled)')).toHaveCSS('opacity', '0.5');
    await expect(page.locator('.ds-row-textarea:has(#area-disabled) label')).toBeVisible();
}

const searchIds = ['search-rest', 'search-filled', 'search-bar'];

async function expectSearchEntries(page, isMobile) {
    const entry = id => page.locator(`.sb-search-entry:has(#${id})`);
    const clear = id => entry(id).locator('.sb-search-entry__clear');

    for (const compact of [false, true]) {
        await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
        const field = parseFloat(await resolved(page, 'height', 'var(--sb-field-min-height)'));
        const control = parseFloat(await resolved(page, 'height', 'var(--sb-control-min-height)'));
        for (const id of ['search-rest', 'search-filled']) {
            expect((await entry(id).boundingBox()).height, `${id} takes its height from --sb-field-min-height (compact ${compact})`).toBeCloseTo(field, 0);
        }
        expect((await entry('search-bar').boundingBox()).height, `a bar entry takes its height from --sb-control-min-height (compact ${compact})`).toBeCloseTo(control, 0);
        if (isMobile) {
            const target = await clear('search-filled').boundingBox();
            expect(target.width, `the clear button is 44px wide on touch (compact ${compact})`).toBeGreaterThanOrEqual(44);
            expect(target.height, `the clear button is 44px tall on touch (compact ${compact})`).toBeGreaterThanOrEqual(44);
        }
    }
    await page.evaluate(() => delete document.documentElement.dataset.sbCompactMode);

    const radius = await resolved(page, 'border-top-left-radius', 'var(--sb-radius-control)');
    for (const id of searchIds) await expect(entry(id)).toHaveCSS('border-top-left-radius', radius);
    await expect(entry('search-rest')).toHaveCSS('background-color', await resolved(page, 'background-color', 'var(--sb-input-bg)'));
    await expect(entry('search-rest')).toHaveCSS('border-top-color', await resolved(page, 'border-top-color', 'var(--sb-input-border)'));
    await expect(entry('search-bar')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');

    await expect(clear('search-rest')).toBeHidden();
    await expect(clear('search-filled')).toBeVisible();
    await expect(clear('search-filled')).toHaveAccessibleName('Clear');
    await expect(clear('search-filled')).toHaveAttribute('title', 'Clear');
    await expect(page.locator('#search-rest')).toHaveAccessibleName('Search settings');

    await page.locator('#search-rest').fill('abc');
    await expect(clear('search-rest')).toBeVisible();
    await page.locator('#search-rest').press('Escape');
    await expect(page.locator('#search-rest')).toHaveValue('');
    await expect(page.locator('#search-rest')).toBeFocused();
    await expect(clear('search-rest')).toBeHidden();

    await page.locator('#search-rest').fill('abc');
    await clear('search-rest').click();
    await expect(page.locator('#search-rest')).toHaveValue('');
    await expect(page.locator('#search-rest')).toBeFocused();
    await expect(clear('search-rest')).toBeHidden();

    await page.locator('#search-rest').focus();
    await expect(entry('search-rest')).toHaveCSS('border-top-color', await resolved(page, 'border-top-color', 'var(--sb-entry-focus-border)'));
    await expect(entry('search-rest')).toHaveCSS('box-shadow', await resolved(page, 'box-shadow', 'var(--sb-entry-focus-ring)'));
    await expect(page.locator('#search-rest')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('#search-rest')).toHaveCSS('border-top-width', '0px');
    await page.locator('#search-bar').focus();
    await expect(entry('search-bar')).toHaveCSS('box-shadow', await resolved(page, 'box-shadow', 'var(--sb-focus-ring-inset)'));
    await expect(page.locator('#search-bar')).toHaveCSS('box-shadow', 'none');
    await page.locator('#search-bar').blur();
}

const statusStates = { 'status-empty': 'empty', 'status-no-results': 'no-results', 'status-loading': 'loading', 'status-error': 'error', 'status-unavailable': 'unavailable' };

async function expectStatusPages(page, isMobile) {
    const status = id => page.locator(`#${id}`);
    const title = id => status(id).locator('.sb-status-page__title');
    const icon = id => status(id).locator('.sb-status-page__icon');
    const fontSize = locator => locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const headline = parseFloat(await resolved(page, 'font-size', 'var(--sb-type-headline)'));
    const display = parseFloat(await resolved(page, 'font-size', 'var(--sb-type-display)'));

    for (const [id, state] of Object.entries(statusStates)) {
        await expect(status(id), `${id} is a status region`).toHaveAttribute('role', 'status');
        await expect(status(id)).toHaveAttribute('data-state', state);
        await expect(status(id)).toBeVisible();
        await expect(title(id), `${id} names its state`).toHaveText(/\S/);
        await expect(status(id), `${id} is labelled by its title`).toHaveAccessibleName(await title(id).textContent());
        await expect(status(id), `${id} sits open, never in a card`).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        // The theme paints every `h3` outside a dialog as a boxed heading; a status title is bare text.
        await expect(title(id), `${id} title is not boxed`).toHaveCSS('border-top-width', '0px');
        await expect(title(id)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }

    // The default set is for a view and the compact set for a pane; the loading form is the compact set with a spinner.
    await expect(icon('status-empty')).toHaveCSS('font-size', '128px');
    expect(await fontSize(title('status-empty'))).toBeCloseTo(display, 1);
    for (const id of ['status-no-results', 'status-error', 'status-unavailable']) {
        await expect(icon(id), `${id} uses the compact icon`).toHaveCSS('font-size', '96px');
        expect(await fontSize(title(id)), `${id} title is a Headline`).toBeCloseTo(headline, 1);
        await expect(icon(id)).toHaveAttribute('aria-hidden', 'true');
        await expect(title(id)).toHaveCSS('font-weight', '800');
    }
    await expect(status('status-empty').locator('.fa-inbox')).toHaveCount(1);
    await expect(status('status-no-results').locator('.fa-magnifying-glass')).toHaveCount(1);
    await expect(status('status-error').locator('.fa-triangle-exclamation')).toHaveCount(1);
    await expect(status('status-unavailable').locator('.fa-ban')).toHaveCount(1);

    // Loading is a spinner of 64px with a 6px stroke in place of the icon, and the title in the Headline role.
    const spinner = status('status-loading').locator('.sb-spinner');
    await expect(icon('status-loading')).toHaveCount(0);
    await expect(spinner).toHaveCSS('width', '64px');
    await expect(spinner).toHaveCSS('height', '64px');
    await expect(spinner).toHaveCSS('border-top-width', '6px');
    await expect(spinner).toHaveAttribute('role', 'progressbar');
    await expect(spinner).toHaveAccessibleName('Loading Documents');
    expect(await fontSize(title('status-loading'))).toBeCloseTo(headline, 1);
    await expect(spinner).toHaveCSS('animation-name', 'sb-spinner-turn');
    await expect(spinner).toHaveCSS('animation-duration', '1.2s');
    await expect(status('status-loading').locator('button')).toHaveCount(0);

    // The action is the suggested pill, 38px or taller and 44px on touch.
    for (const id of ['status-empty', 'status-error']) {
        const action = status(id).locator('.sb-status-page__action');
        await expect(action).toHaveClass(/is-suggested/);
        await expect(action).toHaveCSS('border-radius', '999px');
        expect((await action.boundingBox()).height, `${id} action height`).toBeGreaterThanOrEqual(isMobile ? 44 : 38);
    }
    await expect(status('status-no-results').locator('button')).toHaveCount(0);

    // Reduced motion stops the spinner and leaves its still arc.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await expect(spinner).toHaveCSS('border-top-color', await resolved(page, 'color', 'var(--sb-shell-text)'));
}

async function expectExpanderRows(page, isMobile) {
    const toggle = id => page.locator(`#${id} > .ds-row-expander__header > .ds-row-expander__toggle`);
    const content = id => page.locator(`#${id} > .ds-row-expander-content`);
    const arrow = id => page.locator(`#${id} > .ds-row-expander__header > .ds-row-expander__arrow`);
    const animating = id => content(id).evaluate(node => node.getAnimations().length > 0);
    const arrowTransform = id => arrow(id).evaluate(node => getComputedStyle(node).transform);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    for (const [id, open] of [['expander-rest', false], ['expander-open', true], ['expander-note', false]]) {
        await expect(toggle(id)).toHaveAttribute('aria-expanded', String(open));
        await expect(toggle(id)).toHaveAttribute('aria-controls', await content(id).getAttribute('id'));
        if (open) await expect(content(id)).toBeVisible();
        else await expect(content(id)).toBeHidden();
        const height = (await page.locator(`#${id} > .ds-row-expander__header`).boundingBox()).height;
        expect(height, `${id} header keeps the row height`).toBeGreaterThanOrEqual(isMobile ? 44 : 36);
    }
    await expect(page.getByRole('button', { name: /^Advanced/ })).toBeVisible();
    await expect(content('expander-rest')).toHaveAttribute('hidden', '');
    expect(await arrowTransform('expander-rest')).not.toBe(await arrowTransform('expander-open'));

    // Closed content is out of the tab order: the next stop after a closed row is the next row.
    await page.locator('#primary').focus();
    await toggle('expander-rest').focus();
    await page.keyboard.press('Tab');
    await expect(toggle('expander-open')).toBeFocused();
    await expect.poll(() => toggle('expander-open').evaluate(node => getComputedStyle(node, '::after').boxShadow)).toBe(await resolved(page, 'box-shadow', 'var(--sb-focus-ring-inset)'));
    await page.keyboard.press('Shift+Tab');
    await expect(toggle('expander-rest')).toBeFocused();

    // Enter opens, focus stays on the header, and the nested controls join the tab order.
    await page.keyboard.press('Enter');
    await expect(toggle('expander-rest')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle('expander-rest')).toBeFocused();
    await expect(content('expander-rest')).toBeVisible();
    await expect(arrow('expander-rest')).toHaveCSS('transform', await arrowTransform('expander-open'));
    await page.keyboard.press('Tab');
    await expect(page.locator('#expander-name')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(toggle('expander-rest')).toBeFocused();

    // Space closes it again; the reveal has finished when the content is hidden.
    await page.keyboard.press('Space');
    await expect(toggle('expander-rest')).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle('expander-rest')).toBeFocused();
    await expect(content('expander-rest')).toBeHidden();

    // Several rows stay open at once.
    await toggle('expander-note').click();
    await toggle('expander-rest').click();
    await expect(toggle('expander-open')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle('expander-note')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle('expander-rest')).toHaveAttribute('aria-expanded', 'true');
    await toggle('expander-note').click();
    await toggle('expander-rest').click();
    await expect(content('expander-note')).toBeHidden();
    await expect(content('expander-rest')).toBeHidden();

    // The suffix switch keeps its own focus and does not toggle the row.
    await toggle('expander-note').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#expander-enabled')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#expander-enabled')).toBeChecked();
    await expect(toggle('expander-note')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#expander-enabled').click();
    await expect(page.locator('#expander-enabled')).not.toBeChecked();
    await expect(toggle('expander-note')).toHaveAttribute('aria-expanded', 'false');
    // The rest of the header is the toggle, down to its padding.
    await page.locator('#expander-note > .ds-row-expander__header').click({ position: { x: 3, y: 3 } });
    await expect(toggle('expander-note')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#expander-note > .ds-row-expander__header').click({ position: { x: 3, y: 3 } });
    await expect(content('expander-note')).toBeHidden();

    // The reveal moves with motion, and does not under prefers-reduced-motion.
    await toggle('expander-rest').click();
    await expect.poll(() => animating('expander-rest')).toBe(true);
    await expect(content('expander-rest')).toBeVisible();
    await expect.poll(() => animating('expander-rest')).toBe(false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggle('expander-rest').click();
    await expect(content('expander-rest')).toBeHidden();
    expect(await animating('expander-rest')).toBe(false);
    await toggle('expander-rest').click();
    await expect(content('expander-rest')).toBeVisible();
    expect(await animating('expander-rest')).toBe(false);
    await expect(arrow('expander-rest')).toHaveCSS('transition-duration', '0s');
    await toggle('expander-rest').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
}

for (const [name, colors] of Object.entries(themes)) {
    test(`${name} shared controls`, async ({ page, isMobile }, testInfo) => {
        await page.route('**/__foundation', route => route.fulfill({ contentType: 'text/html', body: fixture }));
        await page.goto('/__foundation');
        await page.evaluate(({ body, panel, quote, border }) => {
            const style = document.documentElement.style;
            for (const [token, value] of Object.entries({ SmartThemeBodyColor: body, SmartThemeBlurTintColor: panel, SmartThemeChatTintColor: panel, SmartThemeQuoteColor: quote, SmartThemeBorderColor: border })) style.setProperty(`--${token}`, value);
        }, colors);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: testInfo.outputPath(`${name}-controls.png`), fullPage: true });
        await testInfo.attach(`${name}-controls`, { path: testInfo.outputPath(`${name}-controls.png`), contentType: 'image/png' });

        // Capture the original baseline before enabling assertions for the new contract.
        if (process.env.SB_UI_CAPTURE_ONLY === '1') return;
        await page.keyboard.press('Tab');
        await expect(page.locator('#primary')).toBeFocused();
        await expect(page.locator('#primary')).toHaveCSS('box-shadow', /inset/);
        await page.keyboard.press('Tab');
        await expect(page.locator('#secondary')).toBeFocused();
        await expect(page.locator('[disabled]').first()).toBeDisabled();
        await expect(page.locator('.menu_button[aria-disabled]')).toHaveCSS('cursor', 'not-allowed');
        await expect(page.locator('.menu_button[aria-busy]')).toHaveCSS('cursor', 'progress');

        await expectEntryRows(page);
        await expectTextAreaFields(page, isMobile);
        await expectSearchEntries(page, isMobile);
        await expectStatusPages(page, isMobile);
        await expectExpanderRows(page, isMobile);

        for (const compact of [false, true]) {
            await page.evaluate(value => document.documentElement.dataset.sbCompactMode = String(value), compact);
            if (isMobile) {
                for (const element of await page.locator('.menu_button, .text_pole, select, .checkbox_label').all()) {
                    const bounds = await element.boundingBox();
                    expect(bounds.height).toBeGreaterThanOrEqual(44);
                    expect(bounds.width).toBeGreaterThanOrEqual(44);
                }
            }
            await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '24px'));
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page.locator('#primary')).toHaveCSS('transition-duration', '0s');
        await expect(page.locator('#primary')).toHaveCSS('transition-delay', '0s');
        await expect(page.locator('#field')).toHaveCSS('transition-duration', '0s');
        await expect(page.locator('label[for="entry-rest"]')).toHaveCSS('transition-duration', '0s');
        await page.addStyleTag({ content: ':root { --sb-radius-button: 7px; --sb-focus-ring: #ffadba; }' });
        await expect(page.locator('#secondary')).toHaveCSS('border-radius', '7px');
    });
}

test('banner: one title and one button, placed by the space, revealed with the transition', async ({ page, isMobile }) => {
    await page.route('**/__foundation', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('/__foundation');
    await page.evaluate(() => document.fonts.ready);
    const box = selector => page.locator(selector).boundingBox();
    const parts = id => ({ frame: `#${id}-frame`, banner: `#${id}`, title: `#${id} .sb-banner__title`, action: `#${id} .sb-banner__action` });

    const wide = parts('banner-wide');
    await expect(page.locator(wide.banner)).toHaveAttribute('data-layout', 'centered');
    const [frame, title, action] = await Promise.all([box(wide.frame), box(wide.title), box(wide.action)]);
    expect(title.x + title.width / 2, 'a centred title sits in the middle of the strip').toBeCloseTo(frame.x + frame.width / 2, 0);
    expect(frame.x + frame.width - (action.x + action.width), 'the button is 6px from the end edge').toBeCloseTo(6, 0);
    expect(action.x - (title.x + title.width), 'the title keeps 36px from the button').toBeGreaterThanOrEqual(36 - 0.5);
    expect(action.width, 'the button is at least 84px wide beside the title').toBeGreaterThanOrEqual(84 - 0.5);
    await expect(page.locator(wide.banner)).toHaveCSS('padding-top', '6px');
    await expect(page.locator(wide.banner)).toHaveCSS('background-color', await resolved(page, 'background-color', 'color-mix(in srgb, var(--SmartThemeBodyColor) 10%, var(--sb-layer-window))'));
    await expect(page.locator(wide.title)).toHaveCSS('font-weight', '700');
    await expect(page.locator(wide.banner)).toHaveAttribute('role', 'status');
    await expect(page.locator(`${wide.banner} button`)).toHaveCount(1);
    await expect(page.locator(wide.action)).toHaveClass('menu_button sb-banner__action');
    await expect(page.locator(wide.action)).toHaveAccessibleName('Reconnect');
    expect((await box(wide.action)).height, 'the button is 44px tall on touch').toBeGreaterThanOrEqual((isMobile ? 44 : 0) - 0.5);

    const start = parts('banner-start');
    await expect(page.locator(start.banner)).not.toHaveAttribute('data-layout', /.+/);
    const [startFrame, startTitle, startAction] = await Promise.all([box(start.frame), box(start.title), box(start.action)]);
    expect(startTitle.x - startFrame.x, 'an edge-aligned title starts after the 6px padding').toBeCloseTo(6, 0);
    await expect(page.locator(start.title)).toHaveCSS('padding-inline-start', '6px');
    expect(startFrame.x + startFrame.width - (startAction.x + startAction.width)).toBeCloseTo(6, 0);
    expect(startAction.x - (startTitle.x + startTitle.width), 'parts are at least 6px apart').toBeGreaterThanOrEqual(6 - 0.5);

    const stacked = parts('banner-stacked');
    await expect(page.locator(stacked.banner)).toHaveAttribute('data-layout', 'stacked');
    const [stackedFrame, stackedTitle, stackedAction] = await Promise.all([box(stacked.frame), box(stacked.title), box(stacked.action)]);
    expect(stackedAction.y - (stackedTitle.y + stackedTitle.height), 'a stacked button is 9px below the title').toBeCloseTo(9, 0);
    expect(stackedAction.width, 'a stacked button is at least 160px wide, or the strip without its padding').toBeGreaterThanOrEqual(Math.min(160, stackedFrame.width - 12) - 0.5);
    expect(stackedAction.x + stackedAction.width / 2, 'a stacked button is centred').toBeCloseTo(stackedFrame.x + stackedFrame.width / 2, 0);

    // The space changes the layout while the strip is shown.
    await page.locator(wide.frame).evaluate(node => { node.style.width = '140px'; });
    await expect(page.locator(wide.banner)).toHaveAttribute('data-layout', 'stacked');
    await page.locator(wide.frame).evaluate(node => { node.style.width = ''; });
    await expect(page.locator(wide.banner)).toHaveAttribute('data-layout', 'centered');

    // Hidden until the state applies; the reveal transition runs unless motion is reduced.
    await page.evaluate(async () => {
        const { createBanner } = await import('/scripts/sillybunny-editor/banner.js');
        const banner = createBanner({ title: 'Needs an update', actionLabel: 'Update', onActivate: () => {}, revealed: false });
        banner.element.id = 'banner-late';
        document.getElementById('banner-wide-frame').append(banner.element);
        window.lateBanner = banner;
    });
    await expect(page.locator('#banner-late')).toBeHidden();
    const motion = method => page.evaluate(name => {
        window.lateBanner[name]();
        const running = window.lateBanner.element.getAnimations();
        return { count: running.length, duration: running[0]?.effect.getTiming().duration ?? null };
    }, method);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await motion('show')).count, 'no reveal motion when motion is reduced').toBe(0);
    await expect(page.locator('#banner-late')).toBeVisible();
    expect((await motion('hide')).count, 'no hide motion when motion is reduced').toBe(0);
    await expect(page.locator('#banner-late')).toBeHidden();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await motion('show'), 'the reveal runs the reveal transition').toEqual({ count: 1, duration: 250 });
    await expect(page.locator('#banner-late')).toBeVisible();
    await expect.poll(() => page.locator('#banner-late').evaluate(node => node.getAnimations().length)).toBe(0);
    expect(await motion('hide'), 'the hide runs the reveal transition').toEqual({ count: 1, duration: 250 });
    await expect(page.locator('#banner-late')).toBeHidden();
});

test('application shell baseline and reduced motion', async ({ page }, testInfo) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'presets'));
    const settingsPage = page.locator('#sb-settings-page');
    await expect(settingsPage).toBeVisible();
    await expect(settingsPage).not.toHaveAttribute('hidden');
    await expect(page.locator('#left-nav-panel')).toHaveClass(/sb-settings-active-root/);
    await page.screenshot({ path: testInfo.outputPath('shell.png') });
    await testInfo.attach('shell', { path: testInfo.outputPath('shell.png'), contentType: 'image/png' });
    if (process.env.SB_UI_CAPTURE_ONLY === '1') return;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const shellRoot = page.locator('#left-nav-panel');
    const motion = await shellRoot.evaluate(element => {
        const style = getComputedStyle(element);
        return { duration: style.animationDuration, delay: style.animationDelay };
    });
    expect(motion).toEqual({ duration: '0s', delay: '0s' });
    await page.locator('#sb-settings-close').click();
    await expect(settingsPage).toHaveAttribute('hidden', '');
    await expect(page.locator('#left-nav-panel')).not.toHaveClass(/sb-settings-active-root/);
});
