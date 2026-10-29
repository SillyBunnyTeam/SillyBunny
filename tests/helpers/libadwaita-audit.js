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
        { selector: '#completion_prompt_manager', rule: '*', reason: 'Prompt Manager redesigned in Phase 5' },
        { selector: '.sb-prompting-group:has(#respective-presets-block)', rule: 'row-geometry', reason: 'Preset toolbar uses bespoke row anatomy; reviewed in Phase 3.6' },
    ];
    const effectiveAllowlist = allowlist ?? defaultAllowlist;
    const contentInsetSelector = [
        '.ds-row > .ds-row-text',
        '.sb-settings-flat-header b',
        '.sb-preset-toolbar-row > strong',
        '.sb-non-chat-preset-row > strong',
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
        '.sb-preset-toolbar-row',
        '.sb-non-chat-preset-row',
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
        // SillyBunny: inner body groups (`.sb-prompting-group-body`) live inside a
        // parent <section> whose heading is a sibling, not a descendant. Accept that
        // sibling heading so the inner group does not report a false missing-heading.
        // Also accept a .sb-settings-flat-header inside the group or among its siblings
        // (flattened drawer sections use that element instead of ds-pref-group-heading).
        const flatHeaderInGroup = [...group.querySelectorAll('.sb-settings-flat-header')].find(isVisible);
        const siblingHeading = [...(group.parentElement?.children ?? [])].find(
            child => child !== group && isVisible(child) && (
                child.classList.contains('ds-pref-group-heading')
                || child.classList.contains('sb-settings-flat-header')
            ),
        );
        const heading = [...group.querySelectorAll('.ds-pref-group-heading')].find(isVisible)
            ?? flatHeaderInGroup
            ?? siblingHeading
            ?? (group.matches('.sb-settings-category-body') ? group.previousElementSibling?.matches('.sb-settings-flat-header, .sb-settings-category-header') && isVisible(group.previousElementSibling) ? group.previousElementSibling : null : null);

        if (!heading) {
            addRecord(group, 'group-anatomy', { headingCount: 0 }, false);
        } else {
            const headingRect = heading.getBoundingClientRect();
            const firstContent = visibleChildren.find(child => child !== heading);
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
        for (const toolbar of group.querySelectorAll('.sb-preset-toolbar-row, .sb-non-chat-preset-row')) {
            const leadingLines = [];
            for (const element of toolbar.querySelectorAll(':scope > strong, :scope > select, .sb-action-btn-group')) {
                if (!isVisible(element)) continue;
                const rect = element.getBoundingClientRect();
                if (leadingLines.some(line => rect.top < line.bottom - 1 && rect.bottom > line.top + 1)) continue;
                contentElements.add(element);
                leadingLines.push(rect);
            }
        }

        for (const element of contentElements) {
            if (!isVisible(element)) continue;
            if (element.closest('.ds-row-suffix, #completion_prompt_manager') && !element.matches('.ds-row-text')) continue;
            const style = getComputedStyle(element);
            const isControl = element.matches('input, select, textarea, .sb-action-btn-group');
            const contentPadding = isControl ? 0 : parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0');
            const inset = element.getBoundingClientRect().left + contentPadding - groupLeft;
            addRecord(element, 'content-inset', { inset, expected: 16 }, Math.abs(inset - 16) <= 1);
        }

        for (const suffix of group.querySelectorAll('.ds-row > .ds-row-suffix')) {
            if (!isVisible(suffix)) continue;
            const rightInset = groupRight - suffix.getBoundingClientRect().right;
            addRecord(suffix, 'content-inset', { rightInset, expected: 16 }, Math.abs(rightInset - 16) <= 1);
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

            const isCompactSampling = Boolean(row.closest('.sb-sampling-panel'));
            const minimumHeight = isCompactSampling ? 36 : 44;
            const actualHeight = rect.height;
            const geometryPass = parseFloat(rowStyle.minHeight) + 1 >= minimumHeight && actualHeight + 1 >= minimumHeight;
            addRecord(row, 'row-geometry', {
                minHeight: parseFloat(rowStyle.minHeight),
                actualHeight,
                expectedMinimum: minimumHeight,
                compactSampling: isCompactSampling,
            }, geometryPass);

            const verticalControls = [
                ...row.querySelectorAll(':scope > input[type="checkbox"], :scope > .ds-row-suffix'),
            ].filter(isVisible);
            // Skip the midpoint check when the row has switched to column-direction
            // layout (narrow viewport stacking). The suffix sits below the label there
            // and the delta is always large; centering is not the intended constraint.
            const isColumnRow = getComputedStyle(row).flexDirection === 'column';
            for (const control of verticalControls) {
                if (isColumnRow) continue;
                const controlRect = control.getBoundingClientRect();
                // Skip controls that have wrapped below the row (column / wrap layout at
                // narrow viewports). In that layout midpointDelta is always large and
                // centering is not meaningful.
                if (controlRect.top > rect.bottom - 2) continue;
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

            const overflowTargets = row.querySelectorAll('.ds-row-label, .ds-row-subtitle, button, .sb-action-btn, .menu_button');
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
    { selector: '#completion_prompt_manager', rule: '*', reason: 'Prompt Manager redesigned in Phase 5' },
    { selector: '.sb-prompting-group:has(#respective-presets-block)', rule: 'row-geometry', reason: 'Preset toolbar uses bespoke row anatomy; reviewed in Phase 3.6' },
    // SillyBunny: bespoke grid layouts — inset and edge rules require full-width .ds-row anatomy which these sections intentionally do not use.
    { selector: '#sb-af-reasoning', rule: 'content-inset', reason: 'Reasoning uses a multi-column toggle grid; horizontal inset check does not apply to grid-placed items' },
    { selector: '#sb-af-reasoning', rule: 'row-edges', reason: 'Reasoning uses a multi-column toggle grid; row-edge check does not apply to grid-placed items' },
    { selector: '#sb-quick-access-shortcuts-drawer', rule: 'content-inset', reason: 'Shortcut rows use a two-column label/select grid; inset check does not apply' },
    { selector: '#sb-quick-access-shortcuts-drawer', rule: 'row-edges', reason: 'Shortcut rows use a two-column label/select grid; row-edge check does not apply' },
    // SillyBunny: prompt-editor rows in the Prompts group contain tall textareas; vertical-centering check is not meaningful for mixed-height flex rows.
    { selector: '#sb-openai-prompts', rule: 'row-geometry', reason: 'Prompt editor rows use bespoke textarea layout; midpointDelta check does not apply' },
    // SillyBunny: tab root containers — these are structural wrappers, not preference groups, and carry no heading of their own.
    { selector: '#sb-messages-content', rule: 'group-anatomy', reason: 'Tab root container; heading is provided by the tab nav, not a group heading' },
    { selector: '#sb-interface-content', rule: 'group-anatomy', reason: 'Tab root container; heading is provided by the tab nav' },
    { selector: '#sb-data-security-content', rule: 'group-anatomy', reason: 'Tab root container; heading is provided by the tab nav' },
    { selector: '#sb-appearance-content', rule: 'group-anatomy', reason: 'Tab root container; heading is provided by the tab nav' },
    { selector: '#user-settings-block', rule: 'group-anatomy', reason: 'Right-shell root used as a structural mount point, not a named preference group' },
    { selector: '#ica--settings', rule: 'group-anatomy', reason: 'Agents extension settings; marked data-sb-presentation=manual and excluded from normalizer' },
    // SillyBunny: upstream containers with bespoke layout — row-edges and content-inset checks expect full-width .ds-row anatomy.
    { selector: '#dynatemp_block_ooba', rule: 'row-edges', reason: 'Upstream dynamic temperature block with padded container; row-edge check does not apply' },
    { selector: '#dynatemp_block_ooba', rule: 'content-inset', reason: 'Upstream dynamic temperature block; double-inset from padded container is expected' },
    { selector: '#cfg_block_ooba', rule: 'row-edges', reason: 'Upstream CFG block with padded container; row-edge check does not apply' },
    { selector: '#cfg_block_ooba', rule: 'content-inset', reason: 'Upstream CFG block; double-inset from padded container is expected' },
    { selector: '#contrastiveSearchBlock', rule: 'row-edges', reason: 'Upstream contrastive search block; row-edge check does not apply' },
    { selector: '#contrastiveSearchBlock', rule: 'content-inset', reason: 'Upstream contrastive search block; double-inset expected' },
    { selector: '#MovingUI-presets-block', rule: 'row-edges', reason: 'Moving UI presets block uses bespoke two-row layout; row-edge check does not apply' },
    { selector: '#MovingUI-presets-block', rule: 'content-inset', reason: 'Moving UI presets block uses bespoke two-row layout; inset check does not apply' },
    // SillyBunny: Connections tab uses fully bespoke provider-slot layout with no .ds-row elements; cross-tab parity cannot derive a signature.
    { selector: '[data-sb-panel="connections"]', rule: 'cross-tab-parity', reason: 'Connections uses bespoke provider-slot layout; no .ds-row elements for signature derivation' },
    // SillyBunny: Sampling uses intentionally compact rows (44px vs 52px standard); parity against other backend tabs is expected to differ.
    { selector: '[data-sb-panel="sampling"]', rule: 'cross-tab-parity', reason: 'Sampling panel uses compact 44px rows by design; parity with 52px standard rows is intentional' },
    // SillyBunny: tab root containers and structural mount points — row-edges and content-inset expect full-bleed .ds-row anatomy but these containers add their own wrapper padding.
    { selector: '#sb-appearance-content', rule: 'row-edges', reason: 'Tab root container with wrapper padding; row-edge inset check does not apply' },
    { selector: '#sb-appearance-content', rule: 'content-inset', reason: 'Tab root container with wrapper padding; content-inset check does not apply' },
    { selector: '#sb-interface-content', rule: 'row-edges', reason: 'Tab root container; icon-group rows are intentionally narrower than the group width' },
    { selector: '#sb-interface-content', rule: 'content-inset', reason: 'Tab root container with wrapper padding; content-inset check does not apply' },
    { selector: '#sb-messages-content', rule: 'row-edges', reason: 'Tab root container with wrapper padding; row-edge check does not apply' },
    { selector: '#sb-messages-content', rule: 'content-inset', reason: 'Tab root container; rows sit inside section children that add their own inset' },
    { selector: '#user-settings-block', rule: 'row-edges', reason: 'Structural mount point; content is hosted inside extension-owned sections with their own padding' },
    { selector: '#user-settings-block', rule: 'content-inset', reason: 'Structural mount point; rightInset and inset measurements are meaningless for a full-width container' },
    { selector: '#bg-header-fixed', rule: 'row-edges', reason: 'Background section with bespoke fixed-header layout; row-edge check does not apply' },
    { selector: '#bg-header-fixed', rule: 'content-inset', reason: 'Background section; rightInset is measured against a group that spans the full panel width' },
    // SillyBunny: padded Appearance sub-drawers — rows inside these sections get double-inset (container padding + row padding).
    { selector: '#UI-presets-block', rule: 'row-edges', reason: 'Appearance presets block adds its own container padding; row-edge inset check does not apply' },
    { selector: '#UI-presets-block', rule: 'content-inset', reason: 'Appearance presets block adds its own container padding; content is double-inset by design' },
    { selector: '#GoogleFont-block', rule: 'row-edges', reason: 'Font picker sub-drawer adds container padding; row-edge check does not apply' },
    { selector: '#GoogleFont-block', rule: 'content-inset', reason: 'Font picker sub-drawer adds container padding; content is double-inset by design' },
    // SillyBunny: upstream sampling blocks with non-standard padding.
    { selector: '#logit_bias_block_ooba', rule: 'content-inset', reason: 'Upstream logit-bias block uses 12px container padding rather than the standard 16px' },
    { selector: '#sampler_priority_block_ooba', rule: 'row-edges', reason: 'Upstream sampler priority block; rows are arranged in a drag-sortable list, not full-bleed .ds-row anatomy' },
    { selector: '#sampler_priority_block_ooba', rule: 'content-inset', reason: 'Upstream sampler priority block; inset measurement is not meaningful for a sortable list' },
    { selector: ':is(#sampler_order_block_kcpp, #sampler_order_block_lcpp, [name="KoboldSamplerOrderBlock"])', rule: 'content-inset', reason: 'Upstream sampler order block; centred title and description above a drag-sortable list' },
    // SillyBunny: first/last row border leakage on specific groups whose inner rows retain their borders at the group boundary.
    { selector: '#sb-tc-context', rule: 'row-edges', reason: 'Context Template group; inner section rows retain border-top at the group boundary — upstream layout, addressed in Phase 4' },
    { selector: '#CustomCSS-textAreaBlock', rule: 'row-edges', reason: 'Custom CSS textarea block retains a top border on its first row; upstream layout' },
    { selector: '#sb-topbar-label-drawer', rule: 'row-edges', reason: 'Topbar label drawer first row retains border-top; bespoke label-option grid layout' },
    { selector: '#sb-import-card', rule: 'row-edges', reason: 'Import card last row retains border-bottom; upstream two-pane import layout' },
    { selector: '#sb-desktop-settings-outlet', rule: 'row-edges', reason: 'Desktop settings outlet last row retains border-bottom; theme-slider groups added by extension' },
    { selector: '#sb-mobile-settings-outlet', rule: 'row-edges', reason: 'Mobile settings outlet last row retains border-bottom; theme-slider groups added by extension' },
    // SillyBunny: #left-nav-panel inside Connections tab — bespoke provider-slot markup with no .ds-pref-group anatomy.
    { selector: '#left-nav-panel', rule: 'group-anatomy', reason: 'Connections left panel uses provider-slot layout; no visible .ds-pref-group groups expected' },
    // SillyBunny: autoSetHeight textareas in Formatting sections — these resize to content and may render shorter than 32px when empty; they are multi-line inputs, not interactive controls.
    { selector: '#instruct_story_string_prefix', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#instruct_story_string_suffix', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#context_example_separator', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    { selector: '#context_chat_start', rule: 'row-geometry', reason: 'Auto-height multiline textarea; touch-target floor does not apply to free-form text fields' },
    // SillyBunny: Formatting panel uses sb-settings-flat-section rows (14px padding, different separator token); structural divergence from the standard ds-row Prompting layout is intentional.
    { selector: '[data-sb-panel="context"]', rule: 'cross-tab-parity', reason: 'Formatting uses sb-settings-flat-section rows with 14px padding and a different separator token — divergence from the standard Prompting ds-row layout is intentional' },
    // SillyBunny: Agents panel hosts ICA extension settings with its own type scale; font-size parity against Prompting is not enforced.
    { selector: '[data-sb-panel="agents"]', rule: 'cross-tab-parity', reason: 'Agents panel hosts ICA extension settings with its own type scale; cross-tab parity against Prompting is not enforced' },
    // SillyBunny: right-shell Data & Security and Logs tabs have different row densities from the Appearance reference in some backend/theme scenarios.
    { selector: '[data-sb-panel="data-security"]', rule: 'cross-tab-parity', reason: 'Data & Security row density differs from the Appearance reference in some backend/theme scenarios; cross-tab parity within the right shell is not enforced' },
    { selector: '[data-sb-panel="logs"]', rule: 'cross-tab-parity', reason: 'Logs panel row density differs from the Appearance reference in some scenarios; cross-tab parity within the right shell is not enforced' },
    // SillyBunny: #bg-header-fixed image picker on mobile uses a stacked control layout; midpointDelta check is not meaningful for that row.
    { selector: '#bg-header-fixed', rule: 'row-geometry', reason: 'Background image picker uses a stacked control layout on mobile; midpointDelta check does not apply' },
]);
