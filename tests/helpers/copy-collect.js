/**
 * The page side of the copy check (`audit/surface-audit.e2e.js`): reads the text that a user sees inside a surface's root, with the role
 * that the element is drawn in. The role is decided by what is rendered (a check box that the settings pass draws as a switch row is a
 * row title), not by the markup that produced it. `collectCopy` runs in the page, so it must not use anything outside its own body.
 */

/**
 * Runs in the page.
 * @param {Element} root The surface's root element.
 * @returns {{ role: string, text: string, target: string }[]} One entry per visible text, tooltip, accessible name or placeholder that
 *   a role covers. `target` is a short selector: the element and the ancestors up to the nearest one with an id (four at most).
 */
export function collectCopy(root) {
    const ROW_TITLE = '.ds-row-label, .ds-row-entry__title, .ds-row-textarea__label';
    const ROW_SUBTITLE = '.ds-row-subtitle, .ds-pref-group-subtitle, .ds-row-entry__caption, .ds-row-textarea__caption';
    const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"], .ds-pref-group-heading, .sb-dialog__title';
    // The title of a page, a dialog, a status page or a card is a heading wherever its class says so (`pf--quickstart-title`).
    const TITLE_CLASS = '[class*="title" i]:not([class*="subtitle" i])';
    const CLASSIFIED = `${ROW_TITLE}, ${ROW_SUBTITLE}, ${HEADING}, ${TITLE_CLASS}, [role="tab"], [role^="menuitem"], [role="option"], label`;
    const BUTTON = 'button, [role="button"], input[type="button"], input[type="submit"], .menu_button, .right_menu_button';
    // Text that a control holds as its value (a field's content, a native select's options) is not part of its label.
    const SKIPPED_TAGS = new Set(['script', 'style', 'svg', 'template', 'noscript', 'textarea', 'select']);
    const STATE_CLASS = /^(?:active|open|opened|closed|selected|hidden|focus|focused|hover|expanded|collapsed|checked|disabled|is-|has-|ui-)/;

    // A chip, badge or scope marker beside a title ("Global") is a value that the row shows, not a part of the title.
    const CHIP = '[class*="chip"], [class*="badge"], [class*="pill"], [class*="scope"]';

    const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const inert = element => Boolean(element.closest('[inert]'));
    const clean = text => text.replace(/\s+/g, ' ').trim();
    const counts = (node, element) => node === element || (!SKIPPED_TAGS.has(node.localName) && visible(node) && !node.matches(CHIP));

    /** The text of an element as drawn: no hidden child, no icon, no chip, no style or script, and no text transform. */
    function textOf(element) {
        let out = '';
        const walk = node => {
            if (node.nodeType === 3) {
                out += node.nodeValue;
            } else if (node.nodeType === 1 && counts(node, element)) {
                node.childNodes.forEach(walk);
            }
        };
        walk(element);
        return clean(out);
    }

    /** The text that an element draws itself: its own text and its inline children's, without the lines of block children. */
    function runOf(element) {
        let out = '';
        const walk = node => {
            if (node.nodeType === 3) {
                out += node.nodeValue;
            } else if (node.nodeType === 1 && counts(node, element) && (node === element || getComputedStyle(node).display === 'inline')) {
                node.childNodes.forEach(walk);
            }
        };
        walk(element);
        return clean(out);
    }

    /**
     * The elements of a control that each draw a line of text of their own (a card's name and its description). A control with one
     * line is one text; the first line of a control with several is its label and the others are descriptions.
     */
    function linesOf(element) {
        const lines = [];
        const visit = node => {
            if (!counts(node, element)) {
                return;
            }
            if ((node === element || getComputedStyle(node).display !== 'inline') && runOf(node)) {
                lines.push(node);
            }
            [...node.children].forEach(visit);
        };
        visit(element);
        return lines;
    }

    function part(element) {
        const classes = [...element.classList].filter(name => !STATE_CLASS.test(name) && !/^\d+$/.test(name));
        return `${element.localName}${element.id ? `#${element.id}` : ''}${classes.map(name => `.${name}`).join('')}`;
    }

    function targetOf(element) {
        const parts = [];
        for (let node = element, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
            parts.unshift(part(node));
            if (node.id || node === root) {
                break;
            }
        }
        return parts.join(' > ');
    }

    /** The control that a label or a row names: a switch, a check box or a radio button. */
    function controlOf(element) {
        const label = element.closest('label');
        const direct = label?.control ?? (label?.htmlFor ? root.ownerDocument.getElementById(label.htmlFor) : null) ?? element.querySelector('input');
        if (direct) {
            return direct;
        }
        const row = element.closest('.ds-row');
        const inputs = row ? row.querySelectorAll('input[type="checkbox"], input[type="radio"]') : [];
        return inputs.length === 1 ? inputs[0] : null;
    }

    const isSwitch = control => control.getAttribute('role') === 'switch' || control.classList.contains('sb-switch');

    /** The role that a labelling element has: a bare check box or radio button has a sentence-case label, a switch row a title. */
    function labelRole(element, fallback) {
        const control = controlOf(element);
        if (control && /^(?:checkbox|radio)$/.test(control.type ?? '')) {
            return isSwitch(control) ? 'row title' : 'check or radio label';
        }
        return fallback;
    }

    function textRoleOf(element) {
        const role = element.getAttribute('role') ?? '';
        if (role === 'tab') {
            return 'tab';
        }
        if (role.startsWith('menuitem')) {
            return 'menu item';
        }
        if (role === 'option') {
            return 'drop-down item';
        }
        // The name of a property row is its title in the Caption size; its value is data.
        if (element.closest('.ds-row-property')) {
            return element.matches('.ds-row-subtitle') ? 'row title' : null;
        }
        if (element.matches(ROW_TITLE)) {
            return labelRole(element, 'row title');
        }
        if (element.matches(ROW_SUBTITLE)) {
            return 'row subtitle';
        }
        if (element.matches(HEADING) || (element.matches(TITLE_CLASS) && !element.matches(BUTTON))) {
            return 'heading';
        }
        if (element.localName === 'label' || element.localName === 'legend') {
            return element.querySelector(CLASSIFIED) ? null : labelRole(element, 'field label');
        }
        if (element.matches(BUTTON) && !element.querySelector(CLASSIFIED)) {
            // The trigger of a select row shows the chosen item, so it is a drop-down item and not a button.
            return element.matches('.ds-select-row__trigger') ? 'drop-down item' : 'button';
        }
        return null;
    }

    const items = [];
    const add = (element, role, text) => {
        const flat = clean(text ?? '');
        if (flat && /\p{L}/u.test(flat)) {
            items.push({ role, text: flat, target: targetOf(element) });
        }
    };

    for (const element of [root, ...root.querySelectorAll('*')]) {
        if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || /^(?:script|style|template|noscript)$/.test(element.localName)) {
            continue;
        }
        if (!visible(element) || inert(element) || element.closest('[data-sb-copy-placeholder]')) {
            continue;
        }
        if (element.hasAttribute('title')) {
            add(element, 'tooltip', element.getAttribute('title'));
        }
        if (element.hasAttribute('aria-label')) {
            add(element, 'accessible name', element.getAttribute('aria-label'));
        }
        if ((element.localName === 'input' || element.localName === 'textarea') && element.placeholder && !element.hasAttribute('data-sb-copy-placeholder')) {
            add(element, 'placeholder', element.placeholder);
        }
        const role = textRoleOf(element);
        if (!role) {
            continue;
        }
        const lines = /^(?:button|menu item|drop-down item|tab)$/.test(role) ? linesOf(element) : [];
        if (lines.length >= 2) {
            lines.forEach((line, index) => add(line, index === 0 ? role : 'row subtitle', runOf(line)));
        } else {
            add(element, role, textOf(element));
        }
    }
    return items;
}
