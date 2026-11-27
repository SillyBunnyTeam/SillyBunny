import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const providerPath = path.resolve(__dirname, '..', 'public', 'scripts', 'extensions', 'tts', 'elevenlabs.js');

function loadElevenLabsProvider() {
    const rawSource = fs.readFileSync(providerPath, 'utf8');
    const strippedSource = rawSource
        .replace(/^import\s+.*$/gm, '')
        .replace(/^export\s+\{\s*ElevenLabsTtsProvider\s*\};?\s*$/m, '');

    const sandbox = {
        saveTtsProviderSettings: () => {},
        event_types: {
            SECRET_WRITTEN: 'secret_written',
            SECRET_DELETED: 'secret_deleted',
            SECRET_ROTATED: 'secret_rotated',
        },
        eventSource: { removeListener: () => {} },
        getRequestHeaders: () => ({}),
        SECRET_KEYS: { ELEVENLABS: 'api_key_elevenlabs' },
        secret_state: {},
        writeSecret: async () => {},
        getBase64Async: async () => '',
        $: () => ({}),
    };

    const script = new vm.Script(`${strippedSource}\nElevenLabsTtsProvider;`, { filename: providerPath });
    return script.runInNewContext(sandbox);
}

describe('ElevenLabs TTS v4 model support (ST #6143)', () => {
    const ElevenLabsTtsProvider = loadElevenLabsProvider();

    it('exposes Eleven v4 and Eleven v4 Turbo at the top of the model selector', () => {
        const provider = new ElevenLabsTtsProvider();
        const html = provider.settingsHtml;

        const v4Index = html.indexOf('<option value="eleven_v4">Eleven v4</option>');
        const v4TurboIndex = html.indexOf('<option value="eleven_v4_turbo">Eleven v4 Turbo</option>');
        const v3Index = html.indexOf('<option value="eleven_v3">Eleven v3</option>');

        expect(v4Index).toBeGreaterThan(-1);
        expect(v4TurboIndex).toBeGreaterThan(v4Index);
        expect(v3Index).toBeGreaterThan(v4TurboIndex);
    });

    it('keeps extended v2/v3 settings disabled for Eleven v4 and v4 Turbo while keeping v3 enabled', () => {
        const provider = new ElevenLabsTtsProvider();

        provider.settings = { model: 'eleven_v4' };
        expect(provider.shouldInvolveExtendedSettings()).toBe(false);

        provider.settings = { model: 'eleven_v4_turbo' };
        expect(provider.shouldInvolveExtendedSettings()).toBe(false);

        provider.settings = { model: 'eleven_v3' };
        expect(provider.shouldInvolveExtendedSettings()).toBe(true);
    });
});
