import { getContext } from './shared.js';

async function pickGroupMember() {
    const context = getContext();
    const group = context.groups?.find(group => group.id === context.groupId);
    const characters = context.characters ?? [];
    const members = (group?.members ?? []).flatMap((avatar, index) => {
        const character = characters.find(character => character.avatar === avatar);
        return character ? [{ avatar, index, name: character.name || avatar }] : [];
    });
    if (members.length === 0) {
        return null;
    }

    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn';
    content.textContent = 'Select member to respond as';
    const list = document.createElement('div');
    list.className = 'scrollable-buttons-container flex-container flexFlowColumn wide100p';
    list.style.overflowY = 'auto';
    for (const member of members) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button wide100p result-control';
        button.textContent = member.name;
        button.dataset.result = String(member.index + 2);
        list.append(button);
    }
    content.append(list);

    const result = await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: 'Cancel',
        allowVerticalScrolling: true,
    });
    const member = members.find(member => member.index + 2 === result);
    const currentContext = getContext();
    const currentGroup = currentContext.groups?.find(group => group.id === currentContext.groupId);
    if (!member || currentContext.chatId !== context.chatId || currentContext.groupId !== context.groupId) {
        return null;
    }

    // /trigger parses numbers as group positions, not global character IDs.
    const index = currentGroup?.members?.indexOf(member.avatar) ?? -1;
    return index >= 0 ? String(index) : null;
}

export { pickGroupMember };
