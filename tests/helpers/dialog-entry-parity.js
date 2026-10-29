import { expect } from '@playwright/test';

export async function expectSharedDialogEntryStyles(entry) {
    const metrics = await entry.evaluate(node => {
        const read = input => {
            const style = getComputedStyle(input);
            return {
                height: style.height,
                paddingInline: style.paddingInline,
                borderRadius: style.borderRadius,
                backgroundColor: style.backgroundColor,
                outlineColor: style.outlineColor,
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
                outlineOffset: style.outlineOffset,
                boxShadow: style.boxShadow,
            };
        };
        const referenceHost = document.createElement('div');
        referenceHost.className = 'sb-dialog-host';
        referenceHost.style.cssText = 'position: fixed; inset: 0 auto auto -10000px; opacity: 0; pointer-events: none;';
        const referenceSurface = document.createElement('section');
        referenceSurface.className = 'sb-dialog sb-dialog--window';
        const referenceField = document.createElement('label');
        referenceField.className = 'sb-dialog__search';
        referenceField.dataset.state = 'open';
        const referenceEntry = document.createElement('span');
        referenceEntry.className = 'sb-dialog__search-entry';
        const reference = document.createElement('input');
        reference.type = 'search';
        reference.className = 'text_pole sb-dialog__entry sb-dialog__search-input';
        reference.setAttribute('role', 'searchbox');
        reference.setAttribute('aria-label', 'Search');
        referenceEntry.append(reference);
        referenceField.append(referenceEntry);
        referenceSurface.append(referenceField);
        referenceHost.append(referenceSurface);
        document.body.append(referenceHost);
        node.blur();
        reference.blur();
        const actualRest = read(node);
        const referenceRest = read(reference);
        node.focus();
        const actualFocus = read(node);
        referenceHost.remove();
        return { actualRest, referenceRest, actualFocus };
    });
    expect(metrics.actualRest).toEqual(metrics.referenceRest);
    expect(metrics.actualFocus).toMatchObject({
        outlineStyle: 'solid',
        outlineWidth: '2px',
        outlineOffset: '-2px',
    });
    expect(metrics.actualFocus.outlineColor).not.toBe(metrics.actualRest.outlineColor);
}
