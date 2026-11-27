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

const { switchConversationPersona } = await import('../public/scripts/sillybunny-conversation/persona-switch.js');

describe('Conversation persona switch', () => {
    beforeEach(() => {
        activePersonaId = 'persona-a.png';
        order.length = 0;
        setUserAvatar.mockClear();
    });

    test('changes the persona and answers that it is the active one', async () => {
        await expect(switchConversationPersona('persona-b.png')).resolves.toBe(true);
        expect(order).toEqual(['set:persona-b.png']);
    });

    test('leaves the persona alone when it is the active one already', async () => {
        await expect(switchConversationPersona('persona-a.png')).resolves.toBe(true);
        expect(setUserAvatar).not.toHaveBeenCalled();
    });

    test('refuses an empty persona', async () => {
        await expect(switchConversationPersona('')).resolves.toBe(false);
        expect(setUserAvatar).not.toHaveBeenCalled();
    });
});
