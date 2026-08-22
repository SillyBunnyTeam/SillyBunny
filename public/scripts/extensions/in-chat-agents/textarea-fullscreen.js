const WRAPPER_CLASS = 'ica--textarea-fullscreen-wrapper';
const TOGGLE_CLASS = 'ica--textarea-fullscreen-toggle';

let generatedFieldId = 0;

/**
 * Adds a fullscreen toggle to every textarea found in the target.
 * @param {HTMLElement|HTMLTextAreaElement|JQuery|Iterable<HTMLElement>} target
 */
export function attachTextareaFullscreen(target) {
    for (const textarea of resolveTextareas(target)) {
        enhanceTextarea(textarea);
    }
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

    if (!textarea.id) {
        // The shared .editor_maximize handler resolves its field by id, so anonymous fields need one.
        textarea.id = `ica--textarea-fullscreen-field-${++generatedFieldId}`;
    }

    const wrapper = document.createElement('span');
    wrapper.className = WRAPPER_CLASS;
    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.append(textarea);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `menu_button menu_button_icon editor_maximize ${TOGGLE_CLASS}`;
    toggle.dataset.for = textarea.id;
    toggle.setAttribute('aria-label', 'Expand the editor');
    toggle.title = 'Expand the editor';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-maximize';
    icon.setAttribute('aria-hidden', 'true');
    toggle.append(icon);
    wrapper.append(toggle);
}
