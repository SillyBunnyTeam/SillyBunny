import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('sortable handle classes', () => {
    test.beforeEach(testSetup.awaitST);

    test('is installed before the app creates sortable lists', async ({ page }) => {
        const patchedAgain = await page.evaluate(async () => {
            const { batchSortableHandleClasses } = await import('/scripts/sortable-handle-classes.js');
            return batchSortableHandleClasses();
        });

        expect(patchedAgain).toBe(false);
    });

    test('leaves the same handle classes and tracked elements as the per-item loop', async ({ page }) => {
        const result = await page.evaluate(() => {
            const $ = window.jQuery;

            // jQuery UI 1.13.2 sortable._setHandleClassName, kept as the reference behavior.
            $.widget('sbtest.perItemSortable', $.ui.sortable, {
                _setHandleClassName: function () {
                    const that = this;
                    this._removeClass(this.element.find('.ui-sortable-handle'), 'ui-sortable-handle');
                    $.each(this.items, function () {
                        that._addClass(this.instance.options.handle ? this.item.find(this.instance.options.handle) : this.item, 'ui-sortable-handle');
                    });
                },
            });

            const host = $('<div style="position:absolute;left:-10000px;top:0;width:300px"></div>').appendTo(document.body);
            const makeList = count => {
                const list = $('<ul></ul>').appendTo(host);
                for (let i = 0; i < count; i++) {
                    list.append(`<li class="row" data-i="${i}"><span class="grip">::</span> item ${i}</li>`);
                }
                list.append('<li class="fixed">not sortable</li>');
                return list;
            };
            const snapshot = (list, widgetName) => {
                const instance = list[widgetName]('instance');
                return {
                    handles: list.find('.ui-sortable-handle').map((_, el) => `${el.tagName}:${$(el).closest('li').data('i') ?? 'x'}`).get(),
                    lookup: Object.fromEntries(Object.entries(instance.classesElementLookup).map(([key, set]) => [key, set.length])),
                    items: instance.items.length,
                };
            };
            const compare = (options, mutate) => {
                const batched = makeList(60);
                const perItem = makeList(60);
                batched.sortable({ items: '.row', ...options });
                perItem.perItemSortable({ items: '.row', ...options });
                if (mutate) {
                    mutate(batched, 'sortable');
                    mutate(perItem, 'perItemSortable');
                }
                return { batched: snapshot(batched, 'sortable'), perItem: snapshot(perItem, 'perItemSortable') };
            };
            const addAndRefresh = (list, widgetName) => {
                list.prepend('<li class="row" data-i="new"><span class="grip">::</span> new</li>');
                list.children('.row').eq(10).remove();
                list[widgetName]('refresh');
            };

            const cases = {
                whole: compare({}),
                handle: compare({ handle: '.grip' }),
                refreshed: compare({}, addAndRefresh),
                refreshedHandle: compare({ handle: '.grip' }, addAndRefresh),
            };

            const destroyed = makeList(20);
            destroyed.sortable({ items: '.row' });
            destroyed.sortable('destroy');
            const leftoverHandles = destroyed.find('.ui-sortable-handle').length;

            host.remove();
            return { cases, leftoverHandles };
        });

        for (const { batched, perItem } of Object.values(result.cases)) {
            expect(batched).toEqual(perItem);
            expect(batched.handles.length).toBeGreaterThan(0);
        }
        expect(result.cases.handle.batched.handles.every(handle => handle.startsWith('SPAN:'))).toBe(true);
        expect(result.cases.whole.batched.handles).not.toContain('LI:x');
        expect(result.leftoverHandles).toBe(0);
    });

    test('creates a long sortable list without quadratic handle tracking', async ({ page }) => {
        const elapsed = await page.evaluate(() => {
            const $ = window.jQuery;
            const list = $('<ul style="position:absolute;left:-10000px;top:0"></ul>').appendTo(document.body);
            for (let i = 0; i < 1500; i++) {
                list.append(`<li class="row">item ${i}</li>`);
            }

            const start = performance.now();
            list.sortable({ items: '.row' });
            const duration = performance.now() - start;
            list.remove();
            return duration;
        });

        // The per-item loop takes tens of seconds at this size.
        expect(elapsed).toBeLessThan(5000);
    });
});
