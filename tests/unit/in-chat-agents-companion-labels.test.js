/* eslint-disable playwright/no-standalone-expect -- Jest label contracts do not use a browser. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { companionLabels, companionSummary } = await import('../../public/scripts/extensions/in-chat-agents/ui/companion-labels.js');

describe('companion editor and overview labels', () => {
    const config = { trigger: 'auto', displayMode: 'panel', format: 'markdown' };
    test.each([
        ['trigger', 'auto', 'Auto'], ['trigger', 'manual', 'Manual'],
        ['displayMode', 'card', 'Note card'], ['displayMode', 'panel', 'Tracker panel only'],
        ['displayMode', 'hidden', 'Hidden feedback note'],
        ['format', 'markdown', 'Markdown'], ['format', 'html', 'HTML'], ['format', 'text', 'Text'],
    ])('%s %s uses the editor label', (key, value, label) => {
        expect(companionLabels()[key]).toContainEqual([value, label]);
        expect(companionSummary({ ...config, [key]: value }, true).split(' · ')).toContain(label);
    });
    test.each(['trigger', 'displayMode', 'format'])('unknown %s falls back to raw, not another option', key => {
        expect(companionSummary({ ...config, [key]: 'future-value' }, false)).toContain('future-value');
    });
    test('optional batching and feedback reuse the editor labels only when enabled', () => {
        expect(companionSummary(config, true)).toBe('On · Auto · Tracker panel only · Markdown');
        expect(companionSummary({ ...config, batch: true, feedback: { enabled: true, depth: 3 } }, false))
            .toBe('Off · Auto · Tracker panel only · Markdown · Batch · Feed Recent Notes ×3');
    });
});
