/** The states a status page can describe; `loading` takes the spinner form. */
export const STATUS_PAGE_STATES = Object.freeze(['empty', 'no-results', 'loading', 'error', 'unavailable']);

/** A loading page appears only after this wait, so a quick load shows nothing. */
export const STATUS_PAGE_LOADING_DELAY = 200;

const DEFAULT_ICONS = Object.freeze({ 'empty': 'inbox', 'no-results': 'magnifying-glass', 'error': 'triangle-exclamation', 'unavailable': 'ban' });

// The page's rules live in the deferred editor shell sheet. This key matches the `LIST_EDITOR_STYLESHEET` call sites.
const STYLESHEET = Object.freeze({ href: 'css/sillybunny-editor-shell.css?v=20261118zt', id: 'deferred-editor-shell-css' });

let pageCount = 0;

function checkState(state) {
    if (state !== undefined && !STATUS_PAGE_STATES.includes(state)) throw new RangeError(`Unknown status page state: ${state}`);
}

function stylesheetReady() {
    const link = document.getElementById(STYLESHEET.id);
    return link?.dataset.sbStyleState === 'loaded' || link?.dataset.loaded === 'true';
}

/**
 * Loads the sheet that draws the page unless it has loaded. A page that appears before the sheet is ready stays
 * invisible until it is, so that it never shows unstyled.
 * @param {(unstyled: boolean) => void} setUnstyled
 */
function holdUntilStyled(setUnstyled) {
    const load = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!load || stylesheetReady()) return;
    setUnstyled(true);
    const loading = Promise.resolve(load(STYLESHEET.href, { id: STYLESHEET.id }));
    // The sheet's own load event also shows the page: a loader that waits for more than the sheet must not hold it back.
    const link = document.getElementById(STYLESHEET.id);
    const loaded = link ? new Promise(resolve => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
    }) : loading;
    Promise.race([loading, loaded])
        .catch(error => console.warn('Failed to load the status page styles.', error))
        .finally(() => setUnstyled(false));
}

/** Loads the sheet that draws the spinner, unless it has loaded. A spinner has no size until then, so it shows nothing unstyled. */
export function ensureSpinnerStyles() {
    const load = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!load || stylesheetReady()) return;
    Promise.resolve(load(STYLESHEET.href, { id: STYLESHEET.id }))
        .catch(error => console.warn('Failed to load the spinner styles.', error));
}

const SPINNER_ATTRIBUTES = 'class="sb-spinner sb-spinner--delayed" role="progressbar" aria-busy="true"';

/**
 * The shared spinner as markup, for a template string. It appears after a short delay (`sb-spinner--delayed`), so a
 * quick wait shows nothing, and it is announced as a busy progress indicator named by `label`.
 * @param {string} [label] The task, such as "Updating". It must not hold markup.
 * @returns {string}
 */
export function spinnerMarkup(label) {
    ensureSpinnerStyles();
    const name = label ? ` aria-label="${String(label).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"` : '';
    return `<span ${SPINNER_ATTRIBUTES}${name}></span>`;
}

/**
 * The shared spinner as an element, for a wait inside a control or beside a label (the status page draws its own).
 * @param {object} [options]
 * @param {string} [options.label] The task, such as "Scanning".
 * @param {boolean} [options.large=false] The `64px` size, for a wait that fills a region.
 * @returns {HTMLSpanElement}
 */
export function createSpinner({ label, large = false } = {}) {
    ensureSpinnerStyles();
    const node = document.createElement('span');
    node.className = `sb-spinner sb-spinner--delayed${large ? ' sb-spinner--large' : ''}`;
    node.setAttribute('role', 'progressbar');
    node.setAttribute('aria-busy', 'true');
    if (label) node.setAttribute('aria-label', label);
    return node;
}

/**
 * Swaps the icon of a control for the shared spinner while the control waits, and puts the icon back after. The icon
 * stays in the page, hidden, so code that finds it by class or position still does.
 * @param {Element | null | undefined} icon The `<i>` glyph inside the control.
 * @param {boolean} busy
 */
export function setIconBusy(icon, busy) {
    if (!icon) return;
    const current = icon.nextElementSibling?.matches('.sb-spinner[data-sb-icon-spinner]') ? icon.nextElementSibling : null;
    if (!busy) {
        current?.remove();
        if (icon.dataset.sbDisplay !== undefined) {
            icon.style.display = icon.dataset.sbDisplay;
            delete icon.dataset.sbDisplay;
        }
        return;
    }
    if (current) return;
    const owner = icon.closest('[aria-label], [title]');
    const spinner = createSpinner({ label: owner?.getAttribute('aria-label') || owner?.getAttribute('title') || undefined });
    spinner.dataset.sbIconSpinner = '';
    icon.after(spinner);
    // `hidden` loses to the `display` that Font Awesome sets on its glyphs.
    icon.dataset.sbDisplay = icon.style.display;
    icon.style.display = 'none';
}

/**
 * One status page for an empty view, a search without a match, a wait, a failure or a feature that is unavailable.
 * The title names the state; a description and an action appear only when they help. The default set is for a view,
 * `compact` for a sidebar, a popover or a pane, and the loading form is the compact set with a spinner in place of the icon.
 * @param {object} options
 * @param {'empty' | 'no-results' | 'loading' | 'error' | 'unavailable'} [options.state] Sets `data-state` and a default icon; `loading` shows the spinner.
 * @param {string} [options.icon] Font Awesome icon name without the fa- prefix. Optional when `state` supplies one.
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {{id?: string, label: string, onActivate?: (event: MouseEvent) => void, primary?: boolean}[]} [options.actions=[]] A loading page keeps the first only, such as Cancel.
 * @param {boolean} [options.compact=false]
 * @param {number} [options.delay] Milliseconds before the page shows: `STATUS_PAGE_LOADING_DELAY` for `loading`, none otherwise.
 * @param {boolean} [options.reserveSpace=false] The page keeps its place during the delay and is only unpainted, for a region that would otherwise collapse to nothing while it waits.
 * @param {HTMLElement} [options.busy] The region that waits. It is marked busy until `release` or an update to another state.
 * @returns {{element: HTMLDivElement, update: (values: {state?: string, icon?: string, title?: string, description?: string}) => void, release: () => void}}
 */
export function createStatusPage({ state, icon, title, description, actions = [], compact = false, delay, reserveSpace = false, busy }) {
    checkState(state);
    const id = `sb-status-page-${++pageCount}`;
    const element = document.createElement('div');
    element.className = 'sb-status-page';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-labelledby', `${id}-title`);
    const heading = document.createElement('h3');
    heading.id = `${id}-title`;
    const detail = document.createElement('p');
    detail.id = `${id}-description`;
    detail.className = 'sb-status-page__description';
    let visual = null;
    let region = null;
    let timer = 0;
    let currentIcon = icon ?? DEFAULT_ICONS[state];
    let held = false;
    let unstyled = false;
    const paint = () => {
        if (held || unstyled) element.style.visibility = 'hidden';
        else element.style.removeProperty('visibility');
    };

    const reveal = () => {
        clearTimeout(timer);
        timer = 0;
        element.hidden = false;
        held = false;
        paint();
    };
    let labelled = false;

    const release = () => {
        clearTimeout(timer);
        timer = 0;
        region?.removeAttribute('aria-busy');
        if (labelled) region?.removeAttribute('aria-labelledby');
        region = null;
        labelled = false;
    };
    const markBusy = () => {
        if (!busy || region === busy) return;
        region = busy;
        region.setAttribute('aria-busy', 'true');
        // The page is the label of a region that has no other name.
        labelled = !region.hasAttribute('aria-label') && !region.hasAttribute('aria-labelledby');
        if (labelled) region.setAttribute('aria-labelledby', heading.id);
    };
    const buildVisual = spinner => {
        const node = document.createElement(spinner ? 'span' : 'i');
        if (spinner) {
            node.className = 'sb-spinner';
            node.setAttribute('role', 'progressbar');
            node.setAttribute('aria-busy', 'true');
            node.setAttribute('aria-labelledby', heading.id);
        } else {
            node.setAttribute('aria-hidden', 'true');
        }
        return node;
    };
    const apply = nextState => {
        const spinner = nextState === 'loading';
        const small = compact || spinner;
        if (nextState) element.dataset.state = nextState;
        else delete element.dataset.state;
        element.classList.toggle('sb-status-page--compact', small);
        element.classList.toggle('sb-status-page--spinner', spinner);
        heading.className = `sb-status-page__title ${small ? 'title-2' : 'title-1'}`;
        if (!visual || visual.classList.contains('sb-spinner') !== spinner) {
            const node = buildVisual(spinner);
            if (visual) visual.replaceWith(node);
            else element.prepend(node);
            visual = node;
        }
        if (!spinner) visual.className = `fa-solid${currentIcon ? ` fa-${currentIcon}` : ''} sb-status-page__icon`;
    };

    element.append(heading);
    if (actions.length) {
        const buttons = document.createElement('div');
        buttons.className = 'sb-status-page__actions';
        for (const { id: actionId, label, onActivate, primary = false } of state === 'loading' ? actions.slice(0, 1) : actions) {
            const button = document.createElement('button');
            button.type = 'button';
            if (actionId) button.id = actionId;
            button.className = 'menu_button sb-status-page__action';
            button.classList.toggle('menu_button_primary', Boolean(primary));
            button.classList.toggle('is-suggested', Boolean(primary));
            button.textContent = label;
            button.addEventListener('click', event => onActivate?.(event));
            buttons.append(button);
        }
        element.append(buttons);
    }

    const update = values => {
        if (Object.hasOwn(values, 'state') || Object.hasOwn(values, 'icon')) {
            const nextState = Object.hasOwn(values, 'state') ? values.state : element.dataset.state;
            checkState(nextState);
            if (Object.hasOwn(values, 'icon')) currentIcon = values.icon;
            else if (Object.hasOwn(values, 'state') && DEFAULT_ICONS[nextState]) currentIcon = DEFAULT_ICONS[nextState];
            apply(nextState);
            if (nextState === 'loading') {
                markBusy();
            } else {
                // A failure replaces the wait, so it shows at once.
                if (timer) reveal();
                release();
            }
        }
        if (Object.hasOwn(values, 'title')) heading.textContent = values.title ?? '';
        if (!Object.hasOwn(values, 'description')) return;
        detail.textContent = values.description ?? '';
        if (values.description) {
            heading.after(detail);
            element.setAttribute('aria-describedby', detail.id);
        } else {
            detail.remove();
            element.removeAttribute('aria-describedby');
        }
    };
    apply(state);
    update({ title, description });

    if (state === 'loading') markBusy();
    const wait = delay ?? (state === 'loading' ? STATUS_PAGE_LOADING_DELAY : 0);
    if (wait > 0) {
        if (reserveSpace) held = true;
        else element.hidden = true;
        timer = setTimeout(reveal, wait);
    }
    holdUntilStyled(value => {
        unstyled = value;
        paint();
    });
    paint();
    return { element, update, release };
}
