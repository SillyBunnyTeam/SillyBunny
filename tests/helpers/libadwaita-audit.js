import { auditPromptingLayout } from './prompting-layout.js';

/**
 * Measure the shared Libadwaita settings contract for every visible preference group in a panel.
 * This function is intentionally self-contained so Playwright can serialize it into page.evaluate.
 *
 * @param {HTMLElement} root Settings panel or section to audit.
 * @param {{ allowlist?: Array<{ selector: string, rule: string, reason: string }> }} options Audit options.
 * @returns {Array<object>} Rule records with contextual metadata and measurements.
 */
export function auditLibadwaita(root, { allowlist = null } = {}) {
    if (!(root instanceof HTMLElement)) throw new TypeError('auditLibadwaita requires an HTMLElement root');

    const defaultAllowlist = [
        { selector: '#completion_prompt_manager', rule: '*', reason: 'The Prompt Manager is a list with its own markup, not a preference group' },
    ];
    const effectiveAllowlist = allowlist ?? defaultAllowlist;
    const contentInsetSelector = [
        '.ds-row > .ds-row-text',
        '.sb-settings-flat-header b',
        '.toggle-description:not(.ds-row-subtitle)',
        '.sb-prompting-row-with-help > :is(.notes, p, small)',
        '.range-block:not(.ds-row) > .justifyLeft',
        '.range-block:not(.ds-row) textarea',
        '.note-block',
        '.sb-setting-inline-copy > label',
        '.checkbox_label > input[type="radio"]',
    ].join(', ');
    const rowLikeSelector = [
        '.ds-row',
        '.ds-row-expander',
        '.sb-settings-flat-header',
        '.sb-settings-flat-section',
        '.sb-settings-row-wrapper',
        '.sb-sampling-control-card',
        '.sb-prompting-row-with-help',
        'label:has(> input[type="radio"])',
    ].join(', ');
    const isVisible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const getSelector = element => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const parent = element.parentElement;
        if (!parent) return element.tagName.toLowerCase();
        const sameTagSiblings = [...parent.children].filter(sibling => sibling.tagName === element.tagName);
        return `${getSelector(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
    };
    const getAuditContext = () => {
        const document = root.ownerDocument;
        const backend = document.querySelector('#main_api')?.value
            || document.querySelector('#chat_completion_source')?.value
            || 'all';
        const selectedTheme = document.querySelector('#themes')?.selectedOptions?.[0]?.textContent?.trim()
            || document.querySelector('#themes')?.value
            || '';
        const normalizedTheme = /libadwaita/i.test(selectedTheme)
            ? (/light/i.test(selectedTheme) ? 'libadwaita-light' : 'libadwaita-dark')
            : selectedTheme || 'unknown';
        return {
            tab: root.dataset.sbPanel || root.dataset.sbSettingsTab || root.getAttribute('data-sb-panel') || root.id || 'unknown',
            backend,
            theme: normalizedTheme,
            viewport: `${document.defaultView.innerWidth}x${document.defaultView.innerHeight}`,
        };
    };
    const isElementAllowlisted = (element, rule) => effectiveAllowlist.some(entry => {
        if (entry.rule !== '*' && entry.rule !== rule) return false;
        try {
            return element.matches(entry.selector) || Boolean(element.closest(entry.selector));
        } catch {
            return false;
        }
    });

    const context = getAuditContext(root);
    const records = [];
    const isCompactMode = root.ownerDocument.documentElement.dataset.sbCompactMode === 'true';
    const expectedInset = 12;
    const minimumHeight = isCompactMode ? 46 : 50;
    const groups = [
        ...(root.matches('.ds-pref-group') ? [root] : []),
        ...root.querySelectorAll('.ds-pref-group'),
    ].filter(isVisible);
    const addRecord = (element, rule, measured, pass) => {
        const allowlisted = isElementAllowlisted(element, rule);
        records.push({
            ...context,
            rule,
            selector: getSelector(element),
            measured,
            pass,
            allowlisted,
        });
    };

    if (!groups.length) {
        addRecord(root, 'group-anatomy', { visibleGroups: 0 }, false);
        return records;
    }

    const headingGaps = [];
    const parentGroupGaps = new Map();

    for (const group of groups) {
        const groupRect = group.getBoundingClientRect();
        const groupStyle = getComputedStyle(group);
        const groupLeft = groupRect.left + parseFloat(groupStyle.borderLeftWidth || '0');
        const groupRight = groupRect.right - parseFloat(groupStyle.borderRightWidth || '0');
        const visibleChildren = [...group.children].filter(isVisible);
        // A wrapper with `display: contents` draws no box (the Connections page gates its rows with them), so its children stand in for it.
        const boxChildren = parent => [...parent.children].flatMap(child => (getComputedStyle(child).display === 'contents' ? boxChildren(child) : [child]));
        // SillyBunny: inner body groups (`.sb-prompting-group-body`) live inside a
        // parent <section> whose heading is a sibling, not a descendant. Accept that
        // sibling heading so the inner group does not report a false missing-heading.
        // Also accept a .sb-settings-flat-header inside the group or among its siblings
        // (flattened drawer sections use that element instead of ds-pref-group-heading).
        const flatHeaderInGroup = [...group.querySelectorAll('.sb-settings-flat-header')].find(isVisible);
        const siblingHeading = [...(group.parentElement?.children ?? [])].find(
            child => child !== group && isVisible(child) && (
                child.classList.contains('ds-pref-group-heading')
                || child.classList.contains('ds-pref-group-header')
                || child.classList.contains('sb-settings-flat-header')
            ),
        );
        const heading = [...group.querySelectorAll('.ds-pref-group-heading')].find(isVisible)
            ?? flatHeaderInGroup
            ?? siblingHeading
            ?? (group.matches('.sb-settings-category-body') ? group.previousElementSibling?.matches('.sb-settings-flat-header, .sb-settings-category-header') && isVisible(group.previousElementSibling) ? group.previousElementSibling : null : null);

        if (!heading && group.getAttribute('role') === 'group' && group.getAttribute('aria-label')?.trim()) {
            // An AdwPreferencesGroup may have no title. The group then names itself for assistive technology.
            addRecord(group, 'group-anatomy', { untitled: true, name: group.getAttribute('aria-label').trim(), radius: groupStyle.borderRadius, borderColor: groupStyle.borderTopColor }, true);
        } else if (!heading) {
            addRecord(group, 'group-anatomy', { headingCount: 0 }, false);
        } else {
            const headingRect = heading.getBoundingClientRect();
            const firstContent = boxChildren(group).filter(isVisible).find(child => child !== heading);
            const headingGap = firstContent ? firstContent.getBoundingClientRect().top - headingRect.bottom : 0;
            headingGaps.push({ element: group, heading, headingGap });
            addRecord(group, 'group-anatomy', {
                heading: getSelector(heading),
                headingGap,
                headingFontSize: getComputedStyle(heading).fontSize,
                headingFontWeight: getComputedStyle(heading).fontWeight,
                headingColor: getComputedStyle(heading).color,
                radius: groupStyle.borderRadius,
                borderColor: groupStyle.borderTopColor,
            }, true);
        }

        const contentElements = new Set(group.querySelectorAll(contentInsetSelector));

        for (const element of contentElements) {
            if (!isVisible(element)) continue;
            if (element.closest('.ds-row-suffix, #completion_prompt_manager') && !element.matches('.ds-row-text')) continue;
            const style = getComputedStyle(element);
            const isControl = element.matches('input, select, textarea');
            const contentPadding = isControl ? 0 : parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0');
            const inset = element.getBoundingClientRect().left + contentPadding - groupLeft;
            addRecord(element, 'content-inset', { inset, expected: expectedInset }, Math.abs(inset - expectedInset) <= 1);
        }

        for (const suffix of group.querySelectorAll('.ds-row > .ds-row-suffix')) {
            if (!isVisible(suffix)) continue;
            const rightInset = groupRight - suffix.getBoundingClientRect().right;
            addRecord(suffix, 'content-inset', { rightInset, expected: expectedInset }, Math.abs(rightInset - expectedInset) <= 1);
        }

        const rows = [...group.querySelectorAll('.ds-row')].filter(isVisible);
        for (const row of rows) {
            const rect = row.getBoundingClientRect();
            const rowStyle = getComputedStyle(row);
            const leftInset = rect.left - groupLeft;
            const rightInset = groupRight - rect.right;
            const bottomWidth = parseFloat(rowStyle.borderBottomWidth || '0');
            const topWidth = parseFloat(rowStyle.borderTopWidth || '0');
            addRecord(row, 'row-edges', {
                leftInset,
                rightInset,
                separatorLeftInset: bottomWidth > 0 ? leftInset : null,
                separatorRightInset: bottomWidth > 0 ? rightInset : null,
                borderTopWidth: topWidth,
                borderBottomWidth: bottomWidth,
            }, Math.abs(leftInset) <= 1 && Math.abs(rightInset) <= 1);

            const actualHeight = rect.height;
            const geometryPass = parseFloat(rowStyle.minHeight) + 1 >= minimumHeight && actualHeight + 1 >= minimumHeight;
            addRecord(row, 'row-geometry', {
                minHeight: parseFloat(rowStyle.minHeight),
                actualHeight,
                expectedMinimum: minimumHeight,
                compact: isCompactMode,
            }, geometryPass);

            const verticalControls = [
                ...row.querySelectorAll(':scope > input[type="checkbox"], :scope > .ds-row-suffix'),
            ].filter(isVisible);
            // Skip the midpoint check when the row has switched to column-direction
            // layout (narrow viewport stacking). The suffix sits below the label there
            // and the delta is always large; centering is not the intended constraint.
            const isColumnRow = getComputedStyle(row).flexDirection === 'column';
            const textBottom = row.querySelector(':scope > .ds-row-text')?.getBoundingClientRect().bottom ?? Infinity;
            for (const control of verticalControls) {
                if (isColumnRow) continue;
                const controlRect = control.getBoundingClientRect();
                // Skip controls that have wrapped below the row or under its text (column / wrap
                // layout at narrow viewports: the control moves under the title when the two do not
                // fit). In that layout midpointDelta is always large and centering is not meaningful.
                if (controlRect.top > rect.bottom - 2 || controlRect.top >= textBottom - 2) continue;
                const midpointDelta = (controlRect.top + controlRect.height / 2) - (rect.top + rect.height / 2);
                addRecord(control, 'row-geometry', { midpointDelta, tolerance: 2 }, Math.abs(midpointDelta) <= 2);
            }

            if (context.viewport.startsWith('1920x')) {
                const touchTargets = row.querySelectorAll([
                    'button', '.menu_button', 'select', 'textarea',
                    'input:not([type="hidden"], [type="range"], [type="checkbox"], [type="radio"])',
                    '.ds-row-switch', '.checkbox_label',
                ].join(', '));
                for (const target of touchTargets) {
                    if (!isVisible(target)) continue;
                    const targetRect = target.getBoundingClientRect();
                    const shortestEdge = Math.min(targetRect.width, targetRect.height);
                    addRecord(target, 'row-geometry', { touchTarget: shortestEdge, minimum: 32 }, shortestEdge + 1 >= 32);
                }
            }

            if (bottomWidth > 0) {
                addRecord(row, 'row-edges', {
                    separatorLeftInset: leftInset,
                    separatorRightInset: rightInset,
                    separatorWidth: bottomWidth,
                }, Math.abs(leftInset) <= 1 && Math.abs(rightInset) <= 1);
            }

            const previous = row.previousElementSibling;
            if (previous && isVisible(previous)) {
                const previousBottom = parseFloat(getComputedStyle(previous).borderBottomWidth || '0');
                addRecord(row, 'row-edges', {
                    previousBorderBottom: previousBottom,
                    currentBorderTop: topWidth,
                }, previousBottom + topWidth <= 1);
            }

            const signatureTitle = row.querySelector('.ds-row-label') || row.querySelector('.ds-row-text');
            const separatorColor = bottomWidth > 0 ? rowStyle.borderBottomColor : topWidth > 0 ? rowStyle.borderTopColor : null;
            const signature = {
                paddingLeft: parseFloat(rowStyle.paddingLeft || '0'),
                paddingRight: parseFloat(rowStyle.paddingRight || '0'),
                minHeight: parseFloat(rowStyle.minHeight || '0'),
                gap: parseFloat(rowStyle.columnGap || rowStyle.gap || '0'),
                titleFontSize: signatureTitle ? parseFloat(getComputedStyle(signatureTitle).fontSize) : null,
                separatorColor,
            };
            addRecord(row, 'cross-tab-parity', { signature }, true);

            const rowText = row.querySelector('.ds-row-text');
            if (rowText) {
                const textNodes = [rowText, ...rowText.querySelectorAll('.ds-row-label, .ds-row-subtitle')];
                for (const textNode of textNodes) {
                    const inlineStyle = textNode.style;
                    const hasInlineTypography = Boolean(inlineStyle.fontSize || inlineStyle.color);
                    addRecord(textNode, 'typography', {
                        inlineFontSize: inlineStyle.fontSize || null,
                        inlineColor: inlineStyle.color || null,
                    }, !hasInlineTypography);
                }

                const subtitle = row.querySelector('.ds-row-subtitle');
                const hasTooltipOnlyDescription = [...rowText.querySelectorAll('[title]')]
                    .some(element => element.getAttribute('title')?.trim() && !subtitle);
                if (subtitle) {
                    const subtitleStyle = getComputedStyle(subtitle);
                    const subtitleVisible = isVisible(subtitle)
                        && Number(subtitleStyle.opacity) > 0
                        && subtitleStyle.color !== 'transparent';
                    addRecord(subtitle, 'typography', {
                        visible: isVisible(subtitle),
                        opacity: subtitleStyle.opacity,
                        color: subtitleStyle.color,
                    }, subtitleVisible);
                } else if (hasTooltipOnlyDescription) {
                    addRecord(rowText, 'typography', { titleOnlyDescription: true }, false);
                }
            }

            const overflowTargets = row.querySelectorAll('.ds-row-label, .ds-row-subtitle, button, .menu_button');
            for (const target of overflowTargets) {
                if (!isVisible(target)) continue;
                const overflow = target.scrollWidth - target.clientWidth;
                addRecord(target, 'overflow', { scrollWidth: target.scrollWidth, clientWidth: target.clientWidth, overflow }, overflow <= 0);
            }
        }

        const firstRowLike = visibleChildren.find(child => child.matches(rowLikeSelector));
        if (firstRowLike) {
            const firstBorderTop = parseFloat(getComputedStyle(firstRowLike).borderTopWidth || '0');
            addRecord(firstRowLike, 'row-edges', { firstRowBorderTop: firstBorderTop }, firstBorderTop === 0);
        }
        const lastRowLike = [...visibleChildren].reverse().find(child => child.matches(rowLikeSelector));
        if (lastRowLike) {
            const lastBorderBottom = parseFloat(getComputedStyle(lastRowLike).borderBottomWidth || '0');
            addRecord(lastRowLike, 'row-edges', { lastRowBorderBottom: lastBorderBottom }, lastBorderBottom === 0);
        }

        for (const row of rows) {
            let previous = row;
            for (let helper = row.nextElementSibling; helper?.matches('.toggle-description, .notes, p, small'); helper = helper.nextElementSibling) {
                if (!isVisible(helper)) continue;
                const previousBorderBottom = parseFloat(getComputedStyle(previous).borderBottomWidth || '0');
                const helperBorderTop = parseFloat(getComputedStyle(helper).borderTopWidth || '0');
                addRecord(helper, 'row-edges', { previousBorderBottom, helperBorderTop }, previousBorderBottom === 0 && helperBorderTop === 0);
                previous = helper;
            }
        }

        const checkboxes = group.querySelectorAll('input[type="checkbox"]');
        for (const checkbox of checkboxes) {
            if (!isVisible(checkbox)) continue;
            const hasLabel = Boolean(checkbox.closest('.checkbox_label'));
            const hasSwitchRole = checkbox.getAttribute('role') === 'switch';
            addRecord(checkbox, 'controls', { checkboxLabel: hasLabel, switchRole: hasSwitchRole }, hasLabel || hasSwitchRole);
        }

        for (const legacy of group.querySelectorAll('.inline-drawer, .sb-admin-card, .sb-server-card')) {
            if (isVisible(legacy)) addRecord(legacy, 'controls', { legacyChrome: legacy.className }, false);
        }

        const groupControls = group.querySelectorAll('input[type="checkbox"], .inline-drawer, .sb-admin-card, .sb-server-card');
        if (!groupControls.length) addRecord(group, 'controls', { checkboxCount: 0, legacyChromeCount: 0 }, true);

        for (const label of group.querySelectorAll('.ds-row-label')) {
            if (!isVisible(label)) continue;
            for (const textNode of [label, ...label.querySelectorAll('*')]) {
                const inlineStyle = textNode.style;
                if (!inlineStyle.fontSize && !inlineStyle.color) continue;
                addRecord(textNode, 'typography', {
                    inlineFontSize: inlineStyle.fontSize || null,
                    inlineColor: inlineStyle.color || null,
                }, false);
            }
        }

    }

    const groupsByParent = new Map();
    for (const group of groups) {
        const siblings = groupsByParent.get(group.parentElement) || [];
        siblings.push(group);
        groupsByParent.set(group.parentElement, siblings);
    }
    for (const siblings of groupsByParent.values()) {
        siblings.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
        for (let index = 1; index < siblings.length; index++) {
            const previousGroup = siblings[index - 1];
            const currentGroup = siblings[index];
            const gap = currentGroup.getBoundingClientRect().top - previousGroup.getBoundingClientRect().bottom;
            const gapsForParent = parentGroupGaps.get(currentGroup.parentElement) || [];
            gapsForParent.push({ element: currentGroup, gap });
            parentGroupGaps.set(currentGroup.parentElement, gapsForParent);
        }
    }

    for (const { heading, headingGap } of headingGaps) {
        // SillyBunny: use the first *non-negative* gap as the reference. A negative gap
        // means the first content element starts before the heading bottom (collapsed /
        // overlapping layout), which is a bespoke composition not representative of the
        // standard heading-then-content pattern. Using a negative as the reference would
        // cause every normally-spaced group to fail the comparison.
        const referenceGap = (headingGaps.find(({ headingGap: g }) => g >= 0)?.headingGap) ?? headingGap;
        addRecord(heading, 'group-anatomy', { headingGap, referenceGap }, Math.abs(headingGap - referenceGap) <= 1);
    }

    for (const gaps of parentGroupGaps.values()) {
        const referenceGap = gaps[0]?.gap ?? 0;
        for (const { element, gap } of gaps) {
            addRecord(element, 'group-anatomy', { groupGap: gap, referenceGap }, Math.abs(gap - referenceGap) <= 1);
        }
    }

    for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
        if (!isVisible(checkbox) || checkbox.closest('.ds-pref-group')) continue;
        addRecord(checkbox, 'controls', {
            checkboxLabel: Boolean(checkbox.closest('.checkbox_label')),
            switchRole: checkbox.getAttribute('role') === 'switch',
            outsidePreferenceGroup: true,
        }, Boolean(checkbox.closest('.checkbox_label')) || checkbox.getAttribute('role') === 'switch');
    }

    return records;
}

/** Backward-compatible entry point for existing Prompting layout checks. */
export { auditPromptingLayout };

export const LIBADWAITA_AUDIT_ALLOWLIST = Object.freeze([
    // SillyBunny: the settings parity spec never renders these elements (the Prompt Manager, and parts of the page that only some backends or modes show), so no measurement says whether they still need an exemption.
    { selector: '#completion_prompt_manager', rule: '*', reason: 'The Prompt Manager is a list with its own markup, not a preference group' },
    { selector: '#sb-openai-prompts', rule: 'row-geometry', reason: 'Prompt editor rows use bespoke textarea layout; midpointDelta check does not apply' },
    { selector: '#ica--settings', rule: 'group-anatomy', reason: 'Agents extension settings; marked data-sb-presentation=manual and excluded from normalizer' },
    { selector: '#sb-tc-context', rule: 'row-edges', reason: 'Context Template group; inner section rows retain border-top at the group boundary' },
    // SillyBunny: autoSetHeight textareas in Formatting sections resize to content and may render shorter than 32px when empty; they are multi-line inputs, not interactive controls.
    { selector: '#instruct_story_string_prefix', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#instruct_story_string_suffix', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#context_example_separator', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#context_chat_start', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    // SillyBunny: the Editor and Agents pages are list editors; they hold no preference group, and the Agents page opens on a list of entity rows.
    { selector: '[data-sb-panel="editor"]', rule: 'group-anatomy', reason: 'A list editor page holds no preference group; the groups of the old Editor layout stay hidden while the prompt editor owns the page' },
    { selector: '[data-sb-panel="agents"]', rule: 'group-anatomy', reason: 'A list editor page holds no preference group; its settings pages open inside the editor pane' },
    { selector: '[data-sb-panel="agents"]', rule: 'cross-tab-parity', reason: 'The Agents page opens on a list of entity rows, so it has no preference row to take a signature from' },
    // SillyBunny: panels that the manual cross-tab sweep compares; the settings parity spec does not measure this rule.
    { selector: '[data-sb-panel="context"]', rule: 'cross-tab-parity', reason: 'Formatting uses sb-settings-flat-section rows with 14px padding and a different separator token; divergence from the standard Prompting ds-row layout is intentional' },
    { selector: '[data-sb-panel="logs"]', rule: 'cross-tab-parity', reason: 'Logs panel row density differs from the Appearance reference in some scenarios; cross-tab parity within the right shell is not enforced' },
    // SillyBunny: measured exceptions, each narrowed to the element that fails.
    { selector: '.ds-row--spin > .ds-row-suffix', rule: 'content-inset', reason: 'The buttons of a spin row draw inside the row (right inset 5px at 390px), and their hit area reaches out through the negative margin of the suffix' },
    { selector: '.sb-subpage-row > .ds-row-text', rule: 'content-inset', reason: 'A subpage row leads with an icon, so its text starts after the icon (38px) and not at the row inset' },
    { selector: '#user-settings-utility-actions', rule: 'content-inset', reason: 'The suffix of the utility-actions row sits 32px from the group edge at 390px, not 12px' },
    { selector: '#sb-slider-mode', rule: 'content-inset', reason: 'The mode switch of the slider row sits 43px from the group edge at 390px, not 12px' },
    { selector: '#bpt-animated-bg-panel', rule: 'group-anatomy', reason: 'The animated-background panel comes from an extension that draws its own header, with a 12px gap to the first row where the settings groups use 6px' },
    { selector: '#bpt-animated-bg-panel', rule: 'row-edges', reason: 'The animated-background panel comes from an extension whose last row keeps its bottom border' },
    { selector: '#sb-background-settings-controls', rule: 'row-edges', reason: 'The last row of the background controls keeps its bottom border because the controls after it are shown or hidden by script' },
    { selector: '#sb-interface-content', rule: 'row-edges', reason: 'The last visible switch row of one Interface category keeps its bottom border; rows after it are hidden by script, so :last-child cannot remove the separator' },
    { selector: '#sb-openai-request', rule: 'row-edges', reason: 'Backend source rules hide sibling rows with inline display, so the first or last visible row keeps a separator that :first-child and :last-child cannot remove' },
]);
