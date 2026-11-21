import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecordedReference, readReferenceLine } from '../../scripts/check-design-reference.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the reference that the design documents record', () => {
    test('DESIGN.md names a libadwaita release and a commit of the HIG', () => {
        const recorded = parseRecordedReference(readReferenceLine(repoRoot));

        expect(recorded.libadwaita).toMatch(/^\d+\.\d+\.\d+$/);
        expect(recorded.higCommit).toMatch(/^[0-9a-f]{7,40}$/);
    });

    test('DESIGN.json records the same reference as DESIGN.md', () => {
        const json = JSON.parse(fs.readFileSync(path.join(repoRoot, 'DESIGN.json'), 'utf8'));

        expect(parseRecordedReference(json.narrative.referenceVersion)).toEqual(parseRecordedReference(readReferenceLine(repoRoot)));
    });
});
