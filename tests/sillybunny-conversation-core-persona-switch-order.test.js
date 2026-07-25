import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let activePersonaId = 'persona-a.png';
const order = [];
const setUserAvatar = jest.fn(async (personaId) => {
    order.push(`set:${personaId}`);
    activePersonaId = personaId;
});

await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ setUserAvatar }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationPersonaId: value => String(typeof value === 'undefined' ? activePersonaId : value || ''),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-panel.js', () => ({
    closeConversationSettings: () => order.push('close'),
}));

const { switchConversationPersona } = await import('../public/scripts/sillybunny-conversation/persona-switch.js');

describe('Conversation persona switch ordering', () => {
    beforeEach(() => {
        activePersonaId = 'persona-a.png';
        order.length = 0;
        setUserAvatar.mockClear();
    });

    test('closes and saves the Conversation drawer before changing persona', async () => {
        await expect(switchConversationPersona('persona-b.png')).resolves.toBe(true);
        expect(order).toEqual(['close', 'set:persona-b.png']);
    });

    test('still closes the drawer before a no-op persona selection', async () => {
        await expect(switchConversationPersona('persona-a.png')).resolves.toBe(true);
        expect(order).toEqual(['close']);
        expect(setUserAvatar).not.toHaveBeenCalled();
    });
});
