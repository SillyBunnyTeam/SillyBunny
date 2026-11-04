const patchedPrototypes = new WeakSet();

/**
 * jQuery UI 1.13 gives sortable items the `ui-sortable-handle` class one item at a time.
 * Every `_addClass` call re-checks and re-sorts all elements the widget already tracks,
 * so creating or refreshing a sortable is quadratic in its item count. A prompt list with
 * ~700 entries took ~10 seconds. One call over all handles tracks the same elements and
 * applies the same classes.
 * @param {JQueryStatic} [jQuery] jQuery instance that carries jQuery UI.
 * @returns {boolean} True when the sortable prototype was patched by this call.
 */
export function batchSortableHandleClasses(jQuery = globalThis.jQuery) {
    const prototype = jQuery?.ui?.sortable?.prototype;
    if (!prototype || patchedPrototypes.has(prototype)) {
        return false;
    }

    prototype._setHandleClassName = function () {
        this._removeClass(this.element.find('.ui-sortable-handle'), 'ui-sortable-handle');

        const handles = [];
        for (const item of this.items) {
            const handle = item.instance.options.handle;
            handles.push(...(handle ? item.item.find(handle) : item.item).get());
        }

        if (handles.length > 0) {
            this._addClass(jQuery(jQuery.uniqueSort(handles)), 'ui-sortable-handle');
        }
    };

    patchedPrototypes.add(prototype);
    return true;
}
