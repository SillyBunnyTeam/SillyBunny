import { describe, expect, jest, test } from '@jest/globals';

const accountStorageValues = new Map([
    ['pathfinder-summary-memory-state', JSON.stringify({
        title: 'Existing summary',
        content: 'Stored content',
        significance: 'Stored significance',
        arc: 'Stored arc',
        bookName: 'Stored book',
        uid: 42,
        updatedAt: 100,
        injectedAt: 90,
        injectedMode: 'auto',
    })],
]);
const accountStorage = {
    getItem: jest.fn(key => accountStorageValues.get(key) ?? null),
    setItem: jest.fn((key, value) => accountStorageValues.set(key, String(value))),
};

await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage,
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js', () => ({
    updateEntry: jest.fn(async () => {}),
}));

const {
    getSummaryMemoryState,
    setSummaryMemoryCreated,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');

describe('Pathfinder summary memory account storage', () => {
    test('loads and persists the existing key with the same serialized state shape', () => {
        expect(getSummaryMemoryState()).toEqual({
            title: 'Existing summary',
            content: 'Stored content',
            significance: 'Stored significance',
            arc: 'Stored arc',
            bookName: 'Stored book',
            uid: 42,
            updatedAt: 100,
            injectedAt: 90,
            injectedMode: 'auto',
        });

        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(500);
        try {
            setSummaryMemoryCreated({
                title: 'New summary',
                content: 'Significance: Important\n\nNew content',
                significance: 'Important',
                arc: 'New arc',
                bookName: 'New book',
                uid: 7,
            });
        } finally {
            nowSpy.mockRestore();
        }

        expect(accountStorage.setItem).toHaveBeenCalledWith(
            'pathfinder-summary-memory-state',
            JSON.stringify({
                title: 'New summary',
                content: 'New content',
                significance: 'Important',
                arc: 'New arc',
                bookName: 'New book',
                uid: 7,
                updatedAt: 500,
                injectedAt: 0,
                injectedMode: '',
            }),
        );
    });
});
