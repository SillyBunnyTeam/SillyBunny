/**
 * The `characters` array of the page, with the calls of a `Map` that the conversation tests use to add and remove a
 * character. `getCharacterForAvatar()` of `context.js` reads the array, so a test mocks `script.js` with `characters`.
 */
export function createCharacterRoster() {
    const characters = [];
    return {
        characters,
        get: avatar => characters.find(character => character.avatar === avatar),
        set(avatar, character) {
            this.delete(avatar);
            characters.push(character);
        },
        delete(avatar) {
            const index = characters.findIndex(character => character.avatar === avatar);
            if (index >= 0) {
                characters.splice(index, 1);
            }
        },
        clear() {
            characters.length = 0;
        },
    };
}
