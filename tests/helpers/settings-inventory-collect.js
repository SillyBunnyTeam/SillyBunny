/**
 * The browser half of the settings inventory. `installInventoryApi` is passed to `page.evaluate()`, so it runs in the page and
 * must not use anything from this module's scope. It adds `window.__sbInventory`:
 *
 *   collect(root, { skip })              every control under `root`, with its identity, kind, name, group, whether it is shown and what drives it
 *   mark(root, identity, { skip, anywhere })
 *                                        tags the control and the element the user operates with `data-sb-inventory-target`
 *                                        ("control" and "driver"), so that Playwright can reach them with a locator
 *   unmark()                             removes the tags
 *   reach()                              reads the box of the marked driver: shown, disabled, and what covers its centre
 *   valueOf()                            reads the value of the marked control
 *   limits()                             reads min, max and step of the marked number or range from the live element
 *   selectOptions()                      the options that a user can choose in the marked select
 *   radioPeer()                          tags the other members of the marked radio's group
 *   markDialogs(), openedDialogs()       tell the dialogs that a change opened from the ones that were open already
 *   savesPending()                       how many debounced saves of the app are waiting for their timer
 *
 * A control is identified by what it is, never by the classes that lay it out: the element id, else its `name`, else a
 * `data-*` hook, else the `data-sb-editor-field` of the row it sits in, else its accessible name, folded to lower case. The page's own scripts
 * hand out ids such as `sb-row-12` to controls that have none, and those change from one boot to the next, so they are not used.
 */
export function installInventoryApi({ secretNames = [], saveDelay = 1000 } = {}) {
    if (window.__sbInventory) {
        return;
    }

    // The app's debounced save keeps its timer after a forced save, and fires later with whatever is in memory by then. Counting those
    // timers lets a change start only once no earlier one is pending, so that a save that is not the change's own cannot carry its value.
    const pendingSaves = new Set();
    const nativeSetTimeout = window.setTimeout;
    const nativeClearTimeout = window.clearTimeout;
    window.setTimeout = function (handler, delay, ...rest) {
        if (delay !== saveDelay || typeof handler !== 'function' || !new Error().stack.includes('/scripts/utils.js')) {
            return nativeSetTimeout.call(this, handler, delay, ...rest);
        }
        const id = nativeSetTimeout.call(this, function (...args) {
            pendingSaves.delete(id);
            return handler.apply(this, args);
        }, delay, ...rest);
        pendingSaves.add(id);
        return id;
    };
    window.clearTimeout = function (id) {
        pendingSaves.delete(id);
        return nativeClearTimeout.call(this, id);
    };

    const CANDIDATES = [
        'input:not([type="hidden"])', 'select', 'textarea', 'button', 'a[href]', '[role="button"]', '[role="switch"]',
        '[role="slider"]', '[role="spinbutton"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]', '.menu_button', 'toolcool-color-picker',
    ].join(', ');
    // Chrome of the pickers and menus that open over a page, and the select-row button that drives a native select.
    const OWN_CHROME = '.select2-container, .select2-dropdown, .sb-picker, .sb-action-menu, .sb-action-sheet, .ds-select-row__trigger';
    const HEADING = 'h1, h2, h3, h4, h5, h6, legend, .ds-pref-group-heading, .sb-settings-category-title, .standoutHeader';
    const GENERATED_ID = /^(?:sb-row-\d+|sb-select-row-(?:value|label|description)-\d+|sb-list-search-[a-z0-9]+|select2-.*|ui-id-\d+|toast-.*|[a-z]+-\d{10,})$/;
    // The name that the segmented controls give a group of radios counts the groups the page has built.
    const GENERATED_NAME = /^sb-segmented-\d+$/;
    // `data-original-*` is what the page keeps of an attribute that it changes while a block is disabled (`data-original-tabindex`).
    // The elements that the page marks as one setting's row, which hold the control that the row's other controls belong to.
    const ROW_MARKERS = '[data-sampling-parameter], .range-block, .ds-row';
    const IGNORED_DATA = /^data-(?:original-.*|sb-can-update|i18n|tooltip|popper.*|bs-.*|sb-presentation|sb-adopted.*|sb-copy-placeholder|sb-floating-placeholder|sb-inventory-target|sb-search.*|sb-settings-row.*|sb-density|sb-state|sb-open|sb-hidden)$/;

    const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const cssEscape = value => (window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

    function labelText(label) {
        const copy = label.cloneNode(true);
        copy.querySelectorAll('select, textarea, input, style, script, .ds-row-suffix, .ds-row-subtitle, .select2-container, toolcool-color-picker').forEach(node => node.remove());
        return text(copy);
    }

    function iconName(el) {
        const icon = el.matches('[class*="fa-"]') ? el : el.querySelector('[class*="fa-"]');
        const found = icon && [...icon.classList].find(name => name.startsWith('fa-') && !/^fa-(?:solid|regular|brands|fw|lg|xs|sm|xl|2x|3x|spin)$/.test(name));
        return found ? `icon:${found}` : '';
    }

    function kindOf(el) {
        const tag = el.localName;
        if (tag === 'select') {
            return 'select';
        }
        if (tag === 'textarea') {
            return 'textarea';
        }
        if (tag === 'toolcool-color-picker') {
            return 'color';
        }
        if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'checkbox') {
                return el.getAttribute('role') === 'switch' || el.classList.contains('sb-switch') || el.closest('.ds-row-switch') ? 'switch' : 'checkbox';
            }
            if (type === 'radio') {
                return 'radio';
            }
            if (type === 'range') {
                return 'range';
            }
            if (type === 'number') {
                return 'number';
            }
            if (type === 'color') {
                return 'color';
            }
            if (type === 'file') {
                return 'file';
            }
            if (['button', 'submit', 'reset', 'image'].includes(type)) {
                return 'button';
            }
            return 'text';
        }
        const role = el.getAttribute('role');
        if (role === 'switch') {
            return 'switch';
        }
        if (role === 'checkbox') {
            return 'checkbox';
        }
        if (role === 'radio') {
            return 'radio';
        }
        if (role === 'slider') {
            return 'range';
        }
        if (role === 'spinbutton') {
            return 'number';
        }
        if (tag === 'a' && el.hasAttribute('href') && role !== 'button') {
            return 'link';
        }
        return 'button';
    }

    function nameOf(el) {
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
            const joined = labelledby.split(/\s+/).map(id => text(document.getElementById(id))).filter(Boolean).join(' ');
            if (joined) {
                return joined;
            }
        }
        const aria = el.getAttribute('aria-label')?.trim();
        if (aria) {
            return aria;
        }
        const own = el.labels ? [...el.labels].map(labelText).filter(Boolean)[0] : '';
        if (own) {
            return own;
        }
        const rowLabel = el.closest('.ds-row')?.querySelector('.ds-row-label');
        if (rowLabel && text(rowLabel)) {
            return text(rowLabel);
        }
        const block = el.closest('.range-block, .range-block-range-and-counter, .flex-container, .checkbox_label');
        const blockTitle = block?.querySelector(':scope > .range-block-title, :scope > .range_block_title, :scope > h4, :scope > small, :scope > span');
        if (el.localName !== 'button' && blockTitle && !blockTitle.contains(el) && text(blockTitle)) {
            return text(blockTitle);
        }
        if (['button', 'a'].includes(el.localName) || el.matches('.menu_button, [role="button"], [role="tab"]')) {
            const inner = el.localName === 'input' ? el.value : labelText(el);
            if (inner) {
                return inner;
            }
        }
        const title = el.getAttribute('title')?.trim();
        if (title) {
            return title;
        }
        const placeholder = el.getAttribute('placeholder')?.trim();
        if (placeholder) {
            return placeholder;
        }
        return iconName(el) || (el.localName === 'input' ? el.value : '') || '';
    }

    function groupOf(el, root) {
        for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
            for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
                const heading = sibling.matches(HEADING) ? sibling
                    : (!sibling.querySelector(CANDIDATES) && text(sibling).length < 300 ? sibling.querySelector(HEADING) : null);
                if (heading && text(heading)) {
                    return text(heading).slice(0, 80);
                }
            }
        }
        return '';
    }

    function visible(el, root) {
        if (!el || !el.isConnected) {
            return false;
        }
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
            return false;
        }
        const own = el.getBoundingClientRect();
        if (own.width < 1 || own.height < 1) {
            return false;
        }
        let rect = { left: own.left, right: own.right, top: own.top, bottom: own.bottom };
        for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
            const parentStyle = getComputedStyle(node);
            if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || Number(parentStyle.opacity) === 0) {
                return false;
            }
            // Only an axis that clips cuts the element off; a scroller (`auto`) brings it into view.
            const clipsX = /^(?:hidden|clip)$/.test(parentStyle.overflowX);
            const clipsY = /^(?:hidden|clip)$/.test(parentStyle.overflowY);
            const box = node.getBoundingClientRect();
            if (clipsX || clipsY) {
                if ((clipsX && (box.width < 1 || rect.right <= box.left || rect.left >= box.right))
                    || (clipsY && (box.height < 1 || rect.bottom <= box.top || rect.top >= box.bottom))) {
                    return false;
                }
            }
            // Beyond a scroller the element stands where the scroller shows it, so a taller page is not cut off by the frame around it.
            const scrollsX = /^(?:auto|scroll)$/.test(parentStyle.overflowX);
            const scrollsY = /^(?:auto|scroll)$/.test(parentStyle.overflowY);
            if (scrollsX || scrollsY) {
                rect = {
                    left: scrollsX ? box.left : rect.left,
                    right: scrollsX ? box.right : rect.right,
                    top: scrollsY ? box.top : rect.top,
                    bottom: scrollsY ? box.bottom : rect.bottom,
                };
            }
            if (node === root) {
                break;
            }
        }
        return true;
    }

    function driverOf(el, kind, root) {
        if (visible(el, root)) {
            return { element: el, via: 'self' };
        }
        if (kind === 'select') {
            const trigger = el.closest('.ds-select-row')?.querySelector('.ds-select-row__trigger');
            if (trigger && visible(trigger, root)) {
                return { element: trigger, via: 'select-row' };
            }
            const container = el.nextElementSibling?.matches('.select2-container') ? el.nextElementSibling : null;
            if (container && visible(container, root)) {
                return { element: container, via: 'select2' };
            }
        }
        if (['switch', 'checkbox', 'radio', 'file'].includes(kind) && el.labels) {
            const label = [...el.labels].find(candidate => visible(candidate, root));
            if (label) {
                return { element: label, via: 'label' };
            }
        }
        return null;
    }

    function isExpander(el) {
        return el.matches('summary, .inline-drawer-toggle, .inline-drawer-header')
            || (el.hasAttribute('aria-expanded') && !el.hasAttribute('aria-haspopup') && el.closest('[data-sb-panel]') !== null
                && el.matches('button, [role="button"], .ds-row'));
    }

    function candidatesIn(root, skip) {
        const skipSelector = skip.length ? skip.join(', ') : null;
        return [...new Set(root.querySelectorAll(CANDIDATES))].filter(el => {
            if (el.closest(OWN_CHROME) || isExpander(el) || el.closest('option, datalist')) {
                return false;
            }
            return !(skipSelector && el.closest(skipSelector));
        });
    }

    function hooksOf(el) {
        return el.getAttributeNames().sort()
            .filter(name => name.startsWith('data-') && !IGNORED_DATA.test(name) && el.getAttribute(name) && el.getAttribute(name).length <= 60)
            .map(name => `${name}=${el.getAttribute(name)}`);
    }

    /** What the page's own markup says a label is: case, runs of spaces and a closing colon or full stop are not part of a name. */
    const foldName = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.:;!?\u2026]+$/, '');

    const stableId = el => {
        const id = el.getAttribute('id');
        return id && !GENERATED_ID.test(id) ? id : null;
    };

    /**
     * The control with an id that a hook or a label belongs to: the first one in the nearest ancestor that holds one to three,
     * so that the same hook on every sampler row (the Auto, Send and Omit buttons) tells the rows apart by the row's own control.
     */
    function anchorOf(el) {
        let node = el.parentElement;
        for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
            const withIds = [...node.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(control => control !== el && stableId(control));
            if (withIds.length > 3) {
                return null;
            }
            if (withIds.length) {
                return stableId(withIds[0]);
            }
        }
        return null;
    }

    /** The identity of a control, before the suffix that keeps two equal ones apart. */
    function identityOf(el, kind, name) {
        const id = stableId(el);
        if (id) {
            return { identity: `#${id}`, identityKind: 'id' };
        }
        const nameAttr = el.getAttribute('name');
        if (nameAttr && !GENERATED_NAME.test(nameAttr)) {
            return { identity: kind === 'radio' ? `name:${nameAttr}=${el.value}` : `name:${nameAttr}`, identityKind: 'name' };
        }
        const [hook] = hooksOf(el);
        if (hook) {
            return { identity: `data:${hook}`, identityKind: 'data' };
        }
        const field = el.closest('[data-sb-editor-field]')?.getAttribute('data-sb-editor-field');
        if (field) {
            return { identity: `field:${field}:${kind}`, identityKind: 'field' };
        }
        return { identity: `label:${kind}:${foldName(name) || '(no name)'}`, identityKind: 'label' };
    }

    function groupLabelOf(group) {
        const labelledby = group.getAttribute('aria-labelledby');
        const joined = labelledby ? labelledby.split(/\s+/).map(id => text(document.getElementById(id))).filter(Boolean).join(' ') : '';
        return joined || group.getAttribute('aria-label')?.trim() || text(group.querySelector(':scope > legend')) || '';
    }

    /** What the markup says a control belongs to: the element it controls, or the labelled group (a radio group, a toolbar) it sits in. */
    function relationOf(el) {
        const target = (el.getAttribute('aria-controls') || el.getAttribute('data-for') || '').split(/\s+/)[0];
        const controlled = target ? document.getElementById(target) : null;
        if (controlled && stableId(controlled)) {
            return `controls:#${stableId(controlled)}`;
        }
        const group = el.closest('[role="radiogroup"], [role="group"], [role="toolbar"], fieldset');
        const label = group && groupLabelOf(group);
        if (label) {
            return `in:${foldName(label)}`;
        }
        // A button that sits beside the label of the field it belongs to (a restore button next to the label of its textarea).
        const sibling = el.matches('button, [role="button"], .menu_button') ? el.parentElement?.querySelector(':scope > label[for]') : null;
        const labelled = sibling ? document.getElementById(sibling.getAttribute('for')) : null;
        return labelled && stableId(labelled) ? `for:#${stableId(labelled)}` : null;
    }

    const hrefOf = el => {
        const href = el.localName === 'a' ? el.getAttribute('href') : null;
        return href && !/^(?:#|javascript:)/i.test(href) ? `href:${href.replace(/[?#].*$/, '').replace(/\/$/, '')}` : null;
    };

    /**
     * Every control of the root with its identity. An identity that two controls share (the same hook on every sampler row) is
     * qualified step by step, each step only for the controls that still share it: the relation that the markup states, the control's
     * own name, a second `data-*` hook, the link's address, the control with an id that the row holds, and last the nearest control with an
     * id (`viaNesting`: this step depends on how the page nests its rows). What is still shared after that is numbered in document order (`~2`).
     */
    function identify(root, skip) {
        const items = candidatesIn(root, skip).map(element => {
            const kind = kindOf(element);
            const name = nameOf(element);
            return { element, kind, name, qualifiers: [], viaNesting: false, ...identityOf(element, kind, name) };
        });
        const keyOf = item => item.identity + item.qualifiers.map(qualifier => `@${qualifier}`).join('');
        const ladder = [
            item => relationOf(item.element),
            item => (item.identityKind !== 'label' && item.name ? `as:${foldName(item.name)}` : null),
            item => {
                const hooks = hooksOf(item.element).filter(hook => `data:${hook}` !== item.identity);
                return hooks.length ? `has:${hooks[0]}` : null;
            },
            item => hrefOf(item.element),
            item => {
                const row = item.element.closest(ROW_MARKERS);
                const own = row && [...row.querySelectorAll('input, select, textarea')].find(control => control !== item.element && stableId(control));
                return own ? `row:#${stableId(own)}` : null;
            },
            item => {
                const anchor = anchorOf(item.element);
                return anchor ? `#${anchor}` : null;
            },
        ];
        // A step is taken for a set of controls that share an identity only when it tells them apart, so that a name that two of them
        // have in common is not made part of both identities.
        for (const step of ladder) {
            const groups = new Map();
            for (const item of items) {
                if (item.identityKind !== 'id' && item.identityKind !== 'name') {
                    groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
                }
            }
            for (const members of groups.values()) {
                const qualifiers = members.length > 1 ? members.map(step) : [];
                if (new Set(qualifiers).size > 1) {
                    members.forEach((item, index) => qualifiers[index] && item.qualifiers.push(qualifiers[index]));
                }
            }
        }
        const seen = new Map();
        for (const item of items) {
            item.identity = keyOf(item);
            const count = (seen.get(item.identity) ?? 0) + 1;
            seen.set(item.identity, count);
            if (count > 1) {
                item.identity = `${item.identity}~${count}`;
            }
        }
        for (const item of items) {
            item.viaNesting = item.qualifiers.some(qualifier => qualifier.startsWith('#'));
        }
        return items;
    }

    /** The markers that the app puts on a field for a secret: a password input, the masking class, and the names of its secrets store. */
    const isSecret = el => el.type === 'password' || el.classList.contains('masked-secret')
        || secretNames.includes(el.getAttribute('name') ?? '') || secretNames.includes(el.id.replace(/-tg$/, ''));

    function collect(rootSelector, { skip = [] } = {}) {
        const root = document.querySelector(rootSelector);
        if (!root) {
            throw new Error(`The root ${rootSelector} is not on the page.`);
        }
        return identify(root, skip).map(({ element, kind, name, identity, identityKind, viaNesting }) => {
            const driver = driverOf(element, kind, root);
            const record = {
                identity, identityKind, kind, name: name.slice(0, 120), group: groupOf(element, root),
                shown: Boolean(driver),
                disabled: element.disabled === true || element.closest('[inert]') !== null || element.getAttribute('aria-disabled') === 'true',
            };
            if (driver && driver.via !== 'self') {
                record.driver = driver.via;
            }
            if (viaNesting) {
                record.viaNesting = true;
            }
            if (kind === 'select' && element.multiple) {
                record.multiple = true;
            }
            if (kind === 'text' && isSecret(element)) {
                record.secret = true;
            }
            if (kind === 'number' || kind === 'range') {
                for (const attribute of ['min', 'max', 'step']) {
                    if (element.getAttribute(attribute) !== null) {
                        record[attribute] = element.getAttribute(attribute);
                    }
                }
            }
            if (element.localName === 'input' && element.type === 'file') {
                record.accept = element.getAttribute('accept') ?? '';
            }
            return record;
        });
    }

    function unmark() {
        document.querySelectorAll('[data-sb-inventory-target]').forEach(node => node.removeAttribute('data-sb-inventory-target'));
    }

    function mark(rootSelector, identity, { skip = [], anywhere = false } = {}) {
        unmark();
        const scope = anywhere ? document.documentElement : document.querySelector(rootSelector);
        if (!scope) {
            return { found: false, reason: `The root ${rootSelector} is not on the page.` };
        }
        let element = null;
        let kind = null;
        const match = identity.match(/^#(.+?)(?:~(\d+))?$/);
        if (match) {
            const same = [...scope.querySelectorAll(`[id="${cssEscape(match[1]).replace(/\\/g, '\\\\')}"]`)].filter(node => !(node.closest(OWN_CHROME)));
            const wanted = same.filter(node => node.matches(CANDIDATES));
            element = (wanted.length ? wanted : same)[Number(match[2] ?? 1) - 1] ?? null;
            kind = element && kindOf(element);
        }
        if (!element) {
            const found = identify(scope, skip).find(candidate => candidate.identity === identity);
            element = found?.element ?? null;
            kind = found?.kind ?? null;
        }
        if (!element) {
            return { found: false, reason: 'No control has this identity.' };
        }
        const root = document.querySelector(rootSelector) ?? document.documentElement;
        let driver = driverOf(element, kind, root);
        if (!driver) {
            // A container that clips (and is not a scroller) is moved by an earlier scroll; a user would scroll the control back into it.
            element.scrollIntoView({ block: 'center', inline: 'center' });
            driver = driverOf(element, kind, root);
        }
        element.setAttribute('data-sb-inventory-target', 'control');
        if (driver && driver.element !== element) {
            driver.element.setAttribute('data-sb-inventory-target', 'driver');
        }
        return { found: true, kind, shown: Boolean(driver), via: driver?.via ?? null };
    }

    function reach() {
        const control = document.querySelector('[data-sb-inventory-target="control"]');
        const driver = document.querySelector('[data-sb-inventory-target="driver"]') ?? control;
        if (!control || !driver) {
            return { problem: 'nothing is marked' };
        }
        const rect = driver.getBoundingClientRect();
        const result = {
            width: Math.round(rect.width), height: Math.round(rect.height),
            disabled: control.disabled === true || control.closest('[inert]') !== null || control.getAttribute('aria-disabled') === 'true',
            inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        };
        const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
        const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
        const top = document.elementFromPoint(x, y);
        const label = control.closest('label');
        result.covered = !(top && (driver.contains(top) || control.contains(top)
            || (top.closest('label') && (top.closest('label') === label || top.closest('label').control === control))
            || (control.id && top.closest(`label[for="${cssEscape(control.id)}"]`))));
        if (result.covered && top) {
            result.coveredBy = `${top.localName}${top.id ? `#${top.id}` : ''}${typeof top.className === 'string' && top.className ? `.${top.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}`;
        }
        return result;
    }

    function valueOf() {
        const control = document.querySelector('[data-sb-inventory-target="control"]');
        if (!control) {
            return null;
        }
        if (control.localName === 'select') {
            return control.multiple ? [...control.selectedOptions].map(option => option.value) : control.value;
        }
        if (control.type === 'checkbox' || control.type === 'radio') {
            return control.checked;
        }
        if (control.localName !== 'input' && control.getAttribute('aria-checked') !== null) {
            return control.getAttribute('aria-checked') === 'true';
        }
        if (control.getAttribute('role') === 'spinbutton' && control.localName !== 'input') {
            return control.getAttribute('aria-valuenow') ?? control.textContent.trim();
        }
        return control.value ?? null;
    }

    /**
     * The limits of the marked number or range as the live element states them (a spin row states them as aria-valuemin and
     * aria-valuemax), and what a text field says of the format that it takes.
     */
    function limits() {
        const control = document.querySelector('[data-sb-inventory-target="control"]');
        if (!control) {
            return {};
        }
        const read = (attribute, aria) => control.getAttribute(attribute) ?? control.getAttribute(aria) ?? undefined;
        return {
            min: read('min', 'aria-valuemin'),
            max: read('max', 'aria-valuemax'),
            step: control.getAttribute('step') ?? undefined,
            type: control.getAttribute('type') ?? '',
            placeholder: control.getAttribute('placeholder') ?? '',
            id: control.id,
        };
    }

    /**
     * The identities of another member of the marked radio's group (`other`) and of the member that is on now (`on`, null when it is
     * the control itself). A radio cannot be turned off, so its value is changed by choosing another member and put back by
     * choosing the one that was on. Identities, because a page may build its rows again when a value changes.
     */
    function radioPeer(rootSelector, { skip = [] } = {}) {
        const control = document.querySelector('[data-sb-inventory-target="control"]');
        const root = document.querySelector(rootSelector);
        if (!control || !root) {
            return null;
        }
        let members;
        if (control.localName === 'input') {
            members = control.name
                ? [...document.querySelectorAll(`input[type="radio"][name="${cssEscape(control.name).replace(/\\/g, '\\\\')}"]`)].filter(member => member.form === control.form)
                : [control];
        } else {
            const group = control.closest('[role="radiogroup"]') ?? control.parentElement;
            members = [...group.querySelectorAll('[role="radio"]')];
        }
        const isOn = member => (member.localName === 'input' ? member.checked : member.getAttribute('aria-checked') === 'true');
        const others = members.filter(member => member !== control && !member.disabled);
        const peer = others.find(member => !isOn(member)) ?? others[0];
        if (!peer) {
            return null;
        }
        const on = members.find(isOn);
        const identities = new Map(identify(root, skip).map(candidate => [candidate.element, candidate.identity]));
        return {
            other: identities.get(peer) ?? null,
            on: on && on !== control ? identities.get(on) ?? null : null,
        };
    }

    const knownDialogs = new WeakSet();
    const openDialogs = () => [...document.querySelectorAll('dialog[open]')];
    /** Remembers the dialogs that are open now. */
    function markDialogs() {
        openDialogs().forEach(dialog => knownDialogs.add(dialog));
    }
    /** How many dialogs are open that were not when `markDialogs()` last ran. */
    const openedDialogs = () => openDialogs().filter(dialog => !knownDialogs.has(dialog)).length;

    function selectOptions() {
        const control = document.querySelector('[data-sb-inventory-target="control"]');
        if (!control || control.localName !== 'select') {
            return [];
        }
        return [...control.options].filter(option => !option.hidden && !option.disabled && !option.closest('optgroup[disabled]'))
            .map(option => ({ value: option.value, label: option.textContent.replace(/\s+/g, ' ').trim(), selected: option.selected }));
    }

    window.__sbInventory = { collect, mark, unmark, reach, valueOf, limits, selectOptions, radioPeer, markDialogs, openedDialogs, savesPending: () => pendingSaves.size };
}
