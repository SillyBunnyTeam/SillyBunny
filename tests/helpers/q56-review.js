import { expect, test } from '@playwright/test';

export async function q56Screenshot(page, name) {
    await page.mouse.move(1, 1);
    await page.screenshot({ path: test.info().outputPath(`q56-${name}.png`) });
}

export async function buttonStates(button) {
    const page = button.page();
    const disabled = await button.isDisabled();
    await button.evaluate(node => { node.disabled = false; node.blur(); });
    const read = () => button.evaluate(async node => {
        await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
        const style = getComputedStyle(node);
        return Object.fromEntries([
            'background-color', 'color', 'border', 'border-radius', 'box-shadow', 'outline',
            'font-family', 'font-size', 'font-weight', 'padding', 'min-height', 'opacity',
        ].map(property => [property, style.getPropertyValue(property)]));
    });
    await page.mouse.move(1, 1);
    const rest = await read();
    await button.hover();
    const hover = await read();
    await page.mouse.down();
    const active = await read();
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await button.focus();
    await button.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const focus = await read();
    await button.evaluate(node => { node.disabled = true; });
    const inactive = await read();
    await button.evaluate((node, disabled) => { node.disabled = disabled; node.blur(); }, disabled);
    return { rest, hover, active, focus, disabled: inactive };
}

/**
 * A selection header raises both its text buttons, so Select All reads in every state as Cancel does, with the raised fills
 * (10%, 15% hovered, 30% pressed), the regular weight and none of the suggested action's solid accent.
 * @param {import('@playwright/test').Page} page
 * @param {{ cancel: object, save: object }} selection The states of the header's Cancel and of its Select All (as `save`).
 * @param {{ cancel: object, save: object }} reference The states of the prompt editor's Cancel and suggested Save.
 */
export async function expectRaisedSelectionButtons(page, selection, reference) {
    expect(selection.save).toEqual(selection.cancel);
    const fills = await page.evaluate(() => Object.fromEntries(['--sb-raised-bg', '--sb-raised-hover-bg', '--sb-raised-active-bg'].map((name) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `var(${name})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return [name, color];
    })));
    expect(selection.save.rest['background-color']).toBe(fills['--sb-raised-bg']);
    expect(selection.save.hover['background-color']).toBe(fills['--sb-raised-hover-bg']);
    expect(selection.save.active['background-color']).toBe(fills['--sb-raised-active-bg']);
    expect(selection.save.rest['font-weight']).toBe(reference.cancel.rest['font-weight']);
    expect(selection.save.rest['background-color']).not.toBe(reference.save.rest['background-color']);
}

export async function promptButtonReference(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.locator('[data-sb-settings-tab="editor"]').evaluate(node => node.click());
    await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    const detail = page.locator('.sb-prompt-detail');
    await expect(detail).toBeVisible();
    // Keep the canonical full-label header, with the current viewport's theme/touch rules.
    const container = detail.locator('..');
    const style = await container.getAttribute('style');
    await container.evaluate(node => { node.style.minWidth = '600px'; node.style.width = '600px'; node.style.flex = 'none'; });
    const reference = {
        cancel: await buttonStates(detail.locator('.sb-prompt-cancel')),
        save: await buttonStates(detail.locator('.sb-prompt-save')),
    };
    await container.evaluate((node, style) => {
        if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
    }, style);
    return reference;
}
