/**
 * The browser side of the parity tool. `measureInPage` and `skeletonInPage` are serialised into the page by Playwright, so
 * each is self-contained. A value is a computed style, or `offsetWidth` and `offsetHeight` for a size; a size is not read from
 * a bounding rectangle, which a scale transform would change.
 *
 * Every shown instance of a part is measured, up to `MAX_INSTANCES` for one part, and the values are folded in the page: a cell
 * holds one entry for each distinct value (and each form, see below) with the number of instances that have it and the
 * description of the first. A member therefore costs a few entries however much data a list holds.
 *
 * A form is a condition that a canonical value can depend on: a media query (read in the page, so the pointer type and the
 * overlay breakpoint are the page's own) or an ancestor selector. The page reports, for each cell entry, the forms of the
 * property that hold for the instances.
 */

import { expect } from '@playwright/test';
import { prepareRules } from './compare.js';

export const MAX_INSTANCES = 400;

/** How long a measurement must stay the same, and how long to wait for that, in milliseconds. */
const QUIET_MS = 500;
const SETTLE_TIMEOUT_MS = 15_000;
const GONE = 'is not shown';

/**
 * Reads until the read has not changed for `QUIET_MS`, so that a panel that fills in after it opens (a list that loads, a section
 * that renders late) is measured whole. Two equal reads in a row are not enough: they can be 100ms apart.
 * @template T
 * @param {() => Promise<T>} read A read that is JSON.
 * @returns {Promise<T>}
 */
async function quietRead(read) {
    let last = '';
    let failure = '';
    let changedAt = Date.now();
    try {
        await expect.poll(async () => {
            let now;
            try {
                now = JSON.stringify(await read());
                failure = '';
            } catch (error) {
                failure = String(error.message).split('\n').find(line => line.trim() !== '') ?? '';
                if (last !== '' && failure.includes(GONE)) {
                    // A popover or sheet that closes by itself after it was read stays measured as it was read.
                    return true;
                }
                throw error;
            }
            if (now !== last) {
                last = now;
                changedAt = Date.now();
            }
            return Date.now() - changedAt >= QUIET_MS;
        }, { timeout: SETTLE_TIMEOUT_MS, intervals: [100] }).toBe(true);
    } catch (error) {
        throw new Error(failure || `The surface did not stop changing within ${SETTLE_TIMEOUT_MS}ms. The last read was ${last.slice(0, 400)}.`, { cause: error });
    }
    return JSON.parse(last);
}

/**
 * The surface's root is found in the page, in the same turn as the measurement: a panel that renders again and again can
 * replace the element between a locator finding it and the measurement reading it.
 * @param {{ rootSelector: string, rules: { parts: any[], forms: Record<string, { media?: string, closest?: string }> }, ready: string[], maxInstances: number }} input
 *   The root selector of the surface (the first of its matches that is shown), the output of `prepareRules`, the `ready`
 *   selectors of the surface, and the cap of instances per part.
 * @returns {{ pointer: 'fine' | 'coarse', tokens: Record<string, string>, parts: Record<string, any> }}
 */
export function measureInPage({ rootSelector, rules, ready, maxInstances }) {
    const hasShownText = node => {
        if (node.nodeType !== Node.TEXT_NODE || node.textContent.trim() === '') {
            return false;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    };
    // An element with `display: contents` has no box of its own and is shown when a child or its text is, as Playwright decides it.
    const isShown = element => {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') {
            return false;
        }
        if (style.display === 'contents') {
            return [...element.childNodes].some(node => (node.nodeType === Node.ELEMENT_NODE ? isShown(node) : hasShownText(node)));
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const isIconOnly = element => {
        const clone = element.cloneNode(true);
        clone.querySelectorAll('.sr-only').forEach(node => node.remove());
        return clone.textContent.trim() === '';
    };
    const describe = element => {
        const classes = typeof element.className === 'string'
            ? element.className.trim().split(/\s+/).filter(name => name && !/^(?:is-|has-|ui-|active$|selected$|\d)|\d$/.test(name)).slice(0, 4)
            : [];
        return `${element.localName}${classes.map(name => `.${name}`).join('')}`;
    };
    const read = (element, style, property) => {
        if (property === 'offsetWidth') {
            return element.offsetWidth ?? Math.round(element.getBoundingClientRect().width);
        }
        if (property === 'offsetHeight') {
            return element.offsetHeight ?? Math.round(element.getBoundingClientRect().height);
        }
        return style[property];
    };
    const readyElements = () => {
        const found = [];
        for (const selector of ready) {
            try {
                found.push(...document.querySelectorAll(selector.replace(/:visible/g, '')));
            } catch {
                // A selector in Playwright syntax that the browser does not know finds nothing here.
            }
        }
        return found.filter(element => root === element || root.contains(element));
    };
    const candidates = alternative => {
        if (alternative.ready) {
            return readyElements();
        }
        const found = [];
        if (root.matches(alternative.selector)) {
            found.push(root);
        }
        found.push(...root.querySelectorAll(alternative.selector));
        return found;
    };

    const matches = [...document.querySelectorAll(rootSelector.replace(/:visible/g, ''))];
    const root = matches.find(isShown);
    if (!root) {
        const seen = matches.slice(0, 3).map(element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return `${describe(element)} display ${style.display} visibility ${style.visibility} opacity ${style.opacity} ${box.width}x${box.height}`;
        });
        throw new Error(`The surface root ${rootSelector} is not shown, so no part of it can be measured (${matches.length} matches${seen.length ? `: ${seen.join('; ')}` : ''}).`);
    }
    const pointer = matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine';
    const tokens = {};
    const resolveToken = (property, token) => {
        const key = `${property}|${token}`;
        if (key in tokens) {
            return;
        }
        if (!getComputedStyle(document.body).getPropertyValue(token).trim()) {
            throw new Error(`The token ${token} is not defined on the page, so it cannot be the canonical value of ${property}.`);
        }
        const probe = document.createElement('div');
        probe.style.cssText = 'position: fixed; visibility: hidden; pointer-events: none;';
        const styled = property === 'offsetWidth' ? 'width' : property === 'offsetHeight' ? 'height' : property;
        probe.style[styled] = `var(${token})`;
        document.body.append(probe);
        tokens[key] = getComputedStyle(probe)[styled];
        probe.remove();
    };
    const formsOf = element => {
        const holding = {};
        for (const [name, form] of Object.entries(rules.forms)) {
            holding[name] = form.media ? matchMedia(form.media).matches : element.closest(form.closest) !== null;
        }
        return holding;
    };

    const parts = {};
    for (const part of rules.parts) {
        for (const property of part.properties) {
            for (const token of [property.token, ...property.forms.map(form => form.token)].filter(Boolean)) {
                resolveToken(property.property, token);
            }
        }
        if (part.audit) {
            parts[part.id] = null;
            continue;
        }
        const seen = new Set();
        const instances = [];
        let capped = false;
        for (const alternative of part.selectors) {
            for (const element of candidates(alternative)) {
                if (seen.has(element) || !isShown(element) || (part.filter === 'icon-only' && !isIconOnly(element))) {
                    continue;
                }
                seen.add(element);
                if (instances.length >= maxInstances) {
                    capped = true;
                } else {
                    instances.push({ element, alternative: alternative.id });
                }
            }
        }
        if (instances.length === 0) {
            parts[part.id] = { absent: true };
            continue;
        }
        const alternatives = {};
        const cells = Object.fromEntries(part.properties.map(property => [property.property, new Map()]));
        for (const { element, alternative } of instances) {
            alternatives[alternative] = (alternatives[alternative] ?? 0) + 1;
            const style = getComputedStyle(element);
            const holding = formsOf(element);
            for (const property of part.properties) {
                if (property.alts && !property.alts.includes(alternative)) {
                    continue;
                }
                if (property.ifDisplay && !property.ifDisplay.includes(style.display)) {
                    continue;
                }
                const value = read(element, style, property.property);
                const forms = property.formNames.filter(name => holding[name]);
                const key = `${value}|${forms.join(',')}`;
                const cell = cells[property.property];
                const entry = cell.get(key);
                if (entry) {
                    entry.count++;
                } else {
                    cell.set(key, { value, forms, count: 1, element: describe(element), alternative });
                }
            }
        }
        parts[part.id] = {
            absent: false,
            instances: instances.length,
            capped,
            alternatives,
            cells: Object.fromEntries(Object.entries(cells).map(([property, cell]) => [property, [...cell.values()]])),
        };
    }
    return { pointer, tokens, parts };
}

/**
 * A text outline of a surface: one line per element, with its classes, size and presentation, down to `depth` levels. For
 * writing the selectors of a rules file.
 * @param {HTMLElement} root
 * @param {{ depth: number, limit: number }} options
 * @returns {string}
 */
export function skeletonInPage(root, { depth, limit }) {
    const lines = [];
    const walk = (element, level) => {
        if (lines.length >= limit || level > depth) {
            return;
        }
        const style = getComputedStyle(element);
        if (style.display === 'none') {
            return;
        }
        const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 5) : [];
        const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
        const data = ['data-presentation', 'data-tier', 'data-sb-side-panel-id'].filter(name => element.hasAttribute(name)).map(name => `[${name}=${element.getAttribute(name)}]`).join('');
        lines.push(`${'  '.repeat(level)}${element.localName}${element.id ? `#${element.id}` : ''}${classes.map(name => `.${name}`).join('')}${data} ${element.offsetWidth ?? '?'}x${element.offsetHeight ?? '?'} "${label}"`);
        for (const child of element.children) {
            walk(child, level + 1);
        }
    };
    walk(root, 0);
    return lines.join('\n');
}

/**
 * The first element of the surface's root selector that is shown. A selector can match an element that is not shown before the
 * one that is (a second copy of the markup for another layout), and the first match is then not the surface.
 * @param {import('@playwright/test').Page} page
 * @param {string} rootSelector
 */
function shownRoot(page, rootSelector) {
    return page.locator(`${rootSelector} >> visible=true`).first();
}

/**
 * Measures a surface that is open. A rules file may give `audit`, a measurement of its own to run on the root (the settings
 * rules reuse `auditLibadwaita`): `{ part, evaluate, argument, explain, summarise }`. `explain` runs in the page and says, for each
 * record that the audit's own allow-list hides, which entry of that list hides it. `summarise(records, hiding, explained)` gives
 * `values`, the value of each property of the part, and `hidden`, the allow-list entries that hide a record (not the records: a
 * panel that fills in late would make them differ between runs).
 * @param {import('@playwright/test').Page} page
 * @param {string} rootSelector
 * @param {any} rules The rules as they apply to the surface.
 * @param {string[]} [ready] The `ready` selectors of the surface, which a part may use as an alternative.
 * @returns {Promise<ReturnType<typeof measureInPage>>}
 */
export function measureSurface(page, rootSelector, rules, ready = []) {
    const root = shownRoot(page, rootSelector);
    const prepared = prepareRules(rules);
    return quietRead(async () => {
        const measured = await page.evaluate(measureInPage, { rootSelector, rules: prepared, ready, maxInstances: MAX_INSTANCES });
        if (rules.audit?.part && rules.parts.some(part => part.id === rules.audit.part)) {
            const { evaluate, argument, explain, summarise } = rules.audit;
            const records = await root.evaluate(evaluate, argument);
            const hiding = records.filter(record => !record.pass && record.allowlisted);
            const explained = hiding.length > 0 ? await root.evaluate(explain, { records: hiding, allowlist: argument.allowlist }) : [];
            const { values, hidden } = summarise(records, hiding, explained);
            measured.parts[rules.audit.part] = {
                absent: false,
                instances: 1,
                capped: false,
                alternatives: { [rules.audit.part]: 1 },
                hidden,
                cells: Object.fromEntries(Object.entries(values).map(([property, value]) => [property, [{ value, forms: [], count: 1, element: 'audit', alternative: rules.audit.part }]])),
            };
        }
        return measured;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} rootSelector
 * @returns {Promise<string>}
 */
export function skeletonOf(page, rootSelector) {
    return shownRoot(page, rootSelector).evaluate(skeletonInPage, { depth: 6, limit: 200 });
}
