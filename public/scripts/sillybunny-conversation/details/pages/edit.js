import { createEntryRow, createTextAreaField } from '../../../sillybunny-editor/rows.js';
import { conversationData, getGroupAvatarUrl, requireView } from '../access.js';
import { createAvatar, createTiledAvatar } from '../avatars.js';
import { getPageTitle } from '../details-logic.js';
import { chooseAvatarFile, toAvatarDataUrl } from '../avatar-upload.js';
import { createGroup, createPage, el, icon } from '../page-kit.js';

/** The picture of Fractal's room edit page: 128 pixels, Edit at the bottom end, Remove at the top end. */
function createEditableAvatar({ view, name, getStaged, onChoose, onRemove }) {
    const wrap = el('div', 'sb-details-editable-avatar');
    const edit = el('button', 'sb-details-editable-avatar__button sb-details-editable-avatar__edit');
    edit.type = 'button';
    edit.title = 'Select New Picture';
    edit.setAttribute('aria-label', 'Select New Picture');
    edit.append(icon('pencil'));
    const remove = el('button', 'sb-details-editable-avatar__button sb-details-editable-avatar__remove');
    remove.type = 'button';
    remove.title = 'Remove Picture';
    remove.setAttribute('aria-label', 'Remove Picture');
    remove.append(icon('xmark'));

    const draw = () => {
        const staged = getStaged();
        const hasPicture = staged === undefined ? Boolean(view.avatar) : staged !== null;
        wrap.querySelector(':scope > .sb-details-avatar')?.remove();
        let picture;
        if (staged) {
            picture = createAvatar({ name, src: staged, size: 128 });
        } else if (staged === undefined && view.avatar) {
            picture = createAvatar({ name, src: getGroupAvatarUrl(view), size: 128 });
        } else {
            picture = createTiledAvatar({ name, avatars: view.characters, size: 128 });
        }
        wrap.prepend(picture);
        remove.disabled = !hasPicture;
    };
    edit.addEventListener('click', async () => {
        const file = await chooseAvatarFile();
        if (!file) {
            return;
        }
        try {
            onChoose(await toAvatarDataUrl(file));
        } catch (error) {
            globalThis.toastr?.error?.(error.message);
        }
        draw();
    });
    remove.addEventListener('click', () => {
        onRemove();
        draw();
        edit.focus();
    });
    wrap.append(edit, remove);
    draw();
    return wrap;
}

/** The name, the description and the picture of a group. Nothing is saved until Save; Cancel leaves the group as it was. */
export function buildEdit({ conversationId }) {
    const view = requireView(conversationId);
    if (view.kind !== 'group') {
        throw new Error('Only a group has details of its own to edit.');
    }
    const { page, clamp } = createPage('sb-details-page--edit');
    const draft = { name: view.name, description: view.description ?? '' };
    // undefined keeps the picture, null removes it, and a data URL replaces it.
    let stagedPicture;

    const hero = el('div', 'sb-details-hero');
    hero.append(createEditableAvatar({
        view,
        name: view.name || 'Group',
        getStaged: () => stagedPicture,
        onChoose: (dataUrl) => { stagedPicture = dataUrl; },
        onRemove: () => { stagedPicture = view.avatar ? null : undefined; },
    }));
    const name = createEntryRow({ label: 'Name', field: 'group-name', floating: true, value: draft.name, onInput: (value) => { draft.name = value; } });
    const description = createTextAreaField({
        label: 'Description',
        field: 'group-description',
        value: draft.description,
        rows: 4,
        expand: false,
        onInput: (value) => { draft.description = value; },
    });
    clamp.append(
        hero,
        createGroup({ label: 'Name', rows: [name], field: 'edit-name' }).section,
        createGroup({ label: 'Description', rows: [description], field: 'edit-description' }).section,
    );

    return {
        title: getPageTitle('edit'),
        content: page,
        responses: { cancel: {}, affirmative: { id: 'save', label: 'Save' } },
        async onResponse() {
            const patch = {};
            if (draft.name.trim() && draft.name.trim() !== view.name) {
                patch.name = draft.name.trim();
            }
            if (draft.description.trim() !== (view.description ?? '')) {
                patch.description = draft.description.trim();
            }
            try {
                if (Object.keys(patch).length) {
                    conversationData.patchConversation(conversationId, patch);
                }
                if (typeof stagedPicture === 'string') {
                    await conversationData.setGroupAvatar(conversationId, stagedPicture);
                } else if (stagedPicture === null) {
                    await conversationData.removeGroupAvatar(conversationId);
                }
            } catch (error) {
                console.error('Conversation Mode: the details of the group could not be saved', error);
                globalThis.toastr?.error?.('The details could not be saved');
            }
        },
    };
}
