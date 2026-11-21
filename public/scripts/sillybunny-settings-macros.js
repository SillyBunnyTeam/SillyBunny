const SUBTITLE_SELECTOR = 'small, .ds-row-subtitle, .toggle-description, .sb-settings-category-description, .sb-subpage-heading-description, .sb-subpage-detail-description';
const EXCLUDED_SELECTOR = 'code, pre, textarea, input, select, option, script, style, [contenteditable]:not([contenteditable="false"]), #chat, .mes_text, .mes_reasoning';

/** Format literal macro and code examples without interpreting HTML or changing existing inline elements. */
export function formatSettingsMacroExamples(element) {
    if (!(element instanceof Element) || !element.closest(SUBTITLE_SELECTOR) || element.closest(EXCLUDED_SELECTOR)) return;
    if (!/`|\{\{|partial: true|\/help hotkeys/.test(element.textContent)) return;

    const document = element.ownerDocument;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement.closest(EXCLUDED_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const text = node.textContent;
        const matches = [...text.matchAll(/`([^`\r\n]+)`|(['"])(partial: true|\/help hotkeys)\2|(\{\{[^{}\r\n]+\}\})|(partial: true|\/help hotkeys)/g)];
        if (!matches.length) continue;
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            fragment.append(document.createTextNode(text.slice(offset, match.index)));
            const code = document.createElement('code');
            const example = match[1] ?? match[3] ?? match[4] ?? match[5];
            const hasMacroColon = /^\{\{[^{}]+\}\}:$/.test(example);
            code.textContent = hasMacroColon ? example.slice(0, -1) : example;
            fragment.append(code);
            if (hasMacroColon) fragment.append(document.createTextNode(':'));
            offset = match.index + match[0].length;
        }
        fragment.append(document.createTextNode(text.slice(offset)));
        node.replaceWith(fragment);
    }
}
