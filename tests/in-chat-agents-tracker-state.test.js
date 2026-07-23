import { describe, expect, test } from '@jest/globals';

import {
    findTrackerBlocks,
    getTrackerRepairPayload,
    inspectTrackerState,
    mergeTrackerRepairPayload,
    normalizeCompanionTrackerRepairPayload,
} from '../public/scripts/extensions/in-chat-agents/tracker-state.js';

const statusAgent = {
    prompt: '[STATUS|Character|Condition|Severity]\nnote\n[/STATUS]',
    postProcess: {
        extractPattern: '\\[STATUS\\|[^\\]]*\\][\\s\\S]*?\\[/STATUS\\]',
        extractVariable: 'status_data',
    },
};

describe('in-chat agent tracker state', () => {
    test('uses complete structural blocks when a configured pattern is stale', () => {
        const agent = {
            ...statusAgent,
            postProcess: {
                ...statusAgent.postProcess,
                extractPattern: '\\\\[STATUS\\\\|[^\\\\]]*\\\\]',
            },
        };
        const text = 'Story\n\n[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]';

        expect(inspectTrackerState(agent, text)).toEqual(expect.objectContaining({
            status: 'valid',
            value: '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]',
            tag: 'STATUS',
        }));
    });

    test('requires the expected closer instead of accepting a header match', () => {
        const text = 'Story\n\n[STATUS|Alice|Tired|Moderate]\nnote: Long day';
        const inspection = inspectTrackerState(statusAgent, text);

        expect(inspection.status).toBe('malformed');
        expect(inspection.value).toBe('');
        expect(inspection.blocks).toEqual([
            expect.objectContaining({ complete: false, replaceable: false }),
        ]);
    });

    test('normalizes a single malformed Companion card closer without relaxing message repair', () => {
        const malformedCloser = '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n/STATUS]';
        const missingCloser = '[STATUS|Alice|Tired|Moderate]\nnote: Long day';

        expect(normalizeCompanionTrackerRepairPayload(statusAgent, malformedCloser).payload)
            .toBe('[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]');
        expect(normalizeCompanionTrackerRepairPayload(statusAgent, missingCloser).payload)
            .toBe('[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]');
        expect(normalizeCompanionTrackerRepairPayload(statusAgent, `Story\n${missingCloser}`).payload).toBe('');
        expect(mergeTrackerRepairPayload(statusAgent, `Story\n${missingCloser}`, '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'unsafe-malformed' }));
    });

    test('rejects incomplete openers and mixed complete and malformed blocks', () => {
        const incompleteOpener = '[STATUS|Alice|Tired|Moderate\nnote: Long day\n[/STATUS]';
        const mixed = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]\n[STATUS|Bob|Broken|Severe]';

        expect(inspectTrackerState(statusAgent, incompleteOpener).status).toBe('malformed');
        expect(inspectTrackerState(statusAgent, mixed)).toEqual(expect.objectContaining({
            status: 'malformed',
            value: '',
        }));
        expect(mergeTrackerRepairPayload(statusAgent, 'Story', mixed))
            .toEqual(expect.objectContaining({ changed: false, reason: 'invalid-payload' }));
    });

    test('rejects unmatched closing tags instead of appending beside malformed markup', () => {
        const strayCloser = 'Story\n[/STATUS]';
        const mixed = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]\n[/STATUS]';
        const repaired = '[STATUS|Alice|Ready|Mild]\nrepaired\n[/STATUS]';

        expect(inspectTrackerState(statusAgent, strayCloser).status).toBe('malformed');
        expect(inspectTrackerState(statusAgent, mixed).status).toBe('malformed');
        expect(mergeTrackerRepairPayload(statusAgent, strayCloser, repaired))
            .toEqual(expect.objectContaining({ text: strayCloser, changed: false, reason: 'unsafe-malformed' }));
    });

    test('uses configured extraction for custom non-bracket trackers', () => {
        const agent = {
            prompt: 'Return one STATE line.',
            postProcess: {
                extractPattern: 'STATE: [^\\n]+',
                extractVariable: 'custom_state',
            },
        };

        expect(inspectTrackerState(agent, 'Story\nSTATE: ready')).toEqual(expect.objectContaining({
            status: 'valid',
            value: 'STATE: ready',
            tag: '',
        }));
        expect(mergeTrackerRepairPayload(agent, 'Story', 'STATE: ready').text).toBe('Story\n\nSTATE: ready');

        expect(inspectTrackerState(agent, 'STATE: ready\n[STATUS|Alice|Tired|Moderate]\nnote\n[/STATUS]')).toEqual(expect.objectContaining({
            status: 'valid',
            value: 'STATE: ready',
            tag: '',
        }));
    });

    test('collects repeated NPC variants with their shared closer', () => {
        const agent = {
            prompt: '[NPC:MAJOR|Name]\n...\n[/NPC]',
            postProcess: {
                extractPattern: '\\[NPC(?::(?:MAJOR|SUPPORT|MINOR|UP|REF|REL))?\\|[^\\]]+\\][\\s\\S]*?\\[/NPC\\]',
            },
        };
        const text = '[NPC:REF|Ava|red scarf|wary][/NPC]\n[NPC:REL|Bo|trust increased][/NPC]';

        const inspection = inspectTrackerState(agent, text);
        expect(inspection.status).toBe('valid');
        expect(inspection.payloads).toEqual([
            '[NPC:REF|Ava|red scarf|wary][/NPC]',
            '[NPC:REL|Bo|trust increased][/NPC]',
        ]);
        expect(findTrackerBlocks(text, 'NPC')).toHaveLength(2);
    });

    test('replaces all existing blocks atomically while preserving prose', () => {
        const original = 'Before\n[STATUS|A|Old|Mild]\none\n[/STATUS]\nBetween\n[STATUS|B|Old|Mild]\ntwo\n[/STATUS]\nAfter';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';
        const result = mergeTrackerRepairPayload(statusAgent, original, repaired);

        expect(result).toEqual(expect.objectContaining({ changed: true, replaced: true, reason: '' }));
        expect(result.text).toBe(`Before\n${repaired}\nBetween\n\nAfter`);
    });

    test('refuses to replace an unclosed trailing block with an ambiguous suffix', () => {
        const original = 'Story remains.\n\n[STATUS|A|Broken|Severe]\nnote: missing closer';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';

        expect(mergeTrackerRepairPayload(statusAgent, original, repaired))
            .toEqual(expect.objectContaining({ text: original, changed: false, reason: 'unsafe-malformed' }));
    });

    test('refuses to replace an unbounded leading malformed block and following prose', () => {
        const original = '[STATUS|A|Broken|Severe]\nnote: missing closer\nNarrative that must remain.';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';

        expect(mergeTrackerRepairPayload(statusAgent, original, repaired))
            .toEqual(expect.objectContaining({ text: original, changed: false, reason: 'unsafe-malformed' }));
    });

    test('refuses ambiguous malformed spans and invalid generated payloads', () => {
        const ambiguous = '[STATUS|A|Broken|Severe]\nprose\n[STATUS|B|Broken|Severe]';

        expect(mergeTrackerRepairPayload(statusAgent, ambiguous, '[STATUS|A|Ready|Mild]\nnote\n[/STATUS]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'unsafe-malformed' }));
        expect(mergeTrackerRepairPayload(statusAgent, 'Story', '[STATUS|still broken]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'invalid-payload' }));
    });

    test('appends a missing valid payload without changing the source prose', () => {
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';
        const result = mergeTrackerRepairPayload(statusAgent, 'Story remains.', repaired);

        expect(result.text).toBe(`Story remains.\n\n${repaired}`);
        expect(getTrackerRepairPayload(statusAgent, result.text).payload).toBe(repaired);
    });
});
