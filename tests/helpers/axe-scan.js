import AxeBuilder from '@axe-core/playwright';
import { normaliseTarget } from './axe-baseline.js';
import { AXE_GROUPS, groupOf } from './axe-report.js';

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (axe has no `wcag22a` tag): the results that gate the scan. */
export const GATED_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
/** The gated tags and the best practices, which are reported on their own and never gate. */
export const AXE_TAGS = AXE_GROUPS;

/**
 * Rules that cannot say anything about a part of the page. A scan runs inside the root of a surface, never over a whole
 * document, so a rule that judges where content sits among the landmarks of a page has nothing to report there.
 */
export const DISABLED_RULES = Object.freeze(['region']);

const ROOT_ATTRIBUTE = 'data-sb-axe-root';
/** Attributes that name an element better than its position does; the first one that the element has is part of its selector. */
const IDENTITY_ATTRIBUTES = Object.freeze(['data-avatar', 'data-id', 'data-prompt-id', 'name']);

/** A root is a Playwright selector (`:visible` is allowed), which axe's `include` cannot read, so the elements it matches are marked. */
async function markRoot(page, root) {
    const marked = await page.locator(root).evaluateAll((elements, attribute) => {
        for (const element of elements) {
            element.setAttribute(attribute, '');
        }
        return elements.length;
    }, ROOT_ATTRIBUTE);
    if (marked === 0) {
        throw new Error(`${root} matches no element to scan.`);
    }
}

const unmarkRoot = page => page.evaluate(attribute => document.querySelectorAll(`[${attribute}]`).forEach(element => element.removeAttribute(attribute)), ROOT_ATTRIBUTE).catch(() => {});

const unmarked = text => text.replaceAll(`[${ROOT_ATTRIBUTE}]`, '').replaceAll(`[${ROOT_ATTRIBUTE}=""]`, '');

/**
 * What a scan found. `violations` are the WCAG results, which gate the run; `bestPractice` are the best-practice results, which are
 * only reported, because they judge the whole document and change with what lies outside the root.
 * @typedef {object} ScanResult
 * @property {import('./axe-report.js').RunResult['violations']} violations
 * @property {import('./axe-report.js').RunResult['violations']} bestPractice
 * @property {{ id: string, nodes: number }[]} incomplete
 */

/**
 * Runs axe inside `root`, once, with each element's selector normalised for the baseline. The root must be marked already.
 * @param {import('@playwright/test').Page} page
 * @param {readonly string[]} exclude Selectors of regions that are left out of the scan.
 * @returns {Promise<ScanResult>}
 */
async function analyse(page, exclude) {
    const builder = new AxeBuilder({ page })
        .setLegacyMode()
        .include(`[${ROOT_ATTRIBUTE}]`)
        .options({ resultTypes: ['violations', 'incomplete'] })
        .withTags([...AXE_TAGS])
        .disableRules([...DISABLED_RULES]);
    for (const selector of exclude) {
        builder.exclude(selector);
    }
    const results = await builder.analyze();
    // axe names an element by the shortest selector that is unique in the whole document, so the same element is `span[title="x"]` on
    // one run and a long path on another when a copy of it exists elsewhere on the page. The baseline is keyed by a selector that
    // is built from the element and its ancestors only.
    const targets = results.violations.flatMap(violation => violation.nodes.map(node => (node.target.length === 1 && typeof node.target[0] === 'string' ? node.target[0] : '')));
    const stable = await page.evaluate(({ targets, attribute, identity }) => targets.map(target => {
        const element = target ? document.querySelector(target) : null;
        if (!element) {
            return null;
        }
        const parts = [];
        for (let node = element; node && parts.length < 5; node = node.parentElement) {
            const classes = [...node.classList].sort().filter(name => !/^(?:ui-(?:sortable|draggable|droppable|resizable|state|widget)|is[-_]|has[-_])/.test(name));
            const named = identity.find(name => node.hasAttribute(name) && node.getAttribute(name) !== '');
            parts.unshift(`${node.localName}${node.id ? `#${CSS.escape(node.id)}` : ''}${classes.map(name => `.${CSS.escape(name)}`).join('')}${named ? `[${named}="${CSS.escape(node.getAttribute(named))}"]` : ''}`);
            if (node.hasAttribute(attribute)) {
                break;
            }
        }
        return {
            selector: parts.join(' > '),
            id: element.id,
            classes: [...element.classList],
        };
    }), { targets, attribute: ROOT_ATTRIBUTE, identity: [...IDENTITY_ATTRIBUTES] });
    let position = 0;
    const toViolation = violation => ({
        id: violation.id,
        impact: violation.impact ?? null,
        group: groupOf(violation.tags),
        tags: violation.tags,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map(node => {
            const own = stable[position++];
            return {
                target: normaliseTarget(own?.selector ?? node.target.flat(Infinity).map(unmarked)),
                selector: unmarked(node.target.flat(Infinity).join(' >>> ')),
                id: own?.id ?? '',
                classes: own?.classes ?? [],
                html: node.html.replaceAll(` ${ROOT_ATTRIBUTE}=""`, '').slice(0, 240),
                failureSummary: node.failureSummary ?? '',
            };
        }),
    });
    const all = results.violations.map(toViolation);
    return {
        violations: all.filter(violation => GATED_TAGS.includes(violation.group)),
        bestPractice: all.filter(violation => !GATED_TAGS.includes(violation.group)),
        incomplete: results.incomplete.map(item => ({ id: item.id, nodes: item.nodes.length })),
    };
}

const signatureOf = found => JSON.stringify(found.violations.flatMap(violation => violation.nodes.map(node => [violation.id, node.target])).sort());

const pendingRequests = new WeakMap();
const TRACKED_TYPES = new Set(['document', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch']);

/**
 * Counts the requests of a page that have not finished, so that a scan can wait for them. Call it once per page, before the first request.
 * @param {import('@playwright/test').Page} page
 */
export function trackRequests(page) {
    const pending = new Set();
    pendingRequests.set(page, pending);
    page.on('request', request => TRACKED_TYPES.has(request.resourceType()) && pending.add(request));
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => pending.delete(request));
}

/**
 * Waits until the root has stopped changing (no element added, removed or changed under it for `quiet` ms) and the page has no request
 * in flight, or `limit` ms have passed. The root must be marked already.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} Whether the page settled; false means the limit was reached, which a page with a spinner or a poll does.
 */
async function waitForQuiet(page, { quiet = 800, limit = 5000 } = {}) {
    const started = Date.now();
    const quietInPage = page.evaluate(({ quiet, limit, attribute }) => new Promise(resolve => {
        const roots = [...document.querySelectorAll(`[${attribute}]`)];
        let timer;
        const finish = settled => {
            observer.disconnect();
            clearTimeout(timer);
            clearTimeout(cap);
            resolve(settled);
        };
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(true), quiet);
        });
        for (const root of roots) {
            observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        }
        timer = setTimeout(() => finish(true), quiet);
        const cap = setTimeout(() => finish(false), limit);
    }), { quiet, limit, attribute: ROOT_ATTRIBUTE });
    const pending = pendingRequests.get(page);
    while (pending?.size && Date.now() - started < limit) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return (await quietInPage) && !(pending?.size);
}

/**
 * Scans `root` until two scans in a row find the same violations (at most four scans), so that markup that the app upgrades while axe is
 * running (a tag chip that becomes a button, a label that a normaliser adds) is scanned in its final form. Before the first scan it
 * waits for the root to go quiet.
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @param {{ exclude?: readonly string[] }} [options]
 * @returns {Promise<ScanResult & { settled: boolean, stable: boolean }>}
 */
export async function scanStable(page, root, { exclude = [] } = {}) {
    try {
        await markRoot(page, root);
        const settled = await waitForQuiet(page);
        let found = await analyse(page, exclude);
        let stable = false;
        for (let attempt = 1; attempt < 4 && !stable; attempt++) {
            const next = await analyse(page, exclude);
            stable = signatureOf(next) === signatureOf(found);
            found = next;
        }
        return { ...found, settled, stable };
    } finally {
        await unmarkRoot(page);
    }
}
