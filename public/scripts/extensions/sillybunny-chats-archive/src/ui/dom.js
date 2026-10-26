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

export function selectControl(ctx, label, options, className = 'sbca-filter') {
    const wrap = el('label', className);
    wrap.append(el('span', 'sbca-label', tr(ctx, label)));
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const [value, text] of options) {
        appendOption(select, value, tr(ctx, text));
    }
    wrap.append(select);
    return { wrap, select };
}

export function inputControl(ctx, label, type = 'text', className = 'sbca-filter') {
    const wrap = el('label', className);
    wrap.append(el('span', 'sbca-label', tr(ctx, label)));
    const input = document.createElement('input');
    input.type = type;
    input.className = 'text_pole';
    wrap.append(input);
    return { wrap, input };
}

export function actionButton(ctx, label, icon) {
    const node = button('sbca-control sbca-action');
    const glyph = el('i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el('span', 'sbca-button-copy', tr(ctx, label)));
    return node;
}

export function tr(ctx, text, replacements = {}) {
    let translated = ctx.translate?.(text) ?? text;
    for (const [key, value] of Object.entries(replacements)) {
        translated = translated.replaceAll(`{${key}}`, () => String(value));
    }
    return translated;
}

export function setStatus(ui, text) {
    ui.status.textContent = text;
}
