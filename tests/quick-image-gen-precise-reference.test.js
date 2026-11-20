import { describe, expect, test } from '@jest/globals';
import { captureRegenerationReferences, RegenerationReferenceStore } from '../public/scripts/extensions/quick-image-gen/lib/generation-semantics.js';
import { snapshotGenerationRunSettings } from '../public/scripts/extensions/quick-image-gen/lib/generation-run.js';
import { getCharacterProviderReferences, setCharacterProviderReferences } from '../public/scripts/extensions/quick-image-gen/lib/client-orchestration.js';
import { createSettingsExport, mergePreservingPrivateFields } from '../public/scripts/extensions/quick-image-gen/lib/settings-transfer.js';
import { createEffectiveRequest, sanitizeEffectiveRequest } from '../public/scripts/extensions/quick-image-gen/lib/provider-contract.js';

function settings(enabled = true) {
    return {
        provider: 'novelai',
        naiModel: 'nai-diffusion-4-5-full',
        naiPreciseReference: {
            enabled,
            references: [{ image: 'PRIVATE_REFERENCE_BYTES', type: 'character', strength: 0.8, fidelity: 0.6 }],
        },
    };
}

const entry = { id: 'result-1', provider: 'novelai', sourceChatId: 'chat-1' };

describe('QIG precise reference ownership', () => {
    test('generation and regeneration retain original image and controls across settings edits', () => {
        const live = settings();
        const run = snapshotGenerationRunSettings(live);
        const store = new RegenerationReferenceStore();
        store.remember(entry, captureRegenerationReferences(run), { scopeId: 'chat-1' });
        live.naiPreciseReference.references[0].image = 'NEW_IMAGE';
        live.naiPreciseReference.references[0].strength = 0.1;
        live.naiPreciseReference.enabled = false;
        expect(run.naiPreciseReference).toEqual(settings().naiPreciseReference);
        const original = store.lookup(entry, { scopeId: 'chat-1' }).references.settings.naiPreciseReference;
        expect(original).toEqual(settings().naiPreciseReference);
        original.references[0].fidelity = 0;
        expect(store.lookup(entry, { scopeId: 'chat-1' }).references.settings.naiPreciseReference.references[0].fidelity).toBe(0.6);
        expect(store.lookup(entry, { scopeId: 'other-chat' }).found).toBe(false);
    });

    test('counts nested image bytes toward regeneration retention limits', () => {
        const source = settings();
        const imageLength = source.naiPreciseReference.references[0].image.length;
        const bounded = new RegenerationReferenceStore({ maxReferenceChars: imageLength - 1 });
        expect(bounded.remember(entry, captureRegenerationReferences(source))).toEqual({ remembered: true, referencesRetained: false });
        expect(bounded.lookup(entry).references).toBeNull();
        const exact = new RegenerationReferenceStore({ maxReferenceChars: imageLength });
        expect(exact.remember(entry, captureRegenerationReferences(source)).referencesRetained).toBe(true);
    });

    test('disabled regeneration does not retain or resurrect saved image payloads', () => {
        const store = new RegenerationReferenceStore({ maxReferenceChars: 0 });
        expect(store.remember(entry, captureRegenerationReferences(settings(false))).referencesRetained).toBe(true);
        expect(store.lookup(entry).references.settings.naiPreciseReference).toEqual({ enabled: false, references: [] });
    });

    test('character references preserve disabled state and are isolated from other providers and callers', () => {
        const source = settings(false).naiPreciseReference;
        const record = setCharacterProviderReferences({ proxyRefImages: ['https://example.com/ref.png'] }, 'novelai', source);
        source.references[0].image = 'CHANGED';
        const loaded = getCharacterProviderReferences(record, 'novelai');
        expect(loaded).toEqual(settings(false).naiPreciseReference);
        loaded.references[0].strength = 0;
        expect(getCharacterProviderReferences(record, 'novelai').references[0].strength).toBe(0.8);
        expect(getCharacterProviderReferences(record, 'proxy')).toEqual(['https://example.com/ref.png']);
        expect(getCharacterProviderReferences({}, 'novelai')).toEqual({ enabled: false, references: [] });
    });
});

describe('QIG precise reference privacy', () => {
    test('portable settings and profiles omit raw PNG bytes while importing preserves local references', () => {
        const source = settings();
        const exported = createSettingsExport({
            activeSettings: source,
            generationPresets: [{ id: 'preset-1', ...settings() }],
            connectionProfiles: { novelai: [{ id: 'profile-1', ...settings() }] },
            charRefImages: { character: { naiPreciseReference: settings().naiPreciseReference } },
        });
        expect(JSON.stringify(exported)).not.toContain('PRIVATE_REFERENCE_BYTES');
        expect(exported.activeSettings).not.toHaveProperty('naiPreciseReference');
        expect(mergePreservingPrivateFields(source, { naiModel: 'nai-diffusion-4-5-curated' }).naiPreciseReference).toEqual(source.naiPreciseReference);
    });

    test('effective metadata omits both reference settings and native provider image arrays', () => {
        const source = settings();
        const effective = createEffectiveRequest(source);
        const sanitized = sanitizeEffectiveRequest({
            ...effective,
            settings: source,
            parameters: { ...effective.parameters, director_reference_images: ['PRIVATE_REFERENCE_BYTES'] },
        });
        expect(JSON.stringify(sanitized)).not.toContain('PRIVATE_REFERENCE_BYTES');
        expect(sanitized.settings).not.toHaveProperty('naiPreciseReference');
        expect(sanitized.parameters).not.toHaveProperty('director_reference_images');
    });
});
