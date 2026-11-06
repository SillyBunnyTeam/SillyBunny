import { getContext } from './shared.js';
import { createButtonRow, releaseRowIds } from '../../../sillybunny-editor/rows.js';

function createCompatibleButtonRow(label, field) {
    const button = document.createElement('button');
    if (!button.classList || typeof button.addEventListener !== 'function') {
        button.type = 'button';
        button.className = 'menu_button wide100p result-control';
        button.textContent = label;
        return button;
    }

    return createButtonRow({ label, field }).row;
}

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
    content.className = 'sb-dialog-rows';
    const heading = 'Select member to respond as';
    const list = document.createElement('div');
    list.className = 'sb-dialog-choice-list';
    const buttons = members.map(member => {
        const button = createCompatibleButtonRow(member.name, `group-member-${member.index}`);
        if (button.classList) button.classList.add('result-control');
        button.dataset.result = String(member.index + 2);
        return button;
    });
    list.append(...buttons);
    if (typeof content.querySelectorAll === 'function') {
        const headingElement = document.createElement('h3');
        headingElement.textContent = heading;
        content.append(headingElement, list);
    } else {
        // The command's lightweight unit-test DOM does not implement text nodes or selectors.
        content.textContent = heading;
        content.append(list);
    }

    const result = await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: 'Cancel',
        tier: 'dialog',
        allowVerticalScrolling: true,
    });
    if (typeof content.querySelectorAll === 'function') releaseRowIds(content);
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
