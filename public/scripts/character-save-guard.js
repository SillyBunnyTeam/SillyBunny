export const CHARACTER_DEFINITION_SAVE_FIELDS = [
    { formName: 'description', characterKey: 'description', label: 'Description' },
    { formName: 'personality', characterKey: 'personality', label: 'Personality' },
    { formName: 'scenario', characterKey: 'scenario', label: 'Scenario' },
    { formName: 'first_mes', characterKey: 'first_mes', label: 'First message' },
    { formName: 'mes_example', characterKey: 'mes_example', label: 'Example messages' },
];

function hasMeaningfulText(value) {
    return String(value ?? '').trim().length > 0;
}

export function getCharacterDefinitionFormValues(formData) {
    return Object.fromEntries(CHARACTER_DEFINITION_SAVE_FIELDS.map(field => [field.formName, formData.get(field.formName)]));
}

export function getSuspiciousEmptyCharacterDefinitionSave(character, submittedValues) {
    if (!character || typeof character !== 'object' || !submittedValues || typeof submittedValues !== 'object') {
        return null;
    }

    const populatedFields = CHARACTER_DEFINITION_SAVE_FIELDS.filter(field => hasMeaningfulText(character[field.characterKey]));
    const emptiedFields = populatedFields.filter(field => !hasMeaningfulText(submittedValues[field.formName]));

    if (populatedFields.length < 2 || emptiedFields.length < 2) {
        return null;
    }

    if (emptiedFields.length !== populatedFields.length && emptiedFields.length < 3) {
        return null;
    }

    return {
        emptiedFieldNames: emptiedFields.map(field => field.formName),
        emptiedFieldLabels: emptiedFields.map(field => field.label),
    };
}
