/**
 * Shared helpers for cloning inert HTML `<template>` blocks (with backwards-compatible
 * fallback for legacy `<div class="template_element">` containers in tests or extensions).
 */

/**
 * Resolves the root node (`.content` DocumentFragment for `<template>`, or the element itself)
 * for a template container by ID.
 *
 * @param {string} templateId Element ID with or without leading `#`.
 * @param {Document} [doc=globalThis.document] Document to query.
 * @returns {DocumentFragment|Element|null}
 */
export function getTemplateRoot(templateId, doc = globalThis.document) {
    if (!doc || typeof doc.getElementById !== 'function') {
        return null;
    }

    const cleanId = String(templateId ?? '').replace(/^#/, '');
    if (!cleanId) {
        return null;
    }

    const host = doc.getElementById(cleanId);
    if (!host) {
        return null;
    }

    if (host.tagName === 'TEMPLATE' && host.content) {
        return host.content;
    }

    return host;
}

/**
 * Queries a single element inside a `<template>` (via `.content`) or container element.
 *
 * @param {string} templateId Element ID with or without leading `#`.
 * @param {string} [selector] Optional CSS selector inside the template.
 * @param {Document} [doc=globalThis.document] Document to query.
 * @returns {Element|null}
 */
export function queryTemplateElement(templateId, selector = '', doc = globalThis.document) {
    const root = getTemplateRoot(templateId, doc);
    if (!root || typeof root.querySelector !== 'function') {
        return null;
    }

    return selector ? root.querySelector(selector) : root.firstElementChild;
}

/**
 * Returns a freshly cloned DOM element adopted into `doc` from a `<template>` or container.
 *
 * @param {string} templateId Element ID with or without leading `#`.
 * @param {string} [selector] Optional CSS selector inside the template.
 * @param {Document} [doc=globalThis.document] Document to query and adopt into.
 * @returns {Element|null}
 */
export function cloneTemplateNode(templateId, selector = '', doc = globalThis.document) {
    const element = queryTemplateElement(templateId, selector, doc);
    if (!element) {
        return null;
    }

    if (typeof doc?.importNode === 'function') {
        return /** @type {Element} */ (doc.importNode(element, true));
    }

    return /** @type {Element} */ (element.cloneNode(true));
}

/**
 * Returns a cloned jQuery collection for a template element.
 *
 * @param {string} templateId Element ID with or without leading `#`.
 * @param {string} [selector] Optional CSS selector inside the template.
 * @param {Document} [doc=globalThis.document] Document to query.
 * @returns {JQuery<HTMLElement>}
 */
export function cloneTemplate(templateId, selector = '', doc = globalThis.document) {
    const dollar = globalThis.$;
    const cloned = cloneTemplateNode(templateId, selector, doc);

    if (typeof dollar !== 'function') {
        return /** @type {any} */ (cloned);
    }

    return cloned ? dollar(cloned) : dollar();
}

/**
 * Returns an adopted jQuery prototype collection suitable for caching and repeated `.clone()` calls.
 *
 * @param {string} templateId Element ID with or without leading `#`.
 * @param {string} [selector] Optional CSS selector inside the template.
 * @param {Document} [doc=globalThis.document] Document to query.
 * @returns {JQuery<HTMLElement>}
 */
export function getTemplateJQuery(templateId, selector = '', doc = globalThis.document) {
    return cloneTemplate(templateId, selector, doc);
}
