const BODY_ACTIVE_CLASS = 'ica--textarea-fullscreen-active';
const FIELD_ACTIVE_CLASS = 'ica--textarea-fullscreen-field';
const WRAPPER_CLASS = 'ica--textarea-fullscreen-wrapper';
const WRAPPER_ACTIVE_CLASS = 'is-fullscreen';
const TOGGLE_CLASS = 'ica--textarea-fullscreen-toggle';
const BACKDROP_CLASS = 'ica--textarea-fullscreen-backdrop';

let activeController = null;

/**
 * Adds a per-textarea fullscreen toggle to every textarea found in the target.
 * @param {HTMLElement|HTMLTextAreaElement|JQuery|Iterable<HTMLElement>} target
 */
export function attachTextareaFullscreen(target) {
    for (const textarea of resolveTextareas(target)) {
        enhanceTextarea(textarea);
    }
}

export function closeActiveTextareaFullscreen() {
    activeController?.close({ restoreFocus: false });
}

function resolveTextareas(target) {
    if (!target) {
        return [];
    }

    let roots;
    if (target.jquery && typeof target.toArray === 'function') {
        roots = target.toArray();
    } else if (isIterable(target) && !(target instanceof HTMLElement)) {
        roots = Array.from(target);
    } else {
        roots = [target];
    }

    return roots.flatMap(root => {
        if (root instanceof HTMLTextAreaElement) {
            return [root];
        }

        if (root instanceof HTMLElement) {
            return Array.from(root.querySelectorAll('textarea'));
        }

        return [];
    });
}

function isIterable(value) {
    return Boolean(value && typeof value[Symbol.iterator] === 'function');
}

function enhanceTextarea(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.icaTextareaFullscreen === 'true' || !textarea.parentNode) {
        return;
    }

    textarea.dataset.icaTextareaFullscreen = 'true';

    const wrapper = document.createElement('span');
    wrapper.className = WRAPPER_CLASS;
    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.append(textarea);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `menu_button menu_button_icon ${TOGGLE_CLASS}`;
    toggle.setAttribute('aria-label', 'Open textarea fullscreen');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Open textarea fullscreen';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-maximize';
    toggle.append(icon);
    wrapper.append(toggle);

    let backdrop = null;

    const controller = {
        close,
    };

    toggle.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
    });

    toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        if (activeController === controller) {
            close();
            return;
        }

        open();
    });

    function open() {
        if (activeController && activeController !== controller) {
            activeController.close({ restoreFocus: false });
        }

        activeController = controller;
        wrapper.style.minHeight = `${textarea.offsetHeight}px`;
        wrapper.classList.add(WRAPPER_ACTIVE_CLASS);
        textarea.classList.add(FIELD_ACTIVE_CLASS);
        document.body.classList.add(BODY_ACTIVE_CLASS);

        // Popup dialogs have backdrop-filter, which makes them the containing block for
        // position: fixed and shrinks/misplaces the fullscreen field, and they are shown
        // with showModal(), which makes everything outside their top layer inert. Hosting
        // the field in a modal <dialog> backdrop of its own solves both: it stacks above
        // the popup in the top layer and stays viewport-sized regardless of ancestors.
        backdrop = document.createElement('dialog');
        backdrop.className = BACKDROP_CLASS;
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) {
                close();
            }
        });
        backdrop.addEventListener('cancel', event => {
            event.preventDefault();
            close();
        });
        backdrop.append(textarea, toggle);
        document.body.append(backdrop);
        try {
            backdrop.showModal();
        } catch {
            backdrop.setAttribute('open', '');
        }
        document.addEventListener('keydown', onKeyDown, true);
        updateToggleState(true);
        textarea.focus({ preventScroll: true });
    }

    function close({ restoreFocus = true } = {}) {
        if (activeController !== controller) {
            return;
        }

        activeController = null;
        wrapper.style.minHeight = '';
        wrapper.classList.remove(WRAPPER_ACTIVE_CLASS);
        textarea.classList.remove(FIELD_ACTIVE_CLASS);
        document.body.classList.remove(BODY_ACTIVE_CLASS);
        document.removeEventListener('keydown', onKeyDown, true);
        wrapper.append(textarea, toggle);
        try {
            backdrop?.close();
        } catch {
            // Already closed or never shown modally.
        }
        backdrop?.remove();
        backdrop = null;
        updateToggleState(false);

        if (restoreFocus && textarea.isConnected) {
            textarea.focus({ preventScroll: true });
        }
    }

    function onKeyDown(event) {
        if (event.key !== 'Escape') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        close();
    }

    function updateToggleState(isFullscreen) {
        toggle.setAttribute('aria-pressed', String(isFullscreen));
        toggle.setAttribute('aria-label', isFullscreen ? 'Exit textarea fullscreen' : 'Open textarea fullscreen');
        toggle.title = isFullscreen ? 'Exit textarea fullscreen' : 'Open textarea fullscreen';
        icon.className = `fa-solid ${isFullscreen ? 'fa-compress' : 'fa-maximize'}`;
    }
}
