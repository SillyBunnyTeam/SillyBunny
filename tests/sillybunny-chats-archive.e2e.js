/* global getComputedStyle, innerHeight, innerWidth */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'public',
    'scripts',
    'extensions',
    'sillybunny-chats-archive',
);
const publicRoot = path.resolve(extensionRoot, '..', '..', '..');

let baseUrl;
let server;

const ARCHIVE_CURSOR = 'a'.repeat(64);
const ORPHAN_CURSOR = 'b'.repeat(64);
const FIRST_READ_TOKEN = 'c'.repeat(64);
const SECOND_READ_TOKEN = 'd'.repeat(64);
const FIRST_ORPHAN_HASH = 'e'.repeat(64);
const SECOND_ORPHAN_HASH = 'f'.repeat(64);
const SEARCH_CONTENT_DEBOUNCE_MS = 600;

test.describe.configure({ mode: 'serial' });
test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
});

test.beforeAll(async () => {
    server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/') {
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end(fixtureHtml(url.searchParams.has('long'), url.searchParams.has('duplicate-characters')));
                return;
            }
            const asset = url.pathname.startsWith('/extension/')
                ? { root: extensionRoot, relativePath: url.pathname.slice('/extension/'.length) }
                : url.pathname.startsWith('/public/')
                    ? { root: publicRoot, relativePath: url.pathname.slice('/public/'.length) }
                    : null;
            if (!asset) {
                response.statusCode = 404;
                response.end();
                return;
            }

            const filePath = path.resolve(asset.root, asset.relativePath);
            if (path.relative(asset.root, filePath).startsWith('..')) {
                response.statusCode = 403;
                response.end();
                return;
            }
            response.setHeader('Content-Type', path.extname(filePath) === '.css'
                ? 'text/css; charset=utf-8'
                : 'text/javascript; charset=utf-8');
            response.end(await fs.readFile(filePath));
        } catch {
            response.statusCode = 500;
            response.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('shows a resilient label with at least a 44px mobile touch target', async ({ page }) => {
    await page.goto(`${baseUrl}/?long`);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');

    const control = await page.locator('#sbca_drawer_button').evaluate(button => {
        const label = button.querySelector('.sbca-drawer-button-label');
        const buttonStyle = getComputedStyle(button);
        const labelStyle = getComputedStyle(label);
        const buttonRect = button.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        return {
            ariaLabel: button.getAttribute('aria-label'),
            buttonHeight: buttonRect.height,
            buttonWidth: buttonRect.width,
            buttonFits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
            buttonVisibility: buttonStyle.visibility,
            labelDisplay: labelStyle.display,
            labelHeight: labelRect.height,
            labelText: label.textContent,
            labelWidth: labelRect.width,
            labelFits: label.scrollWidth <= label.clientWidth,
        };
    });

    expect(control.labelText).toBe('Chat Archive Chat Archive Chat Archive Chat Archive');
    expect(control.ariaLabel).toBe(control.labelText);
    expect(control.buttonVisibility).toBe('visible');
    expect(control.labelDisplay).not.toBe('none');
    expect(control.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(control.buttonWidth).toBeGreaterThan(control.buttonHeight);
    expect(control.labelWidth).toBeGreaterThan(0);
    expect(control.labelHeight).toBeGreaterThan(0);
    expect(control.buttonFits).toBe(true);
    expect(control.labelFits).toBe(true);
});

test('owns the popup frame spacing and keeps mobile controls inside the viewport', async ({ page }) => {
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('a-long-chat-name-that-must-wrap-without-widening-the-popup'),
    ], null, null, 1)));

    await openArchive(page);
    await expect(page.locator('.sbca-saved-view')).toBeHidden();
    const filters = page.locator('.sbca-filter-toggle');
    const filterPanel = page.locator('.sbca-options-panel');
    await expect(filters).toBeVisible();
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(filterPanel).toBeHidden();
    const filterTarget = await filters.evaluate(control => {
        const rect = control.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
    });
    expect(filterTarget.height).toBeGreaterThanOrEqual(44);
    expect(filterTarget.width).toBeGreaterThanOrEqual(44);
    const viewTargets = await page.locator('.sbca-view-setting select:visible').evaluateAll(selects => selects.map(select => {
        const rect = select.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
    }));
    expect(viewTargets.length).toBeGreaterThan(0);
    for (const target of viewTargets) {
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.width).toBeGreaterThanOrEqual(44);
    }
    await filters.click();
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await expect(filterPanel).toBeVisible();
    const mobileControls = await page.locator('.sbca-root').evaluate(root => {
        const browse = root.querySelector('.sbca-browse-strip');
        const viewSettings = [...browse.querySelectorAll('.sbca-view-setting:not([hidden])')];
        const viewRects = viewSettings.map(setting => setting.getBoundingClientRect());
        const kinds = root.querySelector('.sbca-kinds');
        const kindRects = [...kinds.querySelectorAll('.sbca-kind-pill')].map(pill => pill.getBoundingClientRect());
        const refresh = root.querySelector('.sbca-archive-actions > .sbca-control');
        const filters = root.querySelector('.sbca-filter-toggle');
        const options = root.querySelector('.sbca-options-panel');
        const secondary = root.querySelector('.sbca-archive-secondary-actions');
        const orphanActions = root.querySelector('.sbca-orphan-actions');
        const orphanFilter = orphanActions.querySelector('.sbca-orphan-filter');
        const orphanSelect = orphanFilter.querySelector('select');
        const orphanScan = orphanActions.querySelector('.sbca-control');
        const organizationToggle = root.querySelector('.sbca-organization-toggle');
        const browseStyle = getComputedStyle(browse);
        const secondaryStyle = getComputedStyle(secondary);
        const orphanActionsRect = orphanActions.getBoundingClientRect();
        const orphanFilterRect = orphanFilter.getBoundingClientRect();
        const orphanSelectRect = orphanSelect.getBoundingClientRect();
        const orphanScanRect = orphanScan.getBoundingClientRect();
        const organizationRect = organizationToggle.getBoundingClientRect();
        return {
            browseGap: viewRects[1].left - viewRects[0].right,
            browseSeparatedFromRefresh: browse.getBoundingClientRect().top > refresh.getBoundingClientRect().bottom
                && parseFloat(browseStyle.borderBlockStartWidth) > 0,
            equalViewWidths: Math.abs(viewRects[0].width - viewRects[1].width) <= 1,
            filtersSeparatedFromSecondary: secondary.getBoundingClientRect().top > Math.max(
                filters.getBoundingClientRect().bottom,
                options.getBoundingClientRect().bottom,
            )
                && parseFloat(secondaryStyle.borderBlockStartWidth) > 0,
            kindRowCount: new Set(kindRects.map(rect => Math.round(rect.top))).size,
            kindsFit: kinds.scrollWidth <= kinds.clientWidth,
            kindTargetsFit: kindRects.every(rect => rect.width >= 44 && rect.height >= 44),
            orphanControlsOrdered: orphanSelectRect.bottom <= orphanScanRect.top
                && orphanScanRect.bottom <= organizationRect.top,
            orphanControlsFullWidth: Math.abs(orphanFilterRect.left - orphanActionsRect.left) <= 0.5
                && Math.abs(orphanFilterRect.right - orphanActionsRect.right) <= 0.5
                && Math.abs(orphanScanRect.left - orphanActionsRect.left) <= 0.5
                && Math.abs(orphanScanRect.right - orphanActionsRect.right) <= 0.5,
            orphanControlsFit: orphanActions.scrollWidth <= orphanActions.clientWidth
                && secondary.scrollWidth <= secondary.clientWidth,
        };
    });
    expect(mobileControls.browseGap).toBeGreaterThanOrEqual(8);
    expect(mobileControls.browseSeparatedFromRefresh).toBe(true);
    expect(mobileControls.equalViewWidths).toBe(true);
    expect(mobileControls.filtersSeparatedFromSecondary).toBe(true);
    expect(mobileControls.kindRowCount).toBe(2);
    expect(mobileControls.kindsFit).toBe(true);
    expect(mobileControls.kindTargetsFit).toBe(true);
    expect(mobileControls.orphanControlsOrdered).toBe(true);
    expect(mobileControls.orphanControlsFullWidth).toBe(true);
    expect(mobileControls.orphanControlsFit).toBe(true);
    const frame = await page.locator('.sbca-dialog').evaluate(dialog => {
        const body = dialog.querySelector('.popup-body');
        const content = dialog.querySelector('.popup-content');
        const root = dialog.querySelector('.sbca-root');
        const controls = dialog.querySelector('.popup-controls');
        const close = dialog.querySelector('.popup-button-close');
        const dialogStyle = getComputedStyle(dialog);
        const bodyStyle = getComputedStyle(body);
        const contentStyle = getComputedStyle(content);
        const rootStyle = getComputedStyle(root);
        const dialogRect = dialog.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        const controlsRect = controls.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        return {
            bodyPaddingBottom: parseFloat(bodyStyle.paddingBottom),
            bodyPaddingLeft: parseFloat(bodyStyle.paddingLeft),
            bodyPaddingRight: parseFloat(bodyStyle.paddingRight),
            bodyPaddingTop: parseFloat(bodyStyle.paddingTop),
            closeHeight: closeRect.height,
            closeRight: dialogRect.right - closeRect.right,
            closeTop: closeRect.top - dialogRect.top,
            closeWidth: closeRect.width,
            contentMarginTop: contentStyle.marginTop,
            contentPaddingLeft: contentStyle.paddingLeft,
            controlsInsideBody: controlsRect.bottom <= bodyRect.bottom + 0.5,
            dialogPadding: dialogStyle.padding,
            rootGap: rootStyle.gap,
            rootInsideBody: rootRect.left >= bodyRect.left && rootRect.right <= bodyRect.right,
            rootNoHorizontalOverflow: root.scrollWidth <= root.clientWidth,
            viewportFit: dialogRect.left >= 0 && dialogRect.right <= innerWidth,
        };
    });

    expect(frame.dialogPadding).toBe('0px');
    expect(frame.contentMarginTop).toBe('0px');
    expect(frame.contentPaddingLeft).toBe('0px');
    expect(frame.rootGap).toBe('16px');
    expect(frame.bodyPaddingTop).toBeGreaterThanOrEqual(12);
    expect(frame.bodyPaddingRight).toBeGreaterThanOrEqual(12);
    expect(frame.bodyPaddingBottom).toBeGreaterThanOrEqual(8);
    expect(frame.bodyPaddingLeft).toBeGreaterThanOrEqual(12);
    expect(frame.closeHeight).toBeGreaterThanOrEqual(44);
    expect(frame.closeWidth).toBeGreaterThanOrEqual(44);
    expect(frame.closeTop).toBeGreaterThanOrEqual(4);
    expect(frame.closeRight).toBeGreaterThanOrEqual(4);
    expect(frame.controlsInsideBody).toBe(true);
    expect(frame.rootInsideBody).toBe(true);
    expect(frame.rootNoHorizontalOverflow).toBe(true);
    expect(frame.viewportFit).toBe(true);
});

test('keeps a balanced master-detail workspace on desktop', async ({ page }) => {
    let releaseExport;
    const organizationUploads = [];
    const exportGate = new Promise(resolve => { releaseExport = resolve; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeOrganization(page, {
        version: 1,
        lastView: {},
        views: [{
            id: 'breakpoint-view',
            name: 'Breakpoint saved view',
            view: {},
        }],
        folders: [{ id: 'folder-one', name: 'Folder one' }],
        collections: [
            { id: 'collection-one', name: 'Collection one' },
            { id: 'collection-two', name: 'Collection two' },
            { id: 'collection-three', name: 'Collection three' },
        ],
        chats: {
            '["character","Alice","desktop-chat"]': {
                collections: ['collection-one', 'collection-two'],
            },
        },
    });
    await page.route('**/api/files/upload', async route => {
        const body = route.request().postDataJSON();
        organizationUploads.push(JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
        await fulfillJson(route, { path: body.name });
    });
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('desktop-chat'),
    ], null, null, 1)));
    await page.route('**/api/chats/export', async route => {
        await exportGate;
        await fulfillJson(route, {
            result: [
                JSON.stringify({ chat_metadata: { source: 'desktop' } }),
                JSON.stringify({ name: 'Alice', mes: 'desktop message' }),
            ].join('\n'),
        });
    });

    await openArchive(page);
    await page.getByText('desktop-chat', { exact: true }).click();
    await expect(page.locator('.sbca-viewer-content')).toContainText('Loading chat...');
    const loadingOrder = await page.locator('.sbca-viewer-content').evaluate(content => (
        [...content.children].map(child => child.className)
    ));
    expect(loadingOrder).toEqual(['sbca-organizer', 'sbca-viewer-details']);
    releaseExport();
    await expect(page.locator('.sbca-viewer-content')).toContainText('desktop message');
    const layout = await page.locator('.sbca-dialog').evaluate(dialog => {
        const root = dialog.querySelector('.sbca-root');
        const list = dialog.querySelector('.sbca-list-panel');
        const viewer = dialog.querySelector('.sbca-viewer');
        const search = dialog.querySelector('.sbca-search input');
        const ownerSummary = dialog.querySelector('.sbca-owner-summary');
        const sortPill = dialog.querySelector('.sbca-sortpill');
        const refresh = dialog.querySelector('.sbca-archive-actions > .sbca-control:first-child');
        const orphanActions = dialog.querySelector('.sbca-orphan-actions');
        const orphanReason = orphanActions.querySelector('select');
        const scan = orphanActions.querySelector('.sbca-control');
        const organizationToggle = dialog.querySelector('.sbca-organization-toggle');
        const kindPills = [...dialog.querySelectorAll('.sbca-kind-pill')];
        const viewerContent = dialog.querySelector('.sbca-viewer-content');
        const viewerDetails = dialog.querySelector('.sbca-viewer-details');
        const organizer = dialog.querySelector('.sbca-organizer');
        const organizerFolder = organizer.querySelector('.sbca-organizer-folder');
        const dialogRect = dialog.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        const searchRect = search.getBoundingClientRect();
        const refreshRect = refresh.getBoundingClientRect();
        const archiveActionsRect = refresh.parentElement.getBoundingClientRect();
        const orphanActionsRect = orphanActions.getBoundingClientRect();
        const orphanReasonRect = orphanReason.getBoundingClientRect();
        const scanRect = scan.getBoundingClientRect();
        const ownerSummaryRect = ownerSummary.getBoundingClientRect();
        const sortPillRect = sortPill.getBoundingClientRect();
        const detailsRect = viewerDetails.getBoundingClientRect();
        const organizerRect = organizer.getBoundingClientRect();
        const collections = organizer.querySelector('.sbca-organizer-collections');
        const tags = organizer.querySelector('.sbca-organizer-tags');
        const folderRect = organizerFolder.getBoundingClientRect();
        const collectionsRect = collections.getBoundingClientRect();
        const tagsRect = tags.getBoundingClientRect();
        const folderStyle = getComputedStyle(organizerFolder);
        const collectionsStyle = getComputedStyle(collections);
        const tagsStyle = getComputedStyle(tags);
        const sectionTitleStyles = [...organizer.querySelectorAll('.sbca-organizer-section-title')]
            .map(title => getComputedStyle(title))
            .map(style => ({ fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight }));
        const viewerActions = [...dialog.querySelectorAll('.sbca-viewer-actions .sbca-action')];
        const actionLabels = viewerActions.map(action => action.textContent.trim());
        const openIndex = actionLabels.indexOf('Open chat');
        const favoriteIndex = actionLabels.indexOf('Favorite');
        return {
            clearFiltersCount: dialog.querySelectorAll('.sbca-clear-filters').length,
            detailOrder: [...viewerContent.children].map(child => child.className),
            contentInset: rootRect.left - dialogRect.left,
            hasManualMessageSearch: [...dialog.querySelectorAll('button')]
                .some(control => control.textContent.trim() === 'Search message content'),
            kindPillTargets: kindPills.map(pill => {
                const rect = pill.getBoundingClientRect();
                return { height: rect.height, width: rect.width };
            }),
            listToolsAligned: Math.abs(ownerSummaryRect.top - sortPillRect.top) <= 0.5
                && Math.abs(ownerSummaryRect.height - sortPillRect.height) <= 2,
            orphanControlsAligned: Math.abs(orphanReasonRect.bottom - scanRect.bottom) <= 0.5,
            orphanTargets: [orphanReasonRect, scanRect].map(rect => ({ height: rect.height, width: rect.width })),
            orphanControlsBesideOrganization: Math.abs(orphanActionsRect.top - organizationToggle.getBoundingClientRect().top) <= 0.5
                && orphanActionsRect.right <= organizationToggle.getBoundingClientRect().left,
            organizationIndicator: getComputedStyle(organizationToggle, '::after').content,
            refreshAtStart: Math.abs(refreshRect.left - archiveActionsRect.left) <= 0.5,
            searchIsFullWidth: searchRect.width > 800,
            detailsRadius: parseFloat(getComputedStyle(viewerDetails).borderRadius),
            dialogHeightRatio: dialogRect.height / innerHeight,
            dialogWidthRatio: dialogRect.width / innerWidth,
            listRadius: parseFloat(getComputedStyle(list).borderRadius),
            listWidth: listRect.width,
            noHorizontalOverflow: root.scrollWidth <= root.clientWidth,
            organizerBeforeInformation: organizerRect.bottom <= detailsRect.top,
            favoriteActionFollowsOpen: favoriteIndex === openIndex + 1,
            organizerHasPillSections: parseFloat(folderStyle.borderTopWidth) > 0
                && parseFloat(collectionsStyle.borderTopWidth) > 0
                && parseFloat(tagsStyle.borderTopWidth) > 0
                && parseFloat(folderStyle.borderRadius) > 0
                && parseFloat(collectionsStyle.borderRadius) > 0
                && parseFloat(tagsStyle.borderRadius) > 0,
            organizerUsesColumns: Math.abs(folderRect.top - collectionsRect.top) <= 0.5
                && Math.abs(collectionsRect.top - tagsRect.top) <= 0.5
                && folderRect.right <= collectionsRect.left
                && collectionsRect.right <= tagsRect.left,
            sectionTitleStyles,
            viewerRadius: parseFloat(getComputedStyle(viewer).borderRadius),
            viewerStartsAfterList: viewerRect.left > listRect.right,
            viewerWidth: viewerRect.width,
        };
    });

    expect(layout.dialogWidthRatio).toBeGreaterThan(0.9);
    expect(layout.dialogWidthRatio).toBeLessThanOrEqual(0.95);
    expect(layout.dialogHeightRatio).toBeGreaterThan(0.85);
    expect(layout.dialogHeightRatio).toBeLessThanOrEqual(0.93);
    expect(layout.contentInset).toBeGreaterThanOrEqual(16);
    expect(layout.contentInset).toBeLessThanOrEqual(18);
    expect(layout.searchIsFullWidth).toBe(true);
    expect(layout.listToolsAligned).toBe(true);
    expect(layout.clearFiltersCount).toBe(0);
    expect(layout.hasManualMessageSearch).toBe(false);
    expect(layout.refreshAtStart).toBe(true);
    expect(layout.orphanControlsBesideOrganization).toBe(true);
    expect(layout.orphanControlsAligned).toBe(true);
    for (const target of layout.orphanTargets) {
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.width).toBeGreaterThanOrEqual(44);
    }
    expect(layout.organizationIndicator).toContain('+');
    expect(layout.kindPillTargets).toHaveLength(4);
    for (const target of layout.kindPillTargets) {
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.width).toBeGreaterThanOrEqual(44);
    }
    expect(layout.listRadius).toBeGreaterThan(0);
    expect(layout.viewerRadius).toBeGreaterThan(0);
    expect(layout.viewerStartsAfterList).toBe(true);
    expect(layout.viewerWidth).toBeGreaterThan(layout.listWidth);
    expect(layout.detailOrder).toEqual(['sbca-viewer-actions', 'sbca-organizer', 'sbca-viewer-details']);
    expect(layout.detailsRadius).toBeGreaterThan(0);
    expect(layout.organizerBeforeInformation).toBe(true);
    expect(layout.favoriteActionFollowsOpen).toBe(true);
    expect(layout.organizerUsesColumns).toBe(true);
    expect(layout.organizerHasPillSections).toBe(true);
    expect(layout.sectionTitleStyles).toHaveLength(3);
    expect(new Set(layout.sectionTitleStyles.map(style => JSON.stringify(style))).size).toBe(1);
    expect(layout.noHorizontalOverflow).toBe(true);
    const favoriteAction = page.locator('.sbca-favorite-action');
    await expect(page.locator('.sbca-organizer .sbca-favorite-toggle')).toHaveCount(0);
    await expect(favoriteAction).toHaveAttribute('aria-pressed', 'false');
    await favoriteAction.click();
    await expect(favoriteAction).toHaveAttribute('aria-pressed', 'true');
    await expect(favoriteAction).toContainText('Favorite');
    const favoriteFilter = page.locator('.sbca-favorite-filter');
    await expect(favoriteFilter).toContainText('Favorites');
    await favoriteFilter.click();
    await expect(favoriteFilter.locator('input')).not.toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveCount(0);
    await favoriteFilter.click();
    await expect(favoriteFilter.locator('input')).toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText('desktop-chat');
    await favoriteAction.click();
    await expect(favoriteAction).toHaveAttribute('aria-pressed', 'false');
    await expect(favoriteAction).toContainText('Favorite');
    await expect(page.locator('.sbca-organizer-folder')).toHaveAttribute('role', 'group');
    await expect(page.locator('.sbca-organizer-folder')).toHaveAttribute('aria-labelledby', /.+/);
    await expect(page.locator('.sbca-organizer-collections')).toHaveAttribute('role', 'group');
    await expect(page.locator('.sbca-organizer-collections')).toHaveAttribute('aria-labelledby', /.+/);
    await expect(page.locator('.sbca-organizer-tags')).toHaveAttribute('role', 'group');
    await expect(page.locator('.sbca-organizer-tags')).toHaveAttribute('aria-labelledby', /.+/);
    const folderSelect = page.locator('.sbca-organizer-folder select');
    await expect(folderSelect).toBeEnabled();
    await expect(folderSelect.locator('option')).toHaveText(['Unfiled', 'Folder one']);
    await folderSelect.selectOption('folder-one');
    await expect.poll(() => organizationUploads.at(-1)?.chats?.['["character","Alice","desktop-chat"]']?.folder)
        .toBe('folder-one');
    const collectionSelect = page.locator('.sbca-organizer-collections select');
    await expect(collectionSelect).toBeEnabled();
    await expect(collectionSelect.locator('option')).toHaveText([
        'Collections',
        'Collection one',
        'Collection two',
        'Collection three',
    ]);
    await expect(page.locator('.sbca-collection-item .sbca-tag-text')).toHaveText(['Collection one', 'Collection two']);
    await expect(page.locator('.sbca-collection-item button').first()).toHaveAccessibleName('Remove collection Collection one');
    await collectionSelect.selectOption('collection-three');
    await expect.poll(() => organizationUploads.at(-1)?.chats?.['["character","Alice","desktop-chat"]']?.collections)
        .toEqual(['collection-one', 'collection-two', 'collection-three']);
});

test('keeps desktop filters visible and organization management full width when requested', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeOrganization(page, {
        version: 1,
        lastView: {},
        views: [],
        folders: [],
        collections: [],
        chats: {
            '["character","Alice","favorite-chat"]': { favorite: true },
        },
    });
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('favorite-chat'),
        linkedRow('ordinary-chat'),
    ], null, null, 2)));

    await openArchive(page);
    await expect(page.getByText('Sort', { exact: true })).toHaveCount(0);
    await expect(page.getByText('List tools', { exact: true })).toHaveCount(0);
    await expect(page.locator('.sbca-filter-toggle')).toBeHidden();
    await expect(page.locator('.sbca-options-panel')).toBeVisible();
    const filterLayout = await page.locator('.sbca-filter-tools').evaluate(filterTools => {
        const panel = filterTools.querySelector('.sbca-options-panel');
        const browse = filterTools.querySelector('.sbca-browse-strip');
        const actions = filterTools.querySelector('.sbca-archive-actions');
        const refresh = actions.querySelector('.sbca-control');
        const orphanActions = filterTools.querySelector('.sbca-orphan-actions');
        const orphanReason = orphanActions.querySelector('select');
        const scan = orphanActions.querySelector('.sbca-control');
        const controls = [...panel.children].filter(control => control.matches('.sbca-kinds, .sbca-filter'));
        const panelRect = panel.getBoundingClientRect();
        const browseRect = browse.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        const refreshRect = refresh.getBoundingClientRect();
        const orphanActionsRect = orphanActions.getBoundingClientRect();
        const orphanReasonRect = orphanReason.getBoundingClientRect();
        const scanRect = scan.getBoundingClientRect();
        return {
            browseAndActionsShareRow: Math.abs(browseRect.top - actionsRect.top) <= 0.5
                && browseRect.bottom <= actionsRect.bottom + 0.5,
            controlsBelowActionRow: panelRect.top > Math.max(browseRect.bottom, actionsRect.bottom),
            orphanControlsShareRow: Math.abs(orphanReasonRect.bottom - scanRect.bottom) <= 0.5,
            orphanControlsInActionRow: orphanActionsRect.top >= actionsRect.top
                && orphanActionsRect.bottom <= actionsRect.bottom,
            refreshAtStart: Math.abs(refreshRect.left - actionsRect.left) <= 0.5,
            controls: controls.map(control => {
                const label = control.querySelector('.sbca-label, legend');
                const field = control.querySelector('input[type="date"], select');
                const rect = control.getBoundingClientRect();
                return {
                    fieldFits: !field || field.scrollWidth <= field.clientWidth,
                    labelFits: label.scrollWidth <= label.clientWidth,
                    bottom: rect.bottom,
                    width: rect.width,
                };
            }),
            columnCount: getComputedStyle(panel).gridTemplateColumns.split(' ').length,
            panelWidth: panelRect.width,
            panelSingleRow: controls.every(control => Math.abs(control.getBoundingClientRect().bottom - controls[0].getBoundingClientRect().bottom) <= 0.5),
        };
    });
    expect(filterLayout.browseAndActionsShareRow).toBe(true);
    expect(filterLayout.controlsBelowActionRow).toBe(true);
    expect(filterLayout.orphanControlsShareRow).toBe(true);
    expect(filterLayout.orphanControlsInActionRow).toBe(true);
    expect(filterLayout.refreshAtStart).toBe(true);
    expect(filterLayout.controls).toHaveLength(3);
    expect(filterLayout.columnCount).toBe(3);
    expect(filterLayout.panelSingleRow).toBe(true);
    expect(filterLayout.panelWidth).toBeGreaterThan(800);
    for (const control of filterLayout.controls) {
        expect(control.width).toBeGreaterThan(100);
        expect(control.labelFits).toBe(true);
        expect(control.fieldFits).toBe(true);
    }
    const favoritePill = page.locator('.sbca-favorite-filter');
    const favoriteFilter = favoritePill.locator('input');
    await expect(favoriteFilter).toBeChecked();
    const favoriteInputStyle = await favoriteFilter.evaluate(input => {
        const style = getComputedStyle(input);
        return {
            appearance: style.appearance,
            opacity: style.opacity,
            pseudoContent: getComputedStyle(input.closest('.sbca-favorite-filter'), '::after').content,
        };
    });
    expect(favoriteInputStyle.appearance).toBe('none');
    expect(favoriteInputStyle.opacity).toBe('0');
    expect(favoriteInputStyle.pseudoContent).toBe('none');
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-chat', 'ordinary-chat']);
    await expect(page.locator('.sbca-status')).not.toContainText('Use Find orphaned files to include chats with deleted owners.');
    await favoritePill.click();
    await expect(favoriteFilter).not.toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText(['ordinary-chat']);
    await favoritePill.click();
    await expect(favoriteFilter).toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-chat', 'ordinary-chat']);

    const characterPill = page.locator('.sbca-kind-pill').filter({ hasText: 'Characters' });
    await characterPill.click();
    await expect(characterPill.locator('input')).not.toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-chat']);
    await favoritePill.click();
    await expect(page.locator('.sbca-filename')).toHaveCount(0);
    await favoritePill.click();
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-chat']);
    await characterPill.click();
    await expect(characterPill.locator('input')).toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-chat', 'ordinary-chat']);
    await page.getByText('Manage organization', { exact: true }).click();
    await expect(page.locator('.sbca-options-panel')).toBeHidden();

    const layout = await page.locator('.sbca-toolbar').evaluate(toolbar => {
        const root = toolbar.closest('.sbca-root');
        const panel = toolbar.querySelector('.sbca-organization-tools-panel');
        const row = root.querySelector('.sbca-row-button');
        const toolbarStyle = getComputedStyle(toolbar);
        const panelRect = panel.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        return {
            organizationVisible: !panel.hidden,
            panelWidth: panelRect.width,
            rowBorderWidth: parseFloat(getComputedStyle(row).borderTopWidth),
            rowRadius: parseFloat(getComputedStyle(row).borderRadius),
            toolbarWidth: toolbarRect.width,
            toolbarOverflowY: toolbarStyle.overflowY,
            toolbarMaxBlockSize: toolbarStyle.maxBlockSize,
            rootScrollHeight: root.scrollHeight,
            rootClientHeight: root.clientHeight,
        };
    });

    expect(layout.organizationVisible).toBe(true);
    expect(layout.panelWidth).toBeGreaterThan(layout.toolbarWidth * 0.9);
    expect(layout.rowBorderWidth).toBeGreaterThan(0);
    expect(layout.rowRadius).toBeGreaterThan(0);
    expect(layout.toolbarOverflowY).not.toBe('auto');
    expect(layout.toolbarMaxBlockSize).toBe('none');
    expect(layout.rootScrollHeight).toBeGreaterThanOrEqual(layout.rootClientHeight);
    await page.setViewportSize({ width: 820, height: 740 });
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('.sbca-organization-tools-panel')).toBeVisible();
    await expect(page.locator('.sbca-options-panel')).toBeHidden();
    await page.getByText('Manage organization', { exact: true }).click();
    await expect(page.locator('.sbca-options-panel')).toBeVisible();
});

test('keeps organization load recovery contextual to Manage organization', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ status: 503 }));
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('organization-error-chat'),
    ], null, null, 1)));

    await openArchive(page);
    const recoveryMessage = page.getByText('Organization could not be loaded. Retry or import a backup.');
    await expect(recoveryMessage).toBeHidden();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeHidden();
    await page.getByRole('button', { name: 'Manage organization' }).click();
    await expect(page.locator('.sbca-organization-backup')).toContainText('Organization could not be loaded. Retry or import a backup.');
    await expect(page.locator('.sbca-organization-backup').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(recoveryMessage).toBeVisible();
    await expect(recoveryMessage).toHaveCount(1);
});

test('synchronizes the viewer Favorite action after organization loads', async ({ page }) => {
    let releaseOrganization;
    const organizationGate = new Promise(resolve => { releaseOrganization = resolve; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/user/files/_sbca_organization.json', async route => {
        await organizationGate;
        const organization = {
            version: 1,
            lastView: {},
            views: [],
            folders: [],
            collections: [],
            chats: {
                '["character","Alice","delayed-organization-chat"]': { favorite: true },
            },
        };
        await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: Buffer.from(JSON.stringify(organization)).toString('base64'),
        });
    });
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('delayed-organization-chat'),
    ], null, null, 1)));
    await page.route('**/api/chats/export', route => fulfillJson(route, {
        result: JSON.stringify({ chat_metadata: {} }),
    }));

    await openArchive(page);
    await page.getByText('delayed-organization-chat', { exact: true }).click();
    const favoriteAction = page.locator('.sbca-favorite-action');
    await expect(favoriteAction).toBeDisabled();
    await expect(favoriteAction).toHaveAttribute('aria-pressed', 'false');
    const favoriteFilter = page.locator('.sbca-favorite-filter');
    const favoriteFilterInput = favoriteFilter.locator('input');
    await expect(favoriteFilterInput).toBeEnabled();
    await favoriteFilter.click();
    await expect(favoriteFilterInput).not.toBeChecked();
    await expect(page.locator('.sbca-filename', { hasText: 'delayed-organization-chat' })).toBeVisible();
    releaseOrganization();
    await expect(page.locator('.sbca-filename', { hasText: 'delayed-organization-chat' })).toHaveCount(0);
    await favoriteFilter.click();
    await expect(favoriteFilterInput).toBeChecked();
    await expect(page.locator('.sbca-filename', { hasText: 'delayed-organization-chat' })).toBeVisible();
    await expect(favoriteAction).toBeEnabled();
    await expect(favoriteAction).toHaveAttribute('aria-pressed', 'true');
    await expect(favoriteAction).toHaveAccessibleName('Favorite');
});

test('preserves focus and organizer geometry across the desktop-mobile breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await routeOrganization(page, {
        version: 1,
        lastView: {},
        views: [{
            id: 'breakpoint-view',
            name: 'Breakpoint saved view',
            view: {},
        }],
        folders: [],
        collections: [{ id: 'long-collection', name: 'an-extremely-long-unbroken-collection-name-that-must-wrap-without-widening-the-organizer' }],
        chats: {
            '["character","Alice","breakpoint-chat"]': {
                collections: ['long-collection'],
                tags: ['an-extremely-long-unbroken-tag-that-must-wrap-without-widening-the-organizer-at-the-breakpoint'],
            },
        },
    });
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('breakpoint-chat'),
    ], null, null, 1)));
    await page.route('**/api/chats/export', route => fulfillJson(route, {
        result: JSON.stringify({ chat_metadata: {} }),
    }));

    await openArchive(page);
    const dateFilter = page.locator('.sbca-options-panel input[type="date"]').first();
    await dateFilter.focus();
    await page.setViewportSize({ width: 820, height: 740 });
    await expect(page.locator('.sbca-filter-toggle')).toBeFocused();
    await expect(page.locator('.sbca-options-panel')).toBeHidden();

    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('.sbca-options-panel input, .sbca-options-panel select, .sbca-options-panel button').first()).toBeFocused();
    await expect(page.locator('.sbca-options-panel')).toBeVisible();

    await page.setViewportSize({ width: 1001, height: 800 });
    await page.locator('.sbca-row-button').evaluate(button => button.click());
    await expect(page.locator('.sbca-viewer-content')).toContainText('Organize chat');
    const geometry = await page.locator('.sbca-dialog').evaluate(dialog => {
        const organizer = dialog.querySelector('.sbca-organizer');
        const viewer = dialog.querySelector('.sbca-viewer');
        const archiveActions = dialog.querySelector('.sbca-archive-actions');
        const secondaryActions = dialog.querySelector('.sbca-archive-secondary-actions');
        const orphanActions = dialog.querySelector('.sbca-orphan-actions');
        const organizationToggle = dialog.querySelector('.sbca-organization-toggle');
        const archiveRect = archiveActions.getBoundingClientRect();
        const secondaryRect = secondaryActions.getBoundingClientRect();
        const orphanRect = orphanActions.getBoundingClientRect();
        const organizationRect = organizationToggle.getBoundingClientRect();
        return {
            actionClusterFits: secondaryActions.scrollWidth <= secondaryActions.clientWidth,
            actionClusterIsAdjacent: Math.abs(orphanRect.top - organizationRect.top) <= 0.5
                && orphanRect.right <= organizationRect.left,
            actionRowsDoNotIntersect: archiveRect.right <= secondaryRect.left,
            actionClusterVisible: secondaryRect.width > 0,
            organizerFits: organizer.scrollWidth <= organizer.clientWidth,
            toolbarFits: dialog.querySelector('.sbca-toolbar').scrollWidth <= dialog.querySelector('.sbca-toolbar').clientWidth,
            viewerFits: viewer.scrollWidth <= viewer.clientWidth,
        };
    });
    expect(geometry.actionClusterFits).toBe(true);
    expect(geometry.actionClusterIsAdjacent).toBe(true);
    expect(geometry.actionRowsDoNotIntersect).toBe(true);
    expect(geometry.actionClusterVisible).toBe(true);
    expect(geometry.organizerFits).toBe(true);
    expect(geometry.toolbarFits).toBe(true);
    expect(geometry.viewerFits).toBe(true);
});

test('shows saved views only when available and applies the selected view', async ({ page }) => {
    let searchRequests = 0;
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeOrganization(page, {
        version: 1,
        lastView: {},
        views: [{
            id: 'compact-by-owner',
            name: 'Compact by owner',
            view: { density: 'compact', group: 'owner', query: 'saved query' },
        }, {
            id: 'favorite-only',
            name: 'Favorite',
            view: { favorite: true },
        }, {
            id: 'not-favorite',
            name: 'Not favorite',
            view: { favorite: false },
        }],
        folders: [],
        collections: [],
        chats: {
            '["character","Alice","favorite-saved-view-chat"]': { favorite: true },
        },
    });
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('favorite-saved-view-chat'),
        linkedRow('ordinary-saved-view-chat'),
    ], null, null, 2)));
    await page.route('**/api/chats/search', route => {
        searchRequests++;
        return fulfillJson(route, []);
    });

    await openArchive(page);
    const savedView = page.locator('.sbca-saved-view select');
    await expect(savedView).toBeVisible();
    await expect(savedView.locator('option')).toHaveText(['Current view', 'Compact by owner', 'Favorite', 'Not favorite']);
    await savedView.selectOption('compact-by-owner');
    await expect(page.locator('.sbca-root')).toHaveAttribute('data-sbca-density', 'compact');
    await expect(page.locator('.sbca-view-setting:not(.sbca-saved-view) select').first()).toHaveValue('owner');
    await expect(page.getByRole('combobox', { name: 'Search indexed chats' })).toHaveValue('saved query');
    await expect.poll(() => searchRequests).toBe(1);
    await savedView.selectOption('favorite-only');
    const favoriteFilter = page.locator('.sbca-favorite-filter');
    await expect(favoriteFilter.locator('input')).toBeChecked();
    expect(await favoriteFilter.locator('input').evaluate(input => input.indeterminate)).toBe(false);
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-saved-view-chat', 'ordinary-saved-view-chat']);
    await savedView.selectOption('not-favorite');
    await expect(favoriteFilter).toContainText('Favorites');
    await expect(favoriteFilter.locator('input')).not.toBeChecked();
    expect(await favoriteFilter.locator('input').evaluate(input => input.indeterminate)).toBe(false);
    await expect(page.locator('.sbca-filename')).toHaveText(['ordinary-saved-view-chat']);
    await favoriteFilter.click();
    await expect(favoriteFilter).toContainText('Favorites');
    await expect(favoriteFilter.locator('input')).toBeChecked();
    await expect(page.locator('.sbca-filename')).toHaveText(['favorite-saved-view-chat', 'ordinary-saved-view-chat']);
});

test('keeps the tablet and Safari popup layout bounded', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 740 });
    await page.goto(baseUrl);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');
    await page.locator('body').evaluate(body => body.classList.add('safari'));
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('tablet-chat'),
    ], null, null, 1)));

    await page.locator('#sbca_drawer_button').click();
    await expect(page.locator('.sbca-root')).toBeVisible();
    const layout = await page.locator('.sbca-dialog').evaluate(dialog => {
        const body = dialog.querySelector('.popup-body');
        const root = dialog.querySelector('.sbca-root');
        const dialogRect = dialog.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        return {
            bodyHeight: bodyRect.height,
            dialogHeight: dialogRect.height,
            rootInsideBody: rootRect.left >= bodyRect.left && rootRect.right <= bodyRect.right,
            rootNoHorizontalOverflow: root.scrollWidth <= root.clientWidth,
            viewportFit: dialogRect.top >= 0 && dialogRect.bottom <= innerHeight,
        };
    });

    expect(layout.dialogHeight).toBeLessThanOrEqual(740);
    expect(layout.bodyHeight).toBeLessThanOrEqual(layout.dialogHeight);
    expect(layout.rootInsideBody).toBe(true);
    expect(layout.rootNoHorizontalOverflow).toBe(true);
    expect(layout.viewportFit).toBe(true);
});

test('renders the first archive page and progress before the next page resolves', async ({ page }) => {
    let inventoryRequests = 0;
    let searchRequests = 0;
    let releaseSecondPage;
    let markSecondPageStarted;
    const secondPageStarted = new Promise(resolve => { markSecondPageStarted = resolve; });
    const secondPageGate = new Promise(resolve => { releaseSecondPage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', async route => {
        inventoryRequests++;
        if (inventoryRequests === 1) {
            await fulfillJson(route, archivePage([linkedRow('first')], ARCHIVE_CURSOR, null, 2));
            return;
        }
        markSecondPageStarted();
        await secondPageGate;
        await fulfillJson(route, archivePage([linkedRow('second')], null, null, 2));
    });
    await page.route('**/api/chats/search', route => {
        searchRequests++;
        return fulfillJson(route, []);
    });

    await openArchive(page);
    await secondPageStarted;

    await expect(page.locator('.sbca-filename')).toHaveText(['first']);
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect(page.getByText('second', { exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Search indexed chats' }).fill('second');
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(0);

    releaseSecondPage();
    await expect(page.locator('.sbca-filename')).toHaveText(['second']);
    await expect.poll(() => searchRequests).toBe(1);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});

test('automatically combines indexed metadata and message-content search results', async ({ page }) => {
    let inventoryRequests = 0;
    let searchRequests = 0;
    let releaseStaleSearch;
    let markStaleSearchStarted;
    const staleSearchStarted = new Promise(resolve => { markStaleSearchStarted = resolve; });
    const staleSearchGate = new Promise(resolve => { releaseStaleSearch = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', route => {
        inventoryRequests++;
        if (inventoryRequests > 1) {
            return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'refresh failed' }) });
        }
        return fulfillJson(route, archivePage([
            linkedRow('needle-metadata'),
            linkedRow('unrelated'),
        ], null, null, 2));
    });
    await page.route('**/api/chats/search', async route => {
        searchRequests++;
        if (route.request().postDataJSON().query === 'stale') {
            markStaleSearchStarted();
            await staleSearchGate;
            await fulfillJson(route, [{
                file_name: 'stale-content-match',
                file_size: '2 KB',
                message_count: 1,
                last_mes: 1_000,
                preview_message: 'stale result',
            }]);
            return;
        }
        expect(route.request().postDataJSON()).toMatchObject({
            avatar_url: 'Alice.png',
            query: 'needle',
        });
        await fulfillJson(route, [{
            file_name: 'content-match',
            file_size: '2 KB',
            message_count: 4,
            last_mes: 2_000,
            preview_message: 'needle appears in an older message',
        }]);
    });

    await openArchive(page);
    await expect(page.getByRole('button', { name: 'Search message content' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);

    const search = page.getByRole('combobox', { name: 'Search indexed chats' });
    await search.fill('stale');
    await staleSearchStarted;
    await search.fill('needle');
    await expect(page.locator('.sbca-filename')).toHaveText(['needle-metadata']);

    await expect.poll(() => searchRequests).toBe(2);
    releaseStaleSearch();
    await expect.poll(async () => (await page.locator('.sbca-filename').allTextContents()).sort()).toEqual([
        'content-match',
        'needle-metadata',
    ]);
    await expect(page.getByText('stale-content-match', { exact: true })).toHaveCount(0);

    await page.locator('.sbca-owner-selector > input[type="hidden"]').evaluate(input => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => searchRequests).toBe(3);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => searchRequests).toBe(4);
    await expect.poll(async () => (await page.locator('.sbca-filename').allTextContents()).sort()).toEqual([
        'content-match',
        'needle-metadata',
    ]);

    await page.getByRole('button', { name: 'Select chats' }).click();
    await expect(page.getByRole('button', { name: 'Select all matching (2)' })).toBeVisible();
    await page.getByRole('button', { name: 'Select all matching (2)' }).click();
    await expect(page.locator('.sbca-selection-count')).toHaveText('2 selected');
});

test('fuzzy-matches character mentions and scopes automatic content search', async ({ page }) => {
    let searchRequests = 0;
    const searchedAvatars = [];
    await routeOrganization(page);
    await page.route('**/api/chats/archive/inventory', route => fulfillJson(route, archivePage([
        linkedRow('ordinary-chat'),
    ], null, null, 1)));
    await page.route('**/api/chats/search', async route => {
        searchRequests++;
        searchedAvatars.push(route.request().postDataJSON().avatar_url);
        expect(route.request().postDataJSON()).toMatchObject({
            query: 'needle',
        });
        await fulfillJson(route, route.request().postDataJSON().avatar_url === 'Alice.png' ? [{
            file_name: 'mentioned-content-match',
            file_size: '2 KB',
            message_count: 2,
            last_mes: 2_000,
            preview_message: 'needle in message content',
        }] : []);
    });

    await page.goto(`${baseUrl}/?duplicate-characters`);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');
    await page.locator('#sbca_drawer_button').click();
    await expect(page.locator('.sbca-root')).toBeVisible();
    const search = page.getByRole('combobox', { name: 'Search indexed chats' });
    await expect(search).toHaveAttribute('placeholder', 'Type to search chats. Mention character names with @.');
    await search.fill('@Alce');
    const mentionMenu = page.getByRole('listbox', { name: 'Character mentions' });
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.getByRole('option')).toHaveText(['Alice']);
    await search.press('Escape');
    await expect(mentionMenu).toBeHidden();
    await expect(search).toHaveAttribute('aria-expanded', 'false');
    await search.fill('@');
    await expect(mentionMenu.getByRole('option')).toHaveCount(4);
    await search.press('ArrowUp');
    const lastOption = mentionMenu.getByRole('option', { name: 'Prime "One"' });
    await expect(lastOption).toHaveAttribute('aria-selected', 'true');
    await expect(lastOption).toHaveCSS('outline-style', 'solid');
    await expect(search).toBeFocused();
    await search.press('ArrowDown');
    await expect(mentionMenu.getByRole('option', { name: 'Alice' })).toHaveAttribute('aria-selected', 'true');
    await search.press('Escape');
    await expect(search).not.toHaveAttribute('aria-activedescendant', /.+/);
    await search.fill('@Prime');
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(search).toHaveValue('@"Prime \\"One\\"" ');
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(0);
    await search.fill('@Path');
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(search).toHaveValue('@"Path\\\\Finder" ');
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(0);
    await search.fill('@"Path\\\\Finder" needle');
    await expect.poll(() => searchRequests).toBe(1);
    expect(searchedAvatars).toEqual(['Path.png']);
    await search.fill('@Alce');
    await expect(mentionMenu).toBeVisible();
    await search.press('ArrowDown');
    await expect(mentionMenu.getByRole('option', { name: 'Alice' })).toHaveAttribute('aria-selected', 'true');
    await expect(search).toHaveAttribute('aria-activedescendant', /sbca_mention_/);
    await search.press('Enter');
    await expect(search).toHaveValue('@Alice ');
    await expect(search).toHaveAttribute('aria-expanded', 'false');
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(1);

    await search.fill('@Alice needle');
    await expect.poll(() => searchRequests).toBe(3);
    expect(searchedAvatars.sort()).toEqual(['Alice-copy.png', 'Alice.png', 'Path.png']);
    await expect(page.locator('.sbca-filename')).toHaveText(['mentioned-content-match']);
});

test('cancels an incremental archive load, releases its cursor, and ignores the late page', async ({ page }) => {
    const releases = [];
    let inventoryRequests = 0;
    let searchRequests = 0;
    let releaseLatePage;
    let markLatePageStarted;
    const latePageStarted = new Promise(resolve => { markLatePageStarted = resolve; });
    const latePageGate = new Promise(resolve => { releaseLatePage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        inventoryRequests++;
        if (inventoryRequests === 1) {
            await fulfillJson(route, archivePage([linkedRow('kept')], ARCHIVE_CURSOR, null, 2));
            return;
        }
        markLatePageStarted();
        await latePageGate;
        await fulfillJson(route, archivePage([linkedRow('late')], null, null, 2));
    });
    await page.route('**/api/chats/search', route => {
        searchRequests++;
        return fulfillJson(route, []);
    });

    await openArchive(page);
    await latePageStarted;
    await expect(page.locator('.sbca-filename')).toHaveText(['kept']);
    await page.getByRole('combobox', { name: 'Search indexed chats' }).fill('kept');
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => releases).toContainEqual({ cursor: ARCHIVE_CURSOR });
    await expect.poll(() => searchRequests).toBe(1);
    releaseLatePage();

    await expect(page.locator('.sbca-filename')).toHaveText(['kept']);
    await expect(page.getByText('late', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});

test('stops an orphan scan, releases its token and cursor, and rolls back partial rows', async ({ page }) => {
    const releases = [];
    let orphanRequests = 0;
    let searchRequests = 0;
    let releaseLatePage;
    let markLatePageStarted;
    const latePageStarted = new Promise(resolve => { markLatePageStarted = resolve; });
    const latePageGate = new Promise(resolve => { releaseLatePage = resolve; });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/search', route => {
        searchRequests++;
        return fulfillJson(route, []);
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        const body = route.request().postDataJSON();
        if (body.scope === 'archive') {
            await fulfillJson(route, archivePage([linkedRow('linked')], null, null, 1));
            return;
        }
        orphanRequests++;
        if (orphanRequests === 1) {
            await fulfillJson(route, archivePage(
                [orphanRow('partial-orphan', FIRST_ORPHAN_HASH)],
                ORPHAN_CURSOR,
                FIRST_READ_TOKEN,
                2,
            ));
            return;
        }
        markLatePageStarted();
        await latePageGate;
        await fulfillJson(route, archivePage(
            [orphanRow('late-orphan', SECOND_ORPHAN_HASH)],
            null,
            FIRST_READ_TOKEN,
            2,
        ));
    });

    await openArchive(page);
    await page.getByRole('combobox', { name: 'Search indexed chats' }).fill('orphan');
    await expect(page.getByRole('button', { name: 'Find orphaned files' })).toBeEnabled();
    await page.getByRole('button', { name: 'Find orphaned files' }).click();
    await latePageStarted;
    await new Promise(resolve => setTimeout(resolve, SEARCH_CONTENT_DEBOUNCE_MS + 50));
    expect(searchRequests).toBe(0);
    await expect(page.getByText('partial-orphan', { exact: true })).toBeVisible();
    await expect(page.locator('.sbca-status')).toContainText('1 of 2 indexed chat files');
    await page.getByRole('button', { name: 'Stop scan' }).click();
    await expect.poll(() => releases).toContainEqual({ token: FIRST_READ_TOKEN, cursor: ORPHAN_CURSOR });
    releaseLatePage();

    await expect(page.getByText('partial-orphan', { exact: true })).toHaveCount(0);
    await expect(page.getByText('late-orphan', { exact: true })).toHaveCount(0);
    await expect.poll(() => searchRequests).toBe(1);
});

test('replaces orphan scan tokens and views the active orphan through the archive namespace', async ({ page }) => {
    const releases = [];
    const viewedUrls = [];
    const dataMaidRequests = [];
    let orphanScans = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/data-maid')) {
            dataMaidRequests.push(request.url());
        }
    });
    await routeOrganization(page);
    await page.route('**/api/chats/archive/release', async route => {
        releases.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/view?**', async route => {
        viewedUrls.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'application/x-ndjson',
            body: [
                JSON.stringify({ chat_metadata: { source: 'archive' } }),
                JSON.stringify({ name: 'Archive', mes: 'orphan body' }),
            ].join('\n'),
        });
    });
    await page.route('**/api/chats/archive/inventory', async route => {
        const body = route.request().postDataJSON();
        if (body.scope === 'archive') {
            await fulfillJson(route, archivePage([linkedRow('linked')], null, null, 1));
            return;
        }
        orphanScans++;
        const replacement = orphanScans === 2;
        await fulfillJson(route, archivePage([
            orphanRow(replacement ? 'current-orphan' : 'old-orphan', replacement ? SECOND_ORPHAN_HASH : FIRST_ORPHAN_HASH),
        ], null, replacement ? SECOND_READ_TOKEN : FIRST_READ_TOKEN, 1));
    });

    await openArchive(page);
    await page.getByRole('button', { name: 'Find orphaned files' }).click();
    await expect(page.getByText('old-orphan', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rescan orphaned files' }).click();
    await expect(page.getByText('current-orphan', { exact: true })).toBeVisible();
    await expect(page.getByText('old-orphan', { exact: true })).toHaveCount(0);
    await expect.poll(() => releases).toContainEqual({ token: FIRST_READ_TOKEN });

    await page.getByText('current-orphan', { exact: true }).click();
    await expect(page.locator('.sbca-viewer-content')).toContainText('orphan body');
    const mobileDetail = await page.locator('.sbca-viewer-content').evaluate(content => {
        const folderStyle = getComputedStyle(content.querySelector('.sbca-organizer-folder'));
        const collectionsStyle = getComputedStyle(content.querySelector('.sbca-organizer-collections'));
        const tagsStyle = getComputedStyle(content.querySelector('.sbca-organizer-tags'));
        return {
            hasStackedOrganizerPills: parseFloat(folderStyle.borderTopWidth) > 0
                && parseFloat(collectionsStyle.borderTopWidth) > 0
                && parseFloat(tagsStyle.borderTopWidth) > 0
                && parseFloat(folderStyle.borderRadius) > 0
                && parseFloat(collectionsStyle.borderRadius) > 0
                && parseFloat(tagsStyle.borderRadius) > 0,
            noHorizontalOverflow: content.scrollWidth <= content.clientWidth,
            order: [...content.children].map(child => child.className),
        };
    });
    expect(mobileDetail.order).toEqual(['sbca-viewer-actions', 'sbca-organizer', 'sbca-viewer-details']);
    expect(mobileDetail.hasStackedOrganizerPills).toBe(true);
    expect(mobileDetail.noHorizontalOverflow).toBe(true);
    expect(viewedUrls).toHaveLength(1);
    const viewed = new URL(viewedUrls[0]);
    expect(viewed.pathname).toBe('/api/chats/archive/view');
    expect(viewed.searchParams.get('token')).toBe(SECOND_READ_TOKEN);
    expect(viewed.searchParams.get('hash')).toBe(SECOND_ORPHAN_HASH);
    expect(dataMaidRequests).toEqual([]);
});

async function routeOrganization(page, organization = null) {
    await page.route('**/user/files/_sbca_organization.json', route => organization
        ? fulfillJson(route, organization)
        : route.fulfill({ status: 404 }));
}

async function openArchive(page) {
    await page.goto(baseUrl);
    await expect(page.locator('html')).toHaveAttribute('data-archive-ready', 'true');
    await page.locator('#sbca_drawer_button').click();
    await expect(page.locator('.sbca-root')).toBeVisible();
}

function archivePage(rows, cursor, readToken, total) {
    return { rows, cursor, read_token: readToken, errors: 0, total };
}

function linkedRow(name) {
    return {
        _source: 'archive-inventory',
        avatar: 'Alice.png',
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: 1_000,
        mes: `${name} preview`,
    };
}

function orphanRow(name, hash) {
    return {
        _source: 'archive-orphan',
        archive_hash: hash,
        chatFolder: 'Deleted',
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: 1_000,
        mes: `${name} preview`,
        orphan_type: 'missing-character',
    };
}

function fulfillJson(route, value) {
    return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(value),
    });
}

function fixtureHtml(useLongLabel, duplicateCharacters = false) {
    const translatedLabel = useLongLabel
        ? 'Chat Archive Chat Archive Chat Archive Chat Archive'
        : 'Chat Archive';
    const characters = [
        { avatar: 'Alice.png', name: 'Alice' },
        ...(duplicateCharacters ? [
            { avatar: 'Alice-copy.png', name: 'Alice' },
            { avatar: 'Bob.png', name: 'Bob' },
            { avatar: 'Path.png', name: 'Path\\Finder' },
            { avatar: 'Prime.png', name: 'Prime "One"' },
        ] : []),
    ];
    return `<!doctype html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/public/style.css">
    <link rel="stylesheet" href="/public/css/sillybunny-theme.css">
    <link rel="stylesheet" href="/public/css/mobile-styles.css" media="(max-width: 768px)">
    <link rel="stylesheet" href="/public/css/sillybunny-tabs.css">
    <link rel="stylesheet" href="/public/css/sillybunny-mobile-shell.css" media="(max-width: 768px)">
    <link rel="stylesheet" href="/extension/style.css">
    <style>
        :root { --mainFontFamily: sans-serif; --sb-mobile-touch-target: 44px; }
        body { margin: 0; }
        .menu_button { border: 1px solid currentColor; background: transparent; color: inherit; font: inherit; }
        .sb-character-create-bar { display: flex; width: 100%; overflow-x: auto; }
    </style>
</head>
<body>
    <div id="right-nav-panel" class="openDrawer">
        <div id="charListFixedTop">
            <div class="sb-character-create-bar">
                <div id="rm_button_bar">
                    <div id="rm_buttons_container"></div>
                </div>
            </div>
        </div>
    </div>
    <script type="module">
        const label = ${JSON.stringify(translatedLabel)};
        globalThis.SillyTavern = {
            getContext() {
                return {
                    characters: ${JSON.stringify(characters)},
                    groups: [],
                    eventSource: { on() {}, removeListener() {} },
                    eventTypes: { APP_READY: 'app-ready' },
                    getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
                    getThumbnailUrl(_type, avatar) { return '/avatar/' + encodeURIComponent(avatar); },
                    timestampToMoment(value) {
                        const date = new Date(value);
                        return {
                            isValid() { return !Number.isNaN(date.valueOf()); },
                            valueOf() { return date.valueOf(); },
                            format() { return date.toISOString(); },
                        };
                    },
                    translate(text) { return text === 'Chat Archive' ? label : text; },
                    Popup: class {
                        constructor(content) {
                            this.dlg = document.createElement('dialog');
                            this.dlg.className = 'popup large_dialogue_popup';
                            this.dlg.tabIndex = -1;
                            this.body = document.createElement('div');
                            this.body.className = 'popup-body';
                            this.content = document.createElement('div');
                            this.content.className = 'popup-content';
                            this.controls = document.createElement('div');
                            this.controls.className = 'popup-controls';
                            this.okButton = document.createElement('button');
                            this.okButton.type = 'button';
                            this.okButton.className = 'menu_button popup-button-ok';
                            this.okButton.textContent = 'Close';
                            this.closeButton = document.createElement('div');
                            this.closeButton.className = 'popup-button-close';
                            this.closeButton.setAttribute('aria-label', 'Close popup');
                            this.closeButton.tabIndex = 0;
                            this.content.append(content);
                            this.controls.append(this.okButton);
                            this.body.append(this.content, this.controls);
                            this.dlg.append(this.body, this.closeButton);
                            this.shown = new Promise(resolve => { this.resolve = resolve; });
                            this.okButton.addEventListener('click', () => this.completeCancelled());
                            this.closeButton.addEventListener('click', () => this.completeCancelled());
                        }
                        show() {
                            document.body.append(this.dlg);
                            this.dlg.showModal();
                            return this.shown;
                        }
                        async completeCancelled() {
                            if (this.dlg.isConnected) {
                                this.dlg.remove();
                                this.resolve();
                            }
                        }
                    },
                    POPUP_TYPE: { TEXT: 'text' },
                };
            },
        };
        const { activate } = await import('/extension/index.js');
        await activate();
        document.documentElement.dataset.archiveReady = 'true';
    </script>
</body>
</html>`;
}
