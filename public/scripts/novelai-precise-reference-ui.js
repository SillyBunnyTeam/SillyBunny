import { MAX_PRECISE_REFERENCES, MAX_PRECISE_REFERENCE_BYTES, getNovelAIPreciseReferenceSize, supportsNovelAIPreciseReference } from './novelai-precise-reference.js';

/** Prepares the provider's fixed-size, black-padded PNG without cropping the reference. */
export async function prepareNovelAIPreciseReference(file) {
    if (!file.type.startsWith('image/') || file.size > MAX_PRECISE_REFERENCE_BYTES) {
        throw new Error('Choose an image smaller than 25 MiB.');
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Unable to read this image. Choose a PNG, JPEG, or WebP file.'));
            image.src = url;
        });
        const { width, height } = getNovelAIPreciseReferenceSize(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const drawnWidth = Math.round(image.naturalWidth * scale);
        const drawnHeight = Math.round(image.naturalHeight * scale);
        context.fillStyle = '#000000'; // NovelAI's reference encoder requires black padding.
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, Math.floor((width - drawnWidth) / 2), Math.floor((height - drawnHeight) / 2), drawnWidth, drawnHeight);
        return canvas.toDataURL('image/png').split(',')[1];
    } finally {
        URL.revokeObjectURL(url);
        image.src = '';
    }
}

/** Shared editor; each generation surface owns and persists its own reference state. */
export function mountNovelAIPreciseReferenceEditor(container, { getState, onChange, getModel }) {
    const stylesheet = new URL('../css/novelai-precise-reference.css', import.meta.url).href;
    if (!document.querySelector('link[data-novelai-precise-reference]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = stylesheet;
        link.dataset.novelaiPreciseReference = '';
        document.head.append(link);
    }
    container.classList.add('nai-precise-reference');
    let busy = false;
    let error = '';

    function state() {
        const current = getState() || {};
        return { enabled: current.enabled === true, references: Array.isArray(current.references) ? current.references : [] };
    }

    function save(next) {
        onChange(next);
        error = '';
    }

    function updateReference(index, field, value) {
        const current = state();
        save({ ...current, references: current.references.map((reference, i) => i === index ? { ...reference, [field]: value } : reference) });
    }

    function createLabel(text, control) {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.textContent = text;
        label.append(caption, control);
        return label;
    }

    function refresh() {
        const current = state();
        const supported = supportsNovelAIPreciseReference(getModel());
        container.replaceChildren();
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = current.enabled;
        enabled.addEventListener('change', () => {
            save({ ...state(), enabled: enabled.checked });
            refresh();
        });
        const toggle = createLabel('Precise Reference', enabled);
        toggle.className = 'checkbox_label nai-precise-reference-toggle';
        toggle.prepend(enabled);
        container.append(toggle);

        const note = document.createElement('small');
        note.className = 'nai-precise-reference-note';
        note.textContent = supported
            ? '5 additional Anlas per reference, per image. Not compatible with Vibe Transfer.'
            : 'Precise Reference requires NovelAI V4.5. Saved references are retained when switching models.';
        container.append(note);
        if (!current.enabled) return;

        const upload = document.createElement('input');
        upload.type = 'file';
        upload.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
        upload.multiple = true;
        upload.hidden = true;
        upload.setAttribute('aria-label', 'Add reference images');
        upload.disabled = busy || !supported;
        upload.addEventListener('change', async () => {
            const files = Array.from(upload.files || []);
            if (!files.length) return;
            const originalReferences = state().references;
            busy = true;
            error = '';
            refresh();
            try {
                if (originalReferences.length + files.length > MAX_PRECISE_REFERENCES) throw new Error('Precise Reference supports up to 16 images.');
                const prepared = [];
                let bytes = originalReferences.reduce((sum, reference) => sum + (reference.image?.length || 0) * 0.75, 0);
                for (const file of files) {
                    const image = await prepareNovelAIPreciseReference(file);
                    bytes += image.length * 0.75;
                    if (bytes > MAX_PRECISE_REFERENCE_BYTES) throw new Error('Reference images are limited to 25 MiB total. Remove a reference before adding more.');
                    prepared.push({ image, type: 'character', strength: 1, fidelity: 1 });
                }
                if (container.isConnected && state().references === originalReferences) {
                    const latest = state();
                    save({ ...latest, references: [...latest.references, ...prepared] });
                }
            } catch (cause) {
                error = cause.message;
            } finally {
                busy = false;
                refresh();
            }
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'menu_button';
        add.disabled = busy || !supported;
        add.textContent = busy ? 'Preparing references…' : 'Add reference images';
        add.addEventListener('click', () => upload.click());
        container.append(add, upload);

        const list = document.createElement('div');
        list.className = 'nai-precise-reference-list';
        current.references.forEach((reference, index) => {
            const row = document.createElement('fieldset');
            row.className = 'nai-precise-reference-row';
            const legend = document.createElement('legend');
            legend.textContent = `Reference ${index + 1}`;
            const preview = document.createElement('img');
            preview.src = `data:image/png;base64,${reference.image}`;
            preview.alt = `Reference ${index + 1}`;
            const controls = document.createElement('div');
            controls.className = 'nai-precise-reference-controls';
            const type = document.createElement('select');
            type.className = 'text_pole';
            for (const [value, text] of [['character', 'Character'], ['style', 'Style'], ['character&style', 'Character & Style']]) {
                type.add(new Option(text, value));
            }
            type.value = reference.type;
            type.addEventListener('change', () => updateReference(index, 'type', type.value));
            controls.append(createLabel('Reference type', type));
            for (const [field, text] of [['strength', 'Strength'], ['fidelity', 'Fidelity']]) {
                const range = document.createElement('input');
                range.type = 'range';
                range.min = '0';
                range.max = '1';
                range.step = '0.05';
                range.value = String(reference[field]);
                range.setAttribute('aria-label', `${text} for reference ${index + 1}`);
                const number = document.createElement('input');
                number.type = 'number';
                number.className = 'text_pole';
                number.step = 'any';
                number.value = String(reference[field]);
                const label = createLabel(text, number);
                label.className = 'nai-precise-reference-value';
                const onInput = (source, target) => {
                    const value = source.valueAsNumber;
                    if (!Number.isFinite(value) || !source.checkValidity()) return;
                    target.value = source.value;
                    updateReference(index, field, value);
                };
                range.addEventListener('input', () => onInput(range, number));
                number.addEventListener('input', () => onInput(number, range));
                number.addEventListener('change', () => { if (!number.checkValidity() || !Number.isFinite(number.valueAsNumber)) refresh(); });
                controls.append(label, range);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove reference ${index + 1}`);
            remove.disabled = busy;
            remove.addEventListener('click', () => {
                const latest = state();
                save({ ...latest, references: latest.references.filter((_, i) => i !== index) });
                refresh();
            });
            controls.append(remove);
            row.append(legend, preview, controls);
            list.append(row);
        });
        container.append(list);
        const status = document.createElement('small');
        status.setAttribute('role', error ? 'alert' : 'status');
        status.textContent = error || (current.references.length
            ? `Additional cost: ${current.references.length * 5} Anlas per image. Multiple character references blend together.`
            : 'No references selected.');
        container.append(status);
    }

    refresh();
    return { refresh };
}
