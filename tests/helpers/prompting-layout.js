export function auditPromptingLayout(root) {
    const records = [];
    const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
        && getComputedStyle(element).visibility !== 'hidden';
    const selector = element => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const parent = element.parentElement;
        const index = [...parent.children].filter(sibling => sibling.tagName === element.tagName).indexOf(element) + 1;
        return `${selector(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    };
    for (const body of root.querySelectorAll('.sb-prompting-group-body')) {
        if (!visible(body)) continue;
        const box = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        const left = box.left + parseFloat(style.borderLeftWidth);
        const right = box.right - parseFloat(style.borderRightWidth);
        const add = (element, type, metrics, pass) => records.push({ group: body.parentElement.id, selector: selector(element), type, ...metrics, pass });
        const content = new Set(body.querySelectorAll([
            '.ds-row > .ds-row-text',
            '.sb-settings-flat-header b',
            '.sb-preset-toolbar-row > strong',
            '.toggle-description:not(.ds-row-subtitle)',
            '.sb-prompting-row-with-help > :is(.notes, p, small)',
            '.range-block:not(.ds-row) > .justifyLeft',
            '.range-block:not(.ds-row) textarea',
            '.note-block',
            '.sb-setting-inline-copy > label',
            '.checkbox_label > input[type="radio"]',
        ].join(', ')));
        for (const toolbar of body.querySelectorAll('.sb-preset-toolbar-row, .sb-non-chat-preset-row')) {
            const leading = [];
            for (const element of toolbar.querySelectorAll(':scope > strong, :scope > select, .sb-action-btn-group')) {
                if (!visible(element)) continue;
                const rect = element.getBoundingClientRect();
                if (!leading.some(box => rect.top < box.bottom - 1 && rect.bottom > box.top + 1)) {
                    content.add(element);
                    leading.push(rect);
                }
            }
        }
        for (const element of content) {
            if (!visible(element) || element.closest('.ds-row-suffix, .ds-row-text, #completion_prompt_manager') && !element.matches('.ds-row-text')) continue;
            const elementStyle = getComputedStyle(element);
            const contentPadding = element.matches('input, select, textarea, .sb-action-btn-group') ? 0 : parseFloat(elementStyle.paddingLeft) + parseFloat(elementStyle.borderLeftWidth);
            const inset = element.getBoundingClientRect().left + contentPadding - left;
            add(element, 'content-inset', { inset }, Math.abs(inset - 16) <= 1);
        }
        for (const row of body.querySelectorAll('.ds-row')) {
            if (!visible(row)) continue;
            const rect = row.getBoundingClientRect();
            add(row, 'row-edges', { left: rect.left - left, right: right - rect.right }, Math.abs(rect.left - left) <= 1 && Math.abs(right - rect.right) <= 1);
        }
        const first = [...body.children].find(visible);
        if (first) add(first, 'first-row-separator', { borderTop: parseFloat(getComputedStyle(first).borderTopWidth) }, parseFloat(getComputedStyle(first).borderTopWidth) === 0);
        for (const row of body.querySelectorAll('.ds-row, .sb-prompting-row-with-help, .sb-settings-flat-header, .sb-preset-toolbar-row, .sb-non-chat-preset-row, .sb-settings-flat-section, .sb-settings-row-wrapper, label:has(> input[type="radio"])')) {
            if (!visible(row) || row.closest('#completion_prompt_manager')) continue;
            const rowStyle = getComputedStyle(row);
            const borderTop = parseFloat(rowStyle.borderTopWidth);
            const borderBottom = parseFloat(rowStyle.borderBottomWidth);
            if (!borderTop && !borderBottom) continue;
            const rect = row.getBoundingClientRect();
            add(row, 'separator-edges', { left: rect.left - left, right: right - rect.right }, Math.abs(rect.left - left) <= 1 && Math.abs(right - rect.right) <= 1);
            const firstRow = Math.abs(rect.top - box.top - parseFloat(style.borderTopWidth)) <= 1;
            if (firstRow) add(row, 'first-row-separator', { borderTop }, borderTop === 0);
        }
        for (const row of body.querySelectorAll('.ds-row')) {
            if (!visible(row)) continue;
            let previous = row;
            for (let helper = row.nextElementSibling; helper?.matches('.toggle-description, .notes, p, small'); helper = helper.nextElementSibling) {
                if (!visible(helper)) continue;
                const previousBorderBottom = parseFloat(getComputedStyle(previous).borderBottomWidth);
                const helperBorderTop = parseFloat(getComputedStyle(helper).borderTopWidth);
                add(helper, 'helper-separator', { previousBorderBottom, helperBorderTop }, previousBorderBottom === 0 && helperBorderTop === 0);
                previous = helper;
            }
        }
        for (const element of body.querySelectorAll('.sb-action-btn-label')) {
            if (!visible(element)) continue;
            add(element, 'label-width', { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }, element.scrollWidth <= element.clientWidth);
        }
    }
    return records;
}
