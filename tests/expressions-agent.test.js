import { normalizeAgentExpressionLabel } from '../public/scripts/extensions/expressions/expressions-agent-utils.js';

describe('expressions agent bridge', () => {
    describe('normalizeAgentExpressionLabel', () => {
        test('returns exact labels from the allowed list', () => {
            expect(normalizeAgentExpressionLabel('joy', ['joy', 'anger'])).toBe('joy');
            expect(normalizeAgentExpressionLabel('ANGER', ['joy', 'anger'])).toBe('anger');
        });

        test('strips markdown, quotes and punctuation', () => {
            expect(normalizeAgentExpressionLabel('**joy**', ['joy', 'anger'])).toBe('joy');
            expect(normalizeAgentExpressionLabel('"surprise"', ['joy', 'surprise'])).toBe('surprise');
            expect(normalizeAgentExpressionLabel('joy.', ['joy', 'anger'])).toBe('joy');
        });

        test('only uses the first word of multi-word output', () => {
            expect(normalizeAgentExpressionLabel('joyful expression', ['joy', 'anger'])).toBe('joy');
        });

        test('returns null for unknown labels', () => {
            expect(normalizeAgentExpressionLabel('furious', ['joy', 'anger'])).toBeNull();
        });

        test('allows prefix matches for numbered variants', () => {
            expect(normalizeAgentExpressionLabel('desire1', ['joy', 'desire'])).toBe('desire');
        });

        test('returns null for empty or whitespace input', () => {
            expect(normalizeAgentExpressionLabel('', ['joy'])).toBeNull();
            expect(normalizeAgentExpressionLabel('   ', ['joy'])).toBeNull();
        });
    });
});
