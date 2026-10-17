import { t } from '../i18n.js';

/**
 * Native pagination with an optional asynchronous navigation guard.
 * `setTotal` renders/clamps state without notifying; navigation notifies after the guard succeeds.
 *
 * @param {object} options
 * @param {string} [options.label]
 * @param {number[]} [options.pageSizes=[25, 50, 100, 250]]
 * @param {() => unknown} [options.readPageSize]
 * @param {(size: number) => void} [options.writePageSize]
 * @param {(state: { page: number, pageSize: number, offset: number }) => void} [options.onChange]
 * @param {(() => boolean|Promise<boolean>)|null} [options.guard=null]
 * @returns {{ element: HTMLElement, setTotal: (total: number) => void,
 *   goTo: (page: number) => Promise<void>, next: () => Promise<void>, prev: () => Promise<void>,
 *   pageOf: (index: number) => number, showIndex: (index: number) => Promise<void>,
 *   slice: <T>(array: T[]) => T[], readonly page: number, readonly pageSize: number,
 *   readonly pages: number, readonly offset: number, destroy: () => void }}
 */
export function createListPagination({
    label = t`Pages`,
    pageSizes = [25, 50, 100, 250],
    readPageSize,
    writePageSize,
    onChange,
    guard = null,
}) {
    if (!pageSizes.length || pageSizes.some(size => !Number.isInteger(size) || size <= 0)) {
        throw new RangeError('pageSizes must contain positive integers.');
    }
    const sizes = [...new Set(pageSizes)];
    const savedSize = Number(readPageSize?.());
    let pageSize = sizes.includes(savedSize) ? savedSize : sizes[0];
    let page = 1;
    let total = 0;
    let destroyed = false;
    let revision = 0;

    const element = document.createElement('nav');
    element.className = 'sb-list-pagination';
    element.setAttribute('aria-label', label);

    function createButton(direction, accessibleLabel) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sb-list-pagination__${direction === 'left' ? 'prev' : 'next'}`;
        button.setAttribute('aria-label', accessibleLabel);
        const icon = document.createElement('i');
        icon.className = `fa-solid fa-chevron-${direction}`;
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
        return button;
    }

    const previous = createButton('left', t`Previous page`);
    const status = document.createElement('span');
    status.className = 'sb-list-pagination__status';
    status.setAttribute('aria-live', 'polite');
    const following = createButton('right', t`Next page`);
    const select = document.createElement('select');
    select.className = 'sb-list-pagination__size';
    select.setAttribute('aria-label', t`Items per page`);
    for (const size of sizes) {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = String(size);
        select.append(option);
    }
    element.append(previous, status, following, select);

    const pageCount = () => Math.max(1, Math.ceil(total / pageSize));
    const offset = () => (page - 1) * pageSize;
    const clampPage = value => Math.min(pageCount(), Math.max(1, Math.trunc(value)));

    function render() {
        element.hidden = total <= pageSize;
        previous.disabled = page === 1;
        following.disabled = page === pageCount();
        const pages = pageCount();
        const message = t`Page ${page} of ${pages}`;
        if (status.textContent !== message) status.textContent = message;
        select.value = String(pageSize);
    }

    async function change(requestedPage, requestedSize) {
        if (destroyed) return;
        if (!Number.isFinite(requestedPage)) throw new RangeError('page must be finite.');
        const request = ++revision;
        if (guard && await guard() === false) {
            if (!destroyed && request === revision) render();
            return;
        }
        // Ignore older approvals if another navigation or destruction overtook this request.
        if (destroyed || request !== revision) return;
        if (requestedSize !== pageSize) writePageSize?.(requestedSize);
        pageSize = requestedSize;
        page = clampPage(requestedPage);
        render();
        onChange?.({ page, pageSize, offset: offset() });
    }

    function setTotal(value) {
        if (!Number.isFinite(value)) throw new RangeError('total must be finite.');
        total = Math.max(0, Math.trunc(value));
        page = clampPage(page);
        render();
    }

    const goTo = value => change(value, pageSize);
    const next = () => goTo(page + 1);
    const prev = () => goTo(page - 1);
    const pageOf = index => {
        if (!Number.isFinite(index)) throw new RangeError('index must be finite.');
        return Math.floor(Math.max(0, index) / pageSize) + 1;
    };
    const onPrevious = () => { void prev(); };
    const onNext = () => { void next(); };
    const onSizeChange = () => {
        const size = Number(select.value);
        render();
        if (!sizes.includes(size)) return;
        const nextPage = Math.floor(offset() / size) + 1;
        void change(nextPage, size);
    };

    previous.addEventListener('click', onPrevious);
    following.addEventListener('click', onNext);
    select.addEventListener('change', onSizeChange);
    render();

    return {
        element,
        setTotal,
        goTo,
        next,
        prev,
        pageOf,
        showIndex: index => goTo(pageOf(index)),
        slice: array => array.slice(offset(), offset() + pageSize),
        get page() { return page; },
        get pageSize() { return pageSize; },
        get pages() { return pageCount(); },
        get offset() { return offset(); },
        destroy() {
            destroyed = true;
            previous.removeEventListener('click', onPrevious);
            following.removeEventListener('click', onNext);
            select.removeEventListener('change', onSizeChange);
        },
    };
}
