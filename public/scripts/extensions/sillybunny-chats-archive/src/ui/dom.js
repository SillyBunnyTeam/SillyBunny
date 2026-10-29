export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function button(className, text) {
    const node = el('button', className, text);
    node.type = 'button';
    return node;
}

export function appendOption(select, value, text) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
    return option;
}

export function glyph(name) {
    const node = el('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

export function rowActionButton(label, name, className = '') {
    const node = button(`sbca-row-action ${className}`.trim());
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(glyph(name));
    return node;
}

export function flatButton(text, name = '', className = '') {
    const node = button(`sbca-flat-button ${className}`.trim());
    if (name) {
        node.append(glyph(name));
    }
    node.append(el('span', 'sbca-button-copy', text));
    return node;
}

export function tr(ctx, text, replacements = {}) {
    let translated = ctx.translate?.(text) ?? text;
    for (const [key, value] of Object.entries(replacements)) {
        translated = translated.replaceAll(`{${key}}`, () => String(value));
    }
    return translated;
}

/**
 * Announces `text` in the live region. The banner repeats it only while a load or scan runs, or when `alert`
 * marks a warning or error; every other message stays announce-only.
 */
export function setStatus(ui, text, { alert = false } = {}) {
    ui.status.textContent = text;
    ui.bannerText.textContent = text;
    ui.banner.toggleAttribute('data-alert', alert && text !== '');
    syncBanner(ui);
}

export function syncBanner(ui) {
    ui.banner.hidden = ui.banner.dataset.busy !== 'true' && !ui.banner.hasAttribute('data-alert');
}

export function setCount(ui, text) {
    ui.countText = text;
    showCount(ui);
}

export function showCount(ui) {
    const text = ui.selection?.isActive ? '' : ui.countText ?? '';
    ui.dialog.setSubtitle(text);
    ui.listPage?.setSubtitle(text);
}
