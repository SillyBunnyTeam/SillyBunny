import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

const source = readFileSync(new URL('../public/scripts/extensions/stable-diffusion/index.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;

function createRuntime(model = 'saved-model') {
    const select = {
        options: [{ value: model, text: model }],
        value: model,
        replaceChildren() { this.options = []; this.value = ''; },
        add(option) { this.options.push(option); },
        setAttribute() {},
        removeAttribute() {},
    };
    const controls = new Map();
    const $ = target => {
        if (!controls.has(target)) {
            const control = {
                value: '',
                prop() { return control; },
                data() { return control; },
                val(value) {
                    if (value === undefined) return control.value;
                    control.value = value;
                    return control;
                },
            };
            controls.set(target, control);
        }
        return controls.get(target);
    };
    $('#sd_model_custom').val(model);
    const runtime = vm.createContext({
        document: { querySelector: () => select },
        Option: function (text, value) { return { text, value }; },
        $,
        extension_settings: { sd: { source: 'openai', model } },
        sources: { electronhub: 'electronhub' },
        getModelsForSource: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        switchModelSpecificControls: jest.fn(),
        ensureElectronHubQualitySelect: jest.fn(),
        toastr: { warning: jest.fn() },
        t: strings => strings.join(''),
        console: { warn: jest.fn() },
        onModelChange: async () => { runtime.extension_settings.sd.model = select.value; },
    });
    vm.runInContext('let modelLoadRequest = 0;', runtime);
    for (const name of ['loadModels', 'onCustomModelChange']) {
        const node = declarations.find(node => node.id?.name === name);
        vm.runInContext(source.slice(node.start, node.end), runtime);
    }
    return { runtime, select, $ };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('image model selection', () => {
    test('keeps a saved model absent from refreshed suggestions', async () => {
        const { runtime, select } = createRuntime('custom-provider-model');
        runtime.getModelsForSource.mockResolvedValue([{ value: 'new-image-model', text: 'New image model' }]);
        await runtime.loadModels();
        expect(select.options.map(option => option.value)).toEqual(['new-image-model', 'custom-provider-model']);
        expect(select.value).toBe('custom-provider-model');
        expect(runtime.extension_settings.sd.model).toBe('custom-provider-model');
        expect(runtime.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('preserves the current list and selection after a discovery failure', async () => {
        const { runtime, select } = createRuntime();
        runtime.getModelsForSource.mockRejectedValue(new Error('Provider unavailable'));
        await runtime.loadModels();
        expect(select.options.map(option => option.value)).toEqual(['saved-model']);
        expect(select.value).toBe('saved-model');
        expect(runtime.extension_settings.sd.model).toBe('saved-model');
        expect(runtime.toastr.warning).toHaveBeenCalledTimes(1);
    });

    test('ignores late catalogs from a previously selected provider', async () => {
        const { runtime, select } = createRuntime();
        const old = deferred();
        runtime.getModelsForSource.mockReturnValueOnce(old.promise);
        const first = runtime.loadModels();
        runtime.extension_settings.sd = { source: 'novel', model: 'nai-diffusion-5-curated' };
        runtime.getModelsForSource.mockResolvedValueOnce([{ value: 'nai-diffusion-5-full', text: 'V5 Full' }]);
        await runtime.loadModels();
        old.resolve([{ value: 'old-provider-model', text: 'Old' }]);
        await first;
        expect(select.options.map(option => option.value)).toEqual(['nai-diffusion-5-full', 'nai-diffusion-5-curated']);
        expect(select.value).toBe('nai-diffusion-5-curated');
        expect(runtime.extension_settings.sd.model).toBe('nai-diffusion-5-curated');
    });

    test('uses the latest refresh result and preserves a selection changed while loading', async () => {
        const { runtime, select } = createRuntime();
        const old = deferred();
        const latest = deferred();
        runtime.getModelsForSource.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
        const first = runtime.loadModels();
        const second = runtime.loadModels();
        runtime.extension_settings.sd.model = 'chosen-during-refresh';
        latest.resolve([{ value: 'current-model', text: 'Current' }]);
        await second;
        old.resolve([{ value: 'obsolete-model', text: 'Obsolete' }]);
        await first;
        expect(select.options.map(option => option.value)).toEqual(['current-model', 'chosen-during-refresh']);
        expect(select.value).toBe('chosen-during-refresh');
    });

    test('does not replace a custom ID being typed when discovery finishes', async () => {
        const { runtime, select, $ } = createRuntime();
        const pending = deferred();
        runtime.getModelsForSource.mockReturnValue(pending.promise);
        const refresh = runtime.loadModels();
        $('#sd_model_custom').val('unfinished-custom-id');
        pending.resolve([{ value: 'listed', text: 'Listed' }]);
        await refresh;
        expect($('#sd_model_custom').val()).toBe('unfinished-custom-id');
        expect(select.value).toBe('saved-model');
        await runtime.onCustomModelChange();
        expect(runtime.extension_settings.sd.model).toBe('unfinished-custom-id');
    });

    test('keeps a preexisting draft after discovery fails', async () => {
        const { runtime, $ } = createRuntime();
        $('#sd_model_custom').val('uncommitted-id');
        runtime.getModelsForSource.mockRejectedValue(new Error('Unavailable'));
        await runtime.loadModels();
        expect($('#sd_model_custom').val()).toBe('uncommitted-id');
        expect(runtime.extension_settings.sd.model).toBe('saved-model');
    });

    test('sends the selected local checkpoint even if the server loaded another one', async () => {
        const requests = [];
        const context = vm.createContext({
            extension_settings: { sd: { model: 'saved-checkpoint', seed: 0 } },
            getSdRequestBody: () => ({ url: 'http://local.invalid' }),
            getRequestHeaders: () => ({}),
            placeholderVae: 'N/A',
            fetch: async (_url, options) => {
                requests.push(JSON.parse(options.body));
                return { ok: true, json: async () => ({ images: ['image'] }) };
            },
        });
        const node = declarations.find(node => node.id?.name === 'generateAutoImage');
        vm.runInContext(source.slice(node.start, node.end), context);
        await context.generateAutoImage('portrait', '', undefined);
        expect(requests[0].override_settings.sd_model_checkpoint).toBe('saved-checkpoint');
        expect(requests[0].override_settings_restore_afterwards).toBe(true);
        expect(requests[0].seed).toBe(0);
    });

    test('accepts a trimmed custom ID and retains it through refresh', async () => {
        const { runtime, select, $ } = createRuntime();
        $('#sd_model_custom').val('  future-image-model  ');
        await runtime.onCustomModelChange();
        runtime.getModelsForSource.mockResolvedValue([{ value: 'listed-model', text: 'Listed' }]);
        await runtime.loadModels();
        expect(select.value).toBe('future-image-model');
        expect(runtime.extension_settings.sd.model).toBe('future-image-model');
        $('#sd_model_custom').val('  ');
        await runtime.onCustomModelChange();
        expect(runtime.extension_settings.sd.model).toBe('future-image-model');
    });
});
