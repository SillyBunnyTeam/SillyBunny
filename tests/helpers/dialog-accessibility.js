import { mkdirSync } from 'node:fs';
import { expect } from '@playwright/test';

/** Set to a directory to keep the screenshots the accessibility spec takes; unset, none are written. */
const SHOT_DIRECTORY = process.env.SILLYBUNNY_A11Y_SHOTS;
if (SHOT_DIRECTORY) mkdirSync(SHOT_DIRECTORY, { recursive: true });

export async function a11yShot(page, name) {
    if (!SHOT_DIRECTORY) return;
    await page.screenshot({ path: `${SHOT_DIRECTORY}/${name}.png` });
}

/**
 * Computed styles read right after a focus or media change can still be the start value of a CSS
 * transition. Wait for the transitions that are running, so the values are the resting ones.
 */
export async function settleTransitions(page) {
    await page.evaluate(() => Promise.all(
        document.getAnimations()
            .filter(animation => animation instanceof window.CSSTransition)
            .map(animation => animation.finished.catch(() => {})),
    ));
}

/**
 * Installs `window.sbA11y`, the in-page probes the spec reads. They live in the page because the answers
 * are computed styles and layout boxes. Call it again after every navigation.
 */
export async function installProbes(page) {
    await page.evaluate(() => {
        const alphaOf = colour => {
            const slash = colour.match(/\/\s*([\d.]+%?)\s*\)$/);
            if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
            const legacy = colour.match(/^rgba\(([^)]+)\)$/);
            if (legacy) {
                const parts = legacy[1].split(',');
                return parts.length > 3 ? parseFloat(parts[3]) : 1;
            }
            return colour === 'transparent' ? 0 : 1;
        };
        const isVisible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const nameOf = element => {
            const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
            const label = (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
            return `${element.tagName.toLowerCase()}${className ? `.${className}` : ''}[${label}]`;
        };
        const topVisible = selector => [...document.querySelectorAll(selector)].filter(isVisible).at(-1) ?? null;
        const outlineShown = style => style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && alphaOf(style.outlineColor) > 0;
        const borderShown = style => ['Top', 'Right', 'Bottom', 'Left'].some(side => {
            const borderStyle = style[`border${side}Style`];
            return borderStyle !== 'none' && borderStyle !== 'hidden' && parseFloat(style[`border${side}Width`]) > 0 && alphaOf(style[`border${side}Color`]) > 0;
        });
        const backdropOf = element => {
            for (let node = element.parentElement; node; node = node.parentElement) {
                const colour = getComputedStyle(node).backgroundColor;
                if (alphaOf(colour) > 0) return colour;
            }
            return getComputedStyle(document.documentElement).backgroundColor;
        };

        // A word that spans two line boxes was cut in the middle; a hyphen or slash is a legal break.
        const brokenWords = element => {
            const found = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                for (const match of text.textContent.matchAll(/[^\s\-/\u2013\u2014]+/g)) {
                    const range = document.createRange();
                    range.setStart(text, match.index);
                    range.setEnd(text, match.index + match[0].length);
                    if (range.getClientRects().length > 1) found.push(match[0]);
                }
            }
            return found;
        };

        const CONTROLS = 'button, [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"]';
        const LABELS = 'button, label, summary, legend, h1, h2, h3, h4, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"], .ds-row-label, .ds-row-subtitle, .sb-dialog__title, .sb-dialog__subtitle';
        const HEADER_GROUPS = '.sb-dialog__header, .sb-side-panel__header, .sb-selection-action-bar, .popup-controls, .sb-dialog__responses, .sb-action-sheet-header';
        const GROUP_MEMBERS = 'button, [role="button"], .sb-dialog__title, .sb-dialog__subtitle, .sb-dialog__heading, .sb-dialog__search-entry, h2';
        const RESPONSES = '[data-response], .sb-dialog__response, .popup-controls [role="button"], .popup-controls button, .sb-dialog__close, .sb-dialog__back, .sb-side-panel__header button, .sb-action-sheet-close';

        const seenStops = [];
        window.sbA11y = {
            alphaOf,
            focusState(rootSelector) {
                const element = document.activeElement;
                if (!element || element === document.body || element === document.documentElement) return { kind: 'document', id: -1 };
                if (!seenStops.includes(element)) seenStops.push(element);
                // A segmented control hides its radio at opacity 0 and draws the ring on the next sibling.
                const segment = element.matches('.sb-boolean-radio-option > input') ? element.nextElementSibling : null;
                const style = getComputedStyle(segment ?? element);
                return {
                    kind: 'element',
                    id: seenStops.indexOf(element),
                    label: nameOf(element),
                    inside: Boolean(element.closest(rootSelector)),
                    outline: outlineShown(style),
                    shadow: style.boxShadow !== 'none',
                    // A shadow ring is a zero-blur inset shadow. An outline beside it makes two rings.
                    insetRing: /0px 0px 0px [\d.]+px inset/.test(style.boxShadow),
                    outlineOnFill: outlineShown(style) && style.outlineColor === style.backgroundColor,
                    outlineDetail: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
                    shadowDetail: style.boxShadow.slice(0, 60),
                    fillDetail: style.backgroundColor,
                };
            },
            /** Frame boundary, control boundaries and fills, transparent text: what forced colours can lose. */
            forcedColours(rootSelector, frameSelector) {
                const root = topVisible(rootSelector);
                const frame = frameSelector ? topVisible(frameSelector) : root;
                const report = { frame: [], controls: [], selected: [], text: [] };
                const frameStyle = getComputedStyle(frame);
                if (!outlineShown(frameStyle) && !borderShown(frameStyle)) {
                    report.frame.push(`${nameOf(frame)} border ${frameStyle.borderTopStyle} ${frameStyle.borderTopWidth} ${frameStyle.borderTopColor}`);
                }
                for (const input of root.querySelectorAll(CONTROLS)) {
                    if (!isVisible(input) || input.closest('[inert]')) continue;
                    // A segmented control hides its radio at opacity 0 and draws the segment in the next sibling.
                    const control = getComputedStyle(input).opacity === '0' ? input.nextElementSibling : input;
                    if (!control) continue;
                    const style = getComputedStyle(control);
                    const filled = alphaOf(style.backgroundColor) > 0 && style.backgroundColor !== backdropOf(control);
                    if (!outlineShown(style) && !borderShown(style) && !filled) {
                        report.controls.push(`${nameOf(control)} bg ${style.backgroundColor} border ${style.borderTopStyle} ${style.borderTopWidth}`);
                    }
                }
                for (const group of root.querySelectorAll('.sb-boolean-radio-group')) {
                    const segments = [...group.querySelectorAll('.sb-boolean-radio-option > input + span')].filter(isVisible);
                    const selected = segments.find(segment => segment.previousElementSibling.checked);
                    const other = segments.find(segment => !segment.previousElementSibling.checked);
                    if (!selected || !other) continue;
                    const look = segment => `${getComputedStyle(segment).backgroundColor} ${getComputedStyle(segment).color}`;
                    if (look(selected) === look(other)) report.selected.push(`${nameOf(selected)} looks the same as ${nameOf(other)}: ${look(selected)}`);
                }
                for (const element of root.querySelectorAll('*')) {
                    if (!isVisible(element)) continue;
                    if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
                    const style = getComputedStyle(element);
                    if (alphaOf(style.color) === 0 || alphaOf(style.webkitTextFillColor) === 0) {
                        report.text.push(`${nameOf(element)} color ${style.color} fill ${style.webkitTextFillColor}`);
                    }
                }
                return report;
            },
            /** The selection-mode round checks: a boundary at rest, and a distinct fill and glyph when checked. */
            selectionChecks(rootSelector) {
                const root = topVisible(rootSelector);
                return [...root.querySelectorAll('.sb-selection-check')].filter(isVisible).map(check => {
                    const style = getComputedStyle(check);
                    const glyph = getComputedStyle(check, '::before');
                    return {
                        checked: check.checked,
                        boundary: borderShown(style) || outlineShown(style),
                        fill: style.backgroundColor,
                        border: style.borderTopColor,
                        glyphContent: glyph.content,
                        glyphFill: glyph.backgroundColor,
                    };
                });
            },
            /** What a 200% text size can break: clipped labels, overlapping header controls, hidden responses. */
            scale(rootSelector, ellipsizing) {
                const root = topVisible(rootSelector);
                const frame = root.getBoundingClientRect();
                const report = { clipped: [], overlaps: [], responses: [], insideViewport: true, responseCount: 0 };
                report.insideViewport = frame.left >= -0.5 && frame.right <= innerWidth + 0.5 && frame.top >= -0.5 && frame.bottom <= innerHeight + 0.5;
                for (const node of root.querySelectorAll(LABELS)) {
                    if (!isVisible(node) || node.clientWidth <= 1 || node.closest('[inert]')) continue;
                    if (ellipsizing.some(selector => node.matches(selector))) continue;
                    const style = getComputedStyle(node);
                    // Overflow that stays visible is not clipped: an icon glyph can overhang its box by a few pixels.
                    const clippedAcross = style.overflowX !== 'visible' && node.scrollWidth > node.clientWidth + 1;
                    const clippedDown = node.scrollHeight > node.clientHeight + 1;
                    if (clippedAcross || clippedDown) {
                        report.clipped.push(`${nameOf(node)} ${node.scrollWidth}x${node.scrollHeight} in ${node.clientWidth}x${node.clientHeight}`);
                    }
                    const broken = brokenWords(node);
                    if (broken.length > 0) report.clipped.push(`${nameOf(node)} breaks ${broken.join(', ')} across lines`);
                }
                report.clipped = [...new Set(report.clipped)];
                for (const group of root.querySelectorAll(HEADER_GROUPS)) {
                    if (!isVisible(group) || group.closest('[inert]')) continue;
                    const members = [...group.querySelectorAll(GROUP_MEMBERS)].filter(isVisible)
                        .map(node => ({ node, rect: node.getBoundingClientRect() }));
                    for (let first = 0; first < members.length; first++) {
                        for (let second = first + 1; second < members.length; second++) {
                            const a = members[first];
                            const b = members[second];
                            if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
                            const across = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
                            const down = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
                            if (across > 1 && down > 1) report.overlaps.push(`${nameOf(a.node)} x ${nameOf(b.node)}`);
                        }
                    }
                }
                for (const response of root.querySelectorAll(RESPONSES)) {
                    if (!isVisible(response) || response.closest('[inert]')) continue;
                    report.responseCount++;
                    const box = response.getBoundingClientRect();
                    const shown = box.width > 0 && box.height > 0
                        && box.left >= frame.left - 1 && box.right <= frame.right + 1
                        && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1
                        && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
                    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                    const reachable = hit !== null && (response.contains(hit) || hit.contains(response));
                    if (!shown || !reachable) report.responses.push(`${nameOf(response)} ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
                }
                return report;
            },
            /** Scrolls every overflowing scroller to its end, then checks its last visible content is shown and not covered. */
            lastContent(rootSelector) {
                const root = topVisible(rootSelector);
                const frame = root.getBoundingClientRect();
                const problems = [];
                const scrollers = [root, ...root.querySelectorAll('*')].filter(node => {
                    if (!isVisible(node) || node.closest('[inert]')) return false;
                    const { overflowY } = getComputedStyle(node);
                    return (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1;
                });
                for (const scroller of scrollers) {
                    scroller.style.scrollBehavior = 'auto';
                    scroller.scrollTop = scroller.scrollHeight;
                    let last = scroller;
                    for (;;) {
                        const candidates = [...last.children].filter(child => isVisible(child) && getComputedStyle(child).position !== 'absolute');
                        if (candidates.length === 0) break;
                        last = candidates.at(-1);
                    }
                    const box = last.getBoundingClientRect();
                    const limit = Math.min(scroller.getBoundingClientRect().bottom, frame.bottom, innerHeight);
                    const hit = document.elementFromPoint(box.left + box.width / 2, Math.min(box.top + box.height / 2, limit - 1));
                    const covered = hit === null || !(last.contains(hit) || hit.contains(last));
                    if (box.bottom > limit + 1 || covered) {
                        problems.push(`${nameOf(scroller)} ends at ${Math.round(box.bottom)} of ${Math.round(limit)}, covered ${covered}`);
                    }
                }
                return { scrollers: scrollers.length, problems };
            },
        };
    });
}

/**
 * Presses Tab (or Shift+Tab) until the focus has come back to where it started, or `limit` presses
 * passed. Each stop is a `sbA11y.focusState`; `kind: 'document'` is the focus leaving the page for the
 * browser's own controls, which is where a modal's cycle wraps. With `untilOutside` it stops at the
 * first element outside the root instead, for a surface that does not hold the focus.
 */
export async function walkTabOrder(page, rootSelector, { backwards = false, limit = 80, untilOutside = false } = {}) {
    const key = backwards ? 'Shift+Tab' : 'Tab';
    const stops = [];
    for (let press = 0; press < limit; press++) {
        await page.keyboard.press(key);
        await settleTransitions(page);
        const stop = await page.evaluate(selector => window.sbA11y.focusState(selector), rootSelector);
        if (stops.length > 0 && stop.id === stops[0].id) return { stops, wrapped: true, leftRoot: false };
        stops.push(stop);
        if (untilOutside && stop.kind === 'element' && !stop.inside) return { stops, wrapped: false, leftRoot: true };
    }
    return { stops, wrapped: false, leftRoot: false };
}

/** Presses Tab (or Shift+Tab) until the focus is on an element that matches `selector`. */
export async function tabUntil(page, selector, { backwards = false, limit = 40 } = {}) {
    for (let press = 0; press < limit; press++) {
        await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
        if (await page.evaluate(match => document.activeElement?.matches(match) ?? false, selector)) return;
    }
    throw new Error(`Tab did not reach ${selector} within ${limit} presses`);
}

/**
 * Moves the focus onto `control` with the keyboard and checks that it shows one focus ring: an outline or the
 * shared inset shadow ring, never both. Two rings mean a rule drew its own outline on a control that the
 * shared ring also covers.
 */
export async function expectSingleFocusRing(page, control) {
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    await settleTransitions(page);
    const ring = await control.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
            shadow: /0px 0px 0px [\d.]+px inset/.test(style.boxShadow),
            detail: `outline ${style.outlineStyle} ${style.outlineWidth}, shadow ${style.boxShadow.slice(0, 70)}`,
        };
    });
    expect(ring.outline || ring.shadow, `a focus ring (${ring.detail})`).toBe(true);
    expect(ring.outline && ring.shadow, `one ring, not two (${ring.detail})`).toBe(false);
}
