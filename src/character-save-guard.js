export const CHARACTER_DEFINITION_SAVE_FIELDS = [
    { name: 'description', label: 'Description' },
    { name: 'personality', label: 'Personality' },
    { name: 'scenario', label: 'Scenario' },
    { name: 'first_mes', label: 'First message' },
    { name: 'mes_example', label: 'Example messages' },
];

function hasMeaningfulDefinitionText(value) {
    return String(value ?? '').trim().length > 0;
}

function getStoredDefinitionValue(character, fieldName) {
    return character?.[fieldName] ?? character?.data?.[fieldName];
}

export function getSuspiciousEmptyCharacterDefinitionFields(currentCharacter, submittedData) {
    if (!currentCharacter || typeof currentCharacter !== 'object' || !submittedData || typeof submittedData !== 'object') {
        return [];
    }

    const populatedFields = CHARACTER_DEFINITION_SAVE_FIELDS.filter(field => hasMeaningfulDefinitionText(getStoredDefinitionValue(currentCharacter, field.name)));
    const emptiedFields = populatedFields.filter(field => !hasMeaningfulDefinitionText(submittedData[field.name]));

    if (populatedFields.length < 2 || emptiedFields.length < 2) {
        return [];
    }

    if (emptiedFields.length !== populatedFields.length && emptiedFields.length < 3) {
        return [];
    }

    return emptiedFields;
}
