import { createButtonRow } from '../../../sillybunny-editor/rows.js';
import { createToggleRow } from '../../../sillybunny-editor/toggle-row.js';
import { conversationData, describeCharacterStatus, getCardName, getFullPictureUrl, requireView, writeSetting } from '../access.js';
import { createConversationAvatar } from '../avatars.js';
import { collectSharedItems, getGeneralSignature, getPageTitle, listsMembersInline } from '../details-logic.js';
import { createGroup, createNavRow, createPage, createPillButton, el, watchConversation } from '../page-kit.js';
import { createPersonRow } from './people.js';

function getHeading(view) {
    return view.kind === 'direct' ? getCardName(view.characters[0]) : (view.name || 'Group');
}

function getSubtitle(view) {
    return view.kind === 'direct' ? describeCharacterStatus(view.characters[0]).line : view.description;
}

function createHero(view, nav) {
    const hero = el('div', 'sb-details-hero');
    const picture = createConversationAvatar(view, { size: 128, name: getHeading(view) });
    if (view.kind === 'direct') {
        const label = `Show Full Picture for ${getHeading(view)}`;
        const button = el('button', 'sb-details-hero__avatar-button');
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.append(picture);
        button.addEventListener('click', () => nav.viewPicture({ title: getHeading(view), src: getFullPictureUrl(view.characters[0]), alt: getHeading(view) }));
        hero.append(button);
    } else {
        hero.append(picture);
    }
    // Level 4: the theme boxes every h3 outside a dialog and the chat, and the page is under the dialog's own h2.
    hero.append(el('h4', 'sb-details-hero__name', getHeading(view)));
    const subtitle = getSubtitle(view);
    if (subtitle) {
        hero.append(el('p', 'sb-details-hero__subtitle', subtitle));
    }
    if (view.kind === 'group') {
        hero.append(createPillButton('Edit Details', { suggested: false, onClick: () => nav.push('edit') }));
    }
    return hero;
}

function createPeopleGroup(view, nav) {
    if (!listsMembersInline(view)) {
        return null;
    }
    const rows = view.characters.map(avatar => createPersonRow({ conversationId: view.id, avatar, kind: 'member', nav }));
    rows.push(createButtonRow({ label: 'Add Member', icon: 'user-plus', field: 'add-member', arrow: true, onActivate: () => nav.push('add-member') }));
    return createGroup({ title: 'Members', rows, field: 'members' });
}

function createPageLinks(view, nav) {
    const rows = [];
    if (view.kind === 'direct') {
        rows.push(createNavRow({ label: 'Profile', field: 'profile', onActivate: () => nav.push('profile', { avatar: view.characters[0] }) }));
    }
    if (view.kind === 'group' && !listsMembersInline(view)) {
        rows.push(createNavRow({ label: 'Members', count: view.characters.length, field: 'members', onActivate: () => nav.push('members') }));
    }
    if (view.kind === 'direct' && view.extras.length) {
        rows.push(createNavRow({ label: 'Extras', count: view.extras.length, field: 'extras', onActivate: () => nav.push('members') }));
    }
    rows.push(createNavRow({ label: 'Chats', count: view.chats.length, field: 'chats', onActivate: () => nav.push('chats') }));
    const shared = [
        createNavRow({ label: 'Media', count: '', field: 'media', onActivate: () => nav.push('media') }),
        createNavRow({ label: 'Files', count: '', field: 'files', onActivate: () => nav.push('files') }),
        createNavRow({ label: 'Pinned', count: '', field: 'pinned', onActivate: () => nav.push('pinned') }),
    ];
    return {
        groups: [
            createGroup({ label: 'People and chats', rows, field: 'people-and-chats' }),
            createGroup({ label: 'Shared in this conversation', rows: shared, field: 'shared' }),
        ],
        sharedRows: { media: shared[0], files: shared[1], pinned: shared[2] },
    };
}

/** The count of the Media, Files and Pinned pages is of the open chat, and appears once that chat is loaded. */
async function fillSharedCounts(conversationId, rows) {
    const view = conversationData.get(conversationId);
    if (!view?.activeChatId) {
        return;
    }
    const address = { conversationId, chatId: view.activeChatId };
    let loaded = conversationData.chat(address);
    if (!loaded) {
        try {
            loaded = await conversationData.loadChat(address);
        } catch {
            return;
        }
    }
    const shared = collectSharedItems(loaded?.messages);
    // A row of an earlier draw is no longer on the page, and writing to it does no harm.
    for (const [name, row] of Object.entries(rows)) {
        const count = row.row.querySelector('[data-sb-details-count]');
        if (count) {
            count.textContent = String(shared[name].length);
        }
    }
}

export function buildGeneral({ conversationId, nav }) {
    requireView(conversationId);
    const { page, clamp } = createPage('sb-details-page--general');
    let notifications = null;
    let sharedRows = {};

    const draw = () => {
        const view = requireView(conversationId);
        notifications = createToggleRow({
            label: 'Notifications',
            field: 'notifications-muted',
            choices: [[false, 'All'], [true, 'Muted']],
            value: view.settings?.notifications_muted === true,
            onChange: muted => writeSetting(requireView(conversationId), 'notifications_muted', muted),
        });
        const links = createPageLinks(view, nav);
        clamp.replaceChildren(
            createHero(view, nav),
            ...[createPeopleGroup(view, nav)].filter(Boolean).map(group => group.section),
            ...links.groups.map(group => group.section),
            createGroup({ label: 'Notifications', rows: [notifications], field: 'notifications' }).section,
            createGroup({
                label: 'Conversation settings',
                rows: [
                    createNavRow({ label: 'Behaviour', field: 'behaviour', onActivate: () => nav.push('behaviour') }),
                    createNavRow({ label: 'Advanced', field: 'advanced', onActivate: () => nav.push('advanced') }),
                ],
                field: 'settings-pages',
            }).section,
        );
        sharedRows = links.sharedRows;
        void fillSharedCounts(conversationId, sharedRows);
    };
    draw();

    const stopDrawing = watchConversation(conversationId, getGeneralSignature, { onChange: draw, onGone: () => nav.gone() });
    const stopNotifications = watchConversation(conversationId, view => String(view.settings?.notifications_muted === true), {
        onChange: view => notifications?.setValue(view.settings?.notifications_muted === true),
    });
    // A pin or a new picture changes what the pages under Shared hold while this page is covered by one of them.
    const stopCounts = conversationData.subscribe((event) => {
        if (event.type === 'chat' && event.address?.conversationId === conversationId) {
            void fillSharedCounts(conversationId, sharedRows);
        }
    });
    return {
        title: getPageTitle('general'),
        content: page,
        dispose() {
            stopDrawing();
            stopNotifications();
            stopCounts();
        },
    };
}
