import { describe, expect, test } from '@jest/globals';

import {
    getCharacterDefinitionFormValues,
    getSuspiciousEmptyCharacterDefinitionSave,
} from '../public/scripts/character-save-guard.js';
import { getSuspiciousEmptyCharacterDefinitionFields } from '../src/character-save-guard.js';

describe('character save guard', () => {
    test('does not warn for ordinary edits or single-field clears', () => {
        const character = {
            description: 'Existing description',
            personality: 'Existing personality',
            scenario: 'Existing scenario',
        };

        expect(getSuspiciousEmptyCharacterDefinitionSave(character, {
            description: 'Updated description',
            personality: 'Existing personality',
            scenario: 'Existing scenario',
        })).toBeNull();

        expect(getSuspiciousEmptyCharacterDefinitionSave(character, {
            description: '',
            personality: 'Existing personality',
            scenario: 'Existing scenario',
        })).toBeNull();
    });

    test('warns when previously populated definition fields are submitted empty', () => {
        const character = {
            description: 'Existing description',
            personality: 'Existing personality',
            scenario: 'Existing scenario',
            first_mes: 'Hello',
            mes_example: '<START>',
        };

        const warning = getSuspiciousEmptyCharacterDefinitionSave(character, {
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
        });

        expect(warning).toEqual({
            emptiedFieldNames: ['description', 'personality', 'scenario', 'first_mes', 'mes_example'],
            emptiedFieldLabels: ['Description', 'Personality', 'Scenario', 'First message', 'Example messages'],
        });
    });

    test('warns when three or more populated definition fields are cleared together', () => {
        const warning = getSuspiciousEmptyCharacterDefinitionSave({
            description: 'Existing description',
            personality: 'Existing personality',
            scenario: 'Existing scenario',
            first_mes: 'Hello',
        }, {
            description: '',
            personality: '',
            scenario: '',
            first_mes: 'Hello',
        });

        expect(warning?.emptiedFieldNames).toEqual(['description', 'personality', 'scenario']);
    });

    test('extracts watched fields from submitted form data', () => {
        const formData = new FormData();
        formData.set('description', 'Description');
        formData.set('personality', 'Personality');
        formData.set('scenario', 'Scenario');
        formData.set('first_mes', 'Hello');
        formData.set('mes_example', '<START>');

        expect(getCharacterDefinitionFormValues(formData)).toEqual({
            description: 'Description',
            personality: 'Personality',
            scenario: 'Scenario',
            first_mes: 'Hello',
            mes_example: '<START>',
        });
    });

    test('server guard reads current character card fields before overwrite', () => {
        const fields = getSuspiciousEmptyCharacterDefinitionFields({
            data: {
                description: 'Existing description',
                personality: 'Existing personality',
                scenario: 'Existing scenario',
            },
        }, {
            description: '',
            personality: '',
            scenario: '',
        });

        expect(fields.map(field => field.name)).toEqual(['description', 'personality', 'scenario']);
    });
});
