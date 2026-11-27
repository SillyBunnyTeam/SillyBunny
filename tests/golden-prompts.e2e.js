import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import {
    GOLDEN_FIXTURE_MARKERS,
    GOLDEN_SCENARIOS,
    assertGoldenPrompt,
    extractPromptText,
} from './util/golden-prompts.js';

test.use({
    serviceWorkers: 'block',
    contextOptions: { reducedMotion: 'reduce' },
    viewport: { width: 1440, height: 900 },
});
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const GENERATION_TIMEOUT = 30_000;
const LOREBOOK_NAME = 'Golden Prompt Lorebook';
const MOCK_REPLY = 'Golden mock reply acknowledged.';
const FIXTURE_SEND_EPOCH = Date.UTC(2026, 0, 15, 12, 0, 0);
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const SCENARIO_BY_ID = Object.fromEntries(GOLDEN_SCENARIOS.map(scenario => [scenario.id, scenario]));

const FULL_CHARACTER = Object.freeze({
    avatar: 'golden_lyra.png',
    name: GOLDEN_FIXTURE_MARKERS.charName,
    description: GOLDEN_FIXTURE_MARKERS.charDescription,
    personality: GOLDEN_FIXTURE_MARKERS.charPersonality,
    scenario: 'Rain taps against the leaded glass of Lyra\'s workshop while {{user}} brings a torn star chart to her bench.',
    first_mes: 'Lyra sets her loupe beside the brass compass and looks up at {{user}}. "Put the chart under the amber lamp before the ink runs."',
    mes_example: [
        '<START>',
        `{{user}}: ${GOLDEN_FIXTURE_MARKERS.charExampleUser}`,
        `{{char}}: ${GOLDEN_FIXTURE_MARKERS.charExampleAssistant}`,
    ].join('\n'),
    system_prompt: 'Stay strictly in character as {{char}}, grounding scenes in tactile workshop detail. {{original}}',
    post_history_instructions: 'End {{char}}\'s reply with a concrete physical action inside the workshop.',
});

const MINIMAL_CHARACTER = Object.freeze({
    avatar: 'golden_bramwell.png',
    name: GOLDEN_FIXTURE_MARKERS.minimalCharName,
    description: GOLDEN_FIXTURE_MARKERS.minimalDescription,
    personality: '',
    scenario: '',
    first_mes: GOLDEN_FIXTURE_MARKERS.minimalTurn0,
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
});

const GOLDEN_LOREBOOK = Object.freeze({
    entries: {
        0: {
            uid: 0,
            key: ['astrolabe'],
            keysecondary: [],
            comment: 'Before char — triggered by astrolabe',
            content: GOLDEN_FIXTURE_MARKERS.worldInfoBefore,
            constant: false,
            vectorized: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: false,
            order: 100,
            position: 0,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        },
        1: {
            uid: 1,
            key: ['lantern'],
            keysecondary: [],
            comment: 'After char — triggered by lantern',
            content: GOLDEN_FIXTURE_MARKERS.worldInfoAfter,
            constant: false,
            vectorized: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: false,
            order: 90,
            position: 1,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        },
        2: {
            uid: 2,
            key: ['beacon'],
            keysecondary: [],
            comment: 'At depth 1 — triggered by beacon in sent message',
            content: GOLDEN_FIXTURE_MARKERS.worldInfoAtDepth,
            constant: false,
            vectorized: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: false,
            order: 80,
            position: 4,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 1,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        },
        3: {
            uid: 3,
            key: ['glacier'],
            keysecondary: [],
            comment: 'Untriggered control entry',
            content: GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
            constant: false,
            vectorized: false,
            selective: false,
            selectiveLogic: 0,
            addMemo: false,
            order: 70,
            position: 0,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        },
    },
});

const FULL_AUTHORS_NOTE_METADATA = Object.freeze({
    note_prompt: GOLDEN_FIXTURE_MARKERS.authorsNote,
    note_depth: 2,
    note_interval: 1,
    note_position: 1,
    note_role: 0,
});

const FULL_CHAT_HISTORY = Object.freeze([
    {
        name: GOLDEN_FIXTURE_MARKERS.charName,
        is_user: false,
        is_system: false,
        send_date: FIXTURE_SEND_EPOCH,
        mes: GOLDEN_FIXTURE_MARKERS.chatTurn0,
        extra: {},
    },
    {
        name: GOLDEN_FIXTURE_MARKERS.userName,
        is_user: true,
        is_system: false,
        send_date: FIXTURE_SEND_EPOCH + 60_000,
        mes: GOLDEN_FIXTURE_MARKERS.chatTurn1,
        extra: {},
    },
    {
        name: GOLDEN_FIXTURE_MARKERS.charName,
        is_user: false,
        is_system: false,
        send_date: FIXTURE_SEND_EPOCH + 120_000,
        mes: GOLDEN_FIXTURE_MARKERS.chatTurn2,
        extra: {},
    },
]);

const MINIMAL_CHAT_HISTORY = Object.freeze([
    {
        name: GOLDEN_FIXTURE_MARKERS.minimalCharName,
        is_user: false,
        is_system: false,
        send_date: FIXTURE_SEND_EPOCH,
        mes: GOLDEN_FIXTURE_MARKERS.minimalTurn0,
        extra: {},
    },
]);

/**
 * Builds a SillyTavern character card object as `/api/characters/all` returns it.
 * @param {typeof FULL_CHARACTER} card
 * @param {string} chatId
 */
function buildCharacterCard(card, chatId) {
    const data = {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.first_mes,
        mes_example: card.mes_example,
        creator_notes: '',
        system_prompt: card.system_prompt,
        post_history_instructions: card.post_history_instructions,
        alternate_greetings: [],
        group_only_greetings: [],
        tags: [],
        creator: 'GoldenPromptSuite',
        character_version: '1.0',
        extensions: {
            fav: false,
            talkativeness: 0.5,
            depth_prompt: {
                prompt: '',
                depth: 4,
                role: 'system',
            },
        },
    };
    return {
        ...data,
        avatar: card.avatar,
        chat: chatId,
        create_date: '2026-01-15@12h00m00s000ms',
        data,
        shallow: false,
        json_data: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data }),
    };
}

/**
 * Builds deterministic OpenAI / Chat Completion settings from the server's bundled Default preset.
 * @param {Record<string, any>} serverData
 * @param {Record<string, any>} overrides
 */
function buildDeterministicOaiSettings(serverData, overrides = {}) {
    const defaultIndex = serverData.openai_setting_names?.Default;
    const rawPreset = defaultIndex !== undefined ? serverData.openai_settings?.[defaultIndex] : null;
    const parsedPreset = typeof rawPreset === 'string' ? JSON.parse(rawPreset) : (rawPreset ?? {});

    return {
        preset_settings_openai: 'Default',
        temp_openai: 0.8,
        freq_pen_openai: 0,
        pres_pen_openai: 0,
        top_p_openai: 0.95,
        top_k_openai: 0,
        min_p_openai: 0,
        top_a_openai: 0,
        repetition_penalty_openai: 1,
        stream_openai: false,
        openai_max_context: 8192,
        openai_max_tokens: 300,
        prompts: parsedPreset.prompts ?? [],
        prompt_order: parsedPreset.prompt_order ?? [],
        send_if_empty: '',
        impersonation_prompt: parsedPreset.impersonation_prompt ?? '',
        new_chat_prompt: parsedPreset.new_chat_prompt ?? '[Start a new Chat]',
        new_group_chat_prompt: parsedPreset.new_group_chat_prompt ?? '[Start a new group chat. Group members: {{group}}]',
        new_example_chat_prompt: parsedPreset.new_example_chat_prompt ?? '[Example Chat]',
        continue_nudge_prompt: parsedPreset.continue_nudge_prompt ?? '[Continue your last message without repeating its original content.]',
        bias_preset_selected: 'Default (none)',
        bias_presets: { 'Default (none)': [] },
        wi_format: parsedPreset.wi_format ?? '{0}',
        scenario_format: parsedPreset.scenario_format ?? '{{scenario}}',
        personality_format: parsedPreset.personality_format ?? '{{personality}}',
        group_nudge_prompt: parsedPreset.group_nudge_prompt ?? '[Write the next reply only as {{char}}.]',
        chat_completion_source: 'openai',
        openai_model: 'gpt-4o',
        claude_model: 'claude-sonnet-4-5-20250929',
        claude_disable_temperature: false,
        claude_disable_top_p: false,
        reverse_proxy: '',
        proxy_password: '',
        max_context_unlocked: true,
        show_external_models: false,
        assistant_prefill: '',
        assistant_impersonation: '',
        use_sysprompt: false,
        squash_system_messages: false,
        media_inlining: true,
        bypass_status_check: false,
        continue_prefill: false,
        continue_postfix: ' ',
        function_calling: false,
        names_behavior: 0,
        custom_prompt_post_processing: '',
        show_thoughts: false,
        auto_append_reasoning_tags: false,
        reasoning_effort: 'none',
        verbosity: 'auto',
        enable_web_search: false,
        request_images: false,
        request_image_resolution: '1K',
        request_image_aspect_ratio: '1:1',
        seed: 42,
        n: 1,
        model_sampling_policies: { version: 1, targets: {} },
        ...overrides,
    };
}

/**
 * Builds deterministic Text Completion settings targeting a local llama.cpp adapter.
 * @param {Record<string, any>} overrides
 */
function buildDeterministicTextGenSettings(overrides = {}) {
    return {
        type: 'llamacpp',
        preset: 'Default',
        llamacpp_model: 'llama-3.1-8b-instruct',
        server_urls: {
            llamacpp: 'http://127.0.0.1:8080',
        },
        streaming: false,
        temp: 0.8,
        temperature_last: true,
        top_p: 0.95,
        top_k: 40,
        top_a: 0,
        tfs: 1,
        epsilon_cutoff: 0,
        eta_cutoff: 0,
        typical_p: 1,
        min_p: 0.05,
        rep_pen: 1.1,
        rep_pen_range: 1024,
        rep_pen_decay: 0,
        rep_pen_slope: 1,
        no_repeat_ngram_size: 0,
        penalty_alpha: 0,
        num_beams: 1,
        length_penalty: 1,
        min_length: 0,
        encoder_rep_pen: 1,
        freq_pen: 0,
        presence_pen: 0,
        skew: 0,
        do_sample: true,
        early_stopping: false,
        dynatemp: false,
        min_temp: 0,
        max_temp: 2,
        dynatemp_exponent: 1,
        smoothing_factor: 0,
        smoothing_curve: 1,
        dry_allowed_length: 2,
        dry_multiplier: 0,
        dry_base: 1.75,
        dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
        dry_penalty_last_n: 0,
        max_tokens_second: 0,
        seed: 42,
        add_bos_token: true,
        stopping_strings: [],
        ban_eos_token: false,
        skip_special_tokens: true,
        include_reasoning: false,
        mirostat_mode: 0,
        mirostat_tau: 5,
        mirostat_eta: 0.1,
        guidance_scale: 1,
        negative_prompt: '',
        grammar_string: '',
        json_schema: null,
        json_schema_allow_empty: false,
        banned_tokens: '',
        global_banned_tokens: '',
        send_banned_tokens: true,
        samplers: ['top_k', 'tfs_z', 'typical_p', 'top_p', 'min_p', 'temperature'],
        ignore_eos_token: false,
        spaces_between_special_tokens: true,
        speculative_ngram: false,
        logit_bias: [],
        n: 1,
        bypass_status_check: false,
        xtc_threshold: 0.1,
        xtc_probability: 0,
        nsigma: 0,
        min_keep: 0,
        adaptive_target: -0.01,
        adaptive_decay: 0.9,
        ...overrides,
    };
}

/**
 * Boots SillyBunny with fully isolated fixture state, sends a real user message through the UI,
 * intercepts the generation POST body without touching any external provider, and waits for the
 * UI to settle on the mocked reply.
 * @param {import('@playwright/test').Page} page
 * @param {object} config
 */
async function runGoldenScenario(page, config) {
    const {
        caseId,
        mainApi,
        chatId,
        character,
        chatHistory,
        chatMetadata,
        userMessage,
        personaDescription,
        useWorldInfo,
        oaiOverrides = {},
        textGenOverrides = {},
        instructEnabled = false,
        instructPresetName = 'Alpaca',
        contextPresetName = 'Default',
        customStoppingStrings = '',
        onlineModelLabel,
    } = config;

    const captured = [];
    const characterCard = buildCharacterCard(character, chatId);

    await protectMaintainerServer(page);

    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;

        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);

        settings.username = GOLDEN_FIXTURE_MARKERS.userName;
        settings.user_avatar = 'user-default.png';
        settings.active_character = null;
        settings.active_group = null;
        settings.main_api = mainApi;
        settings.amount_gen = 300;
        settings.max_context = 8192;

        settings.world_info_settings = {
            world_info: {
                globalSelect: useWorldInfo ? [LOREBOOK_NAME] : [],
            },
            world_info_depth: 4,
            world_info_min_activations: 0,
            world_info_min_activations_depth_max: 0,
            world_info_budget: 25,
            world_info_include_names: true,
            world_info_recursive: false,
            world_info_overflow_alert: false,
            world_info_case_sensitive: false,
            world_info_match_whole_words: true,
            world_info_use_group_scoring: false,
            world_info_character_strategy: 1,
            world_info_budget_cap: 0,
            world_info_max_recursion_steps: 0,
            world_info_timed_effects: false,
        };

        const instructPreset = data.instruct?.find(entry => entry.name === instructPresetName);
        const contextPreset = data.context?.find(entry => entry.name === contextPresetName);
        if (!instructPreset) {
            throw new Error(`Bundled instruct preset "${instructPresetName}" not found in /api/settings/get.`);
        }
        if (!contextPreset) {
            throw new Error(`Bundled context preset "${contextPresetName}" not found in /api/settings/get.`);
        }

        const instructFields = { ...instructPreset };
        delete instructFields.name;
        const contextFields = { ...contextPreset };
        delete contextFields.name;

        settings.power_user = {
            ...settings.power_user,
            world_import_dialog: false,
            reduced_motion: true,
            tokenizer: 99,
            token_padding: 64,
            collapse_newlines: false,
            pin_examples: false,
            strip_examples: false,
            trim_sentences: false,
            always_force_name2: true,
            user_prompt_bias: '',
            show_user_prompt_bias: true,
            console_log_prompts: false,
            prefer_character_prompt: true,
            prefer_character_jailbreak: true,
            continue_on_send: false,
            trim_spaces: true,
            request_token_probabilities: false,
            experimental_macro_engine: true,
            auto_fix_generated_markdown: false,
            custom_stopping_strings: customStoppingStrings,
            custom_stopping_strings_macro: true,
            instruct_derived: false,
            context_derived: false,
            context_size_derived: false,
            model_templates_mappings: {},
            start_reply_with: '',
            personas: {
                'user-default.png': GOLDEN_FIXTURE_MARKERS.userName,
            },
            default_persona: 'user-default.png',
            persona_descriptions: {
                'user-default.png': {
                    description: personaDescription,
                    position: 0,
                    depth: 2,
                    role: 0,
                    lorebook: '',
                    title: '',
                    appendices: [],
                    activeAppendices: {},
                },
            },
            persona_description: personaDescription,
            persona_description_position: 0,
            persona_description_depth: 2,
            persona_description_role: 0,
            persona_description_lorebook: '',
            instruct: {
                ...instructFields,
                preset: instructPresetName,
                enabled: instructEnabled,
                bind_to_context: false,
            },
            context: {
                ...contextFields,
                preset: contextPresetName,
            },
            sysprompt: {
                enabled: true,
                name: 'Neutral - Chat',
                content: 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.',
                post_history: '',
            },
            reasoning: {
                ...(settings.power_user?.reasoning ?? {}),
                auto_parse: false,
                auto_expand: false,
                show_hidden: false,
                add_to_prompts: false,
                max_additions: 0,
                prefix: '',
                suffix: '',
                separator: '\n\n',
                name: 'Blank',
            },
        };

        settings.oai_settings = buildDeterministicOaiSettings(data, oaiOverrides);
        settings.textgenerationwebui_settings = buildDeterministicTextGenSettings(textGenOverrides);
        settings.extension_settings = {
            ...(settings.extension_settings ?? {}),
            note: {
                default: '',
                chara: [],
                wiAddition: [],
                allowWIScan: false,
            },
            cfg: {
                global: { guidance_scale: 1, negative_prompt: '' },
                chara: [],
            },
            vectors: {
                ...(settings.extension_settings?.vectors ?? {}),
                enabled: false,
                enabled_chats: false,
            },
            regex: [],
        };

        const worldNames = Array.isArray(data.world_names) ? [...data.world_names] : [];
        if (!worldNames.includes(LOREBOOK_NAME)) {
            worldNames.push(LOREBOOK_NAME);
        }

        return route.fulfill({
            json: {
                ...data,
                world_names: worldNames,
                settings: JSON.stringify(settings),
            },
        });
    });

    await page.route('**/api/characters/all', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const filtered = data.filter(entry => entry.avatar !== characterCard.avatar);
        return route.fulfill({ json: [...filtered, characterCard] });
    });

    await page.route('**/api/characters/get', async (route) => {
        const body = route.request().postDataJSON();
        if (body?.avatar_url === characterCard.avatar) {
            return route.fulfill({ json: characterCard });
        }
        return route.fallback();
    });

    await page.route(`**/characters/${characterCard.avatar}*`, route => route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: TINY_PNG,
    }));

    await page.route(/\/thumbnail\?/, (route) => {
        if (route.request().url().includes(encodeURIComponent(characterCard.avatar)) || route.request().url().includes(characterCard.avatar)) {
            return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
        }
        return route.fallback();
    });

    await page.route('**/api/chats/get', (route) => {
        const body = route.request().postDataJSON();
        if (body?.avatar_url === characterCard.avatar) {
            return route.fulfill({
                json: [
                    {
                        chat_metadata: chatMetadata,
                        user_name: GOLDEN_FIXTURE_MARKERS.userName,
                        character_name: characterCard.name,
                        create_date: '2026-01-15@12h00m00s000ms',
                    },
                    ...chatHistory,
                ],
            });
        }
        return route.fallback();
    });

    await page.route('**/api/characters/chats', (route) => {
        const body = route.request().postDataJSON();
        if (body?.avatar_url === characterCard.avatar) {
            return route.fulfill({
                json: [{
                    file_name: `${chatId}.jsonl`,
                    file_id: chatId,
                    file_size: '1kb',
                    chat_items: chatHistory.length,
                    mes: chatHistory.at(-1)?.mes ?? '',
                    last_mes: FIXTURE_SEND_EPOCH,
                }],
            });
        }
        return route.fallback();
    });

    await page.route('**/api/worldinfo/get', (route) => {
        const body = route.request().postDataJSON();
        if (body?.name === LOREBOOK_NAME) {
            return route.fulfill({ json: GOLDEN_LOREBOOK });
        }
        return route.fallback();
    });

    await page.route('**/api/vector/**', route => route.fulfill({
        json: route.request().url().endsWith('/list') ? [] : { hashes: [], metadata: [] },
    }));

    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({
        json: { data: [{ id: onlineModelLabel }] },
    }));

    await page.route('**/api/backends/text-completions/status', route => route.fulfill({
        json: { result: onlineModelLabel, data: [{ id: onlineModelLabel }] },
    }));

    await page.route('**/api/backends/text-completions/props', route => route.fulfill({ json: {} }));

    await page.route('**/api/backends/chat-completions/generate', (route) => {
        const body = route.request().postDataJSON();
        captured.push({ endpoint: '/api/backends/chat-completions/generate', body });

        if (body?.chat_completion_source === 'claude') {
            return route.fulfill({
                json: {
                    id: 'msg_golden_mock',
                    type: 'message',
                    role: 'assistant',
                    model: body.model,
                    content: [{ type: 'text', text: MOCK_REPLY }],
                    stop_reason: 'end_turn',
                },
            });
        }

        return route.fulfill({
            json: {
                id: 'chatcmpl_golden_mock',
                object: 'chat.completion',
                model: body?.model ?? onlineModelLabel,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: MOCK_REPLY },
                    finish_reason: 'stop',
                }],
            },
        });
    });

    await page.route('**/api/backends/text-completions/generate', (route) => {
        const body = route.request().postDataJSON();
        captured.push({ endpoint: '/api/backends/text-completions/generate', body });
        return route.fulfill({
            json: {
                id: 'cmpl_golden_mock',
                object: 'text_completion',
                model: body?.model ?? onlineModelLabel,
                choices: [{
                    index: 0,
                    text: MOCK_REPLY,
                    finish_reason: 'stop',
                }],
            },
        });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });

    await page.evaluate(() => {
        window.__goldenErrors = [];
        const originalError = window.toastr.error.bind(window.toastr);
        window.toastr.error = (...args) => {
            window.__goldenErrors.push(args.map(arg => String(arg ?? '')).join(' '));
            return originalError(...args);
        };
    });

    await page.waitForFunction((avatar) => {
        const context = window.SillyTavern?.getContext?.();
        return Array.isArray(context?.characters) && context.characters.some(entry => entry.avatar === avatar);
    }, characterCard.avatar, { timeout: STARTUP_TIMEOUT });

    await page.evaluate(async ({ avatar, modelLabel }) => {
        const script = await import('/script.js');
        const characterId = script.characters.findIndex(entry => entry.avatar === avatar);
        if (characterId < 0) {
            throw new Error(`Fixture character "${avatar}" was not loaded.`);
        }
        await script.selectCharacterById(characterId, { switchMenu: false });
        script.setOnlineStatus(modelLabel);
    }, { avatar: characterCard.avatar, modelLabel: onlineModelLabel });

    await expect(page.locator('#send_textarea')).toBeVisible({ timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#send_but')).toBeVisible({ timeout: STARTUP_TIMEOUT });
    await expect.poll(
        () => page.evaluate(() => window.SillyTavern.getContext().chat.length),
        { timeout: STARTUP_TIMEOUT },
    ).toBe(chatHistory.length);

    const expectedTotalMessages = chatHistory.length + 2;
    await page.locator('#send_textarea').fill(userMessage);
    await page.locator('#send_but').click();

    await expect.poll(() => captured.length, { timeout: GENERATION_TIMEOUT }).toBe(1);
    await expect.poll(
        () => page.evaluate(() => ({
            length: window.SillyTavern.getContext().chat.length,
            lastMessage: window.SillyTavern.getContext().chat.at(-1)?.mes ?? '',
            generating: document.body.dataset.generating === 'true',
        })),
        { timeout: GENERATION_TIMEOUT },
    ).toEqual({
        length: expectedTotalMessages,
        lastMessage: MOCK_REPLY,
        generating: false,
    });

    const errors = await page.evaluate(() => window.__goldenErrors);
    expect(errors).toEqual([]);

    const scenario = SCENARIO_BY_ID[caseId];
    expect(captured).toHaveLength(1);
    expect(captured[0].endpoint).toBe(scenario.endpoint);

    const requestBody = captured[0].body;
    const promptText = extractPromptText(requestBody);
    expect(promptText.length).toBeGreaterThan(0);

    for (const snippet of scenario.requiredSnippets) {
        expect(promptText, `expected snippet in ${caseId}`).toContain(snippet);
    }
    for (const forbidden of scenario.forbiddenSnippets) {
        expect(promptText, `unexpected snippet in ${caseId}`).not.toContain(forbidden);
    }

    const result = assertGoldenPrompt(caseId, requestBody);
    expect(result.matched).toBe(true);
    return requestBody;
}

test.describe('Golden prompt assembly', () => {
    test('Chat Completion — Standard OpenAI (full assembly)', async ({ page }) => {
        const body = await runGoldenScenario(page, {
            caseId: 'chat-completion-openai-full',
            mainApi: 'openai',
            chatId: 'golden-chat-openai-full',
            character: FULL_CHARACTER,
            chatHistory: FULL_CHAT_HISTORY,
            chatMetadata: FULL_AUTHORS_NOTE_METADATA,
            userMessage: GOLDEN_FIXTURE_MARKERS.chatTurn3,
            personaDescription: GOLDEN_FIXTURE_MARKERS.personaDescription,
            useWorldInfo: true,
            oaiOverrides: {
                chat_completion_source: 'openai',
                openai_model: 'gpt-4o',
                use_sysprompt: false,
                squash_system_messages: false,
            },
            onlineModelLabel: 'gpt-4o',
        });

        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.chat_completion_source).toBe('openai');
        expect(body.model).toBe('gpt-4o');
    });

    test('Chat Completion — Claude / Anthropic source', async ({ page }) => {
        const body = await runGoldenScenario(page, {
            caseId: 'chat-completion-claude-anthropic',
            mainApi: 'openai',
            chatId: 'golden-chat-claude-anthropic',
            character: FULL_CHARACTER,
            chatHistory: FULL_CHAT_HISTORY,
            chatMetadata: FULL_AUTHORS_NOTE_METADATA,
            userMessage: GOLDEN_FIXTURE_MARKERS.chatTurn3,
            personaDescription: GOLDEN_FIXTURE_MARKERS.personaDescription,
            useWorldInfo: true,
            oaiOverrides: {
                chat_completion_source: 'claude',
                claude_model: 'claude-sonnet-4-5-20250929',
                top_k_openai: 40,
                use_sysprompt: true,
                squash_system_messages: true,
                assistant_prefill: '{{char}} sets the divider down and replies:',
            },
            customStoppingStrings: JSON.stringify(['\n{{user}}:', '###']),
            onlineModelLabel: 'claude-sonnet-4-5-20250929',
        });

        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.chat_completion_source).toBe('claude');
        expect(body.use_sysprompt).toBe(true);
        expect(body.assistant_prefill).toBe(GOLDEN_FIXTURE_MARKERS.claudePrefill);
        expect(body.stop).toEqual(['\nRowan Hale:', '###']);
    });

    test('Chat Completion — Minimal / Clean defaults', async ({ page }) => {
        const body = await runGoldenScenario(page, {
            caseId: 'chat-completion-minimal-defaults',
            mainApi: 'openai',
            chatId: 'golden-chat-minimal-defaults',
            character: MINIMAL_CHARACTER,
            chatHistory: MINIMAL_CHAT_HISTORY,
            chatMetadata: {},
            userMessage: GOLDEN_FIXTURE_MARKERS.minimalTurn1,
            personaDescription: '',
            useWorldInfo: false,
            oaiOverrides: {
                chat_completion_source: 'openai',
                openai_model: 'gpt-4o',
                use_sysprompt: false,
                squash_system_messages: false,
            },
            onlineModelLabel: 'gpt-4o',
        });

        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.messages.every(message => typeof message.content === 'string' && message.content.trim().length > 0)).toBe(true);
    });

    test('Text Completion — Instruct Mode (Llama 3 Instruct)', async ({ page }) => {
        const body = await runGoldenScenario(page, {
            caseId: 'text-completion-instruct-llama3',
            mainApi: 'textgenerationwebui',
            chatId: 'golden-chat-tc-instruct-llama3',
            character: FULL_CHARACTER,
            chatHistory: FULL_CHAT_HISTORY,
            chatMetadata: FULL_AUTHORS_NOTE_METADATA,
            userMessage: GOLDEN_FIXTURE_MARKERS.chatTurn3,
            personaDescription: GOLDEN_FIXTURE_MARKERS.personaDescription,
            useWorldInfo: true,
            instructEnabled: true,
            instructPresetName: 'Llama 3 Instruct',
            contextPresetName: 'Llama 3 Instruct',
            onlineModelLabel: 'llama-3.1-8b-instruct',
        });

        expect(typeof body.prompt).toBe('string');
        expect(body.api_type).toBe('llamacpp');
        expect(Array.isArray(body.stop)).toBe(true);
        expect(body.stop).toContain('<|eot_id|>');
    });

    test('Text Completion — Story / Non-Instruct Mode', async ({ page }) => {
        const body = await runGoldenScenario(page, {
            caseId: 'text-completion-story-non-instruct',
            mainApi: 'textgenerationwebui',
            chatId: 'golden-chat-tc-story-non-instruct',
            character: FULL_CHARACTER,
            chatHistory: FULL_CHAT_HISTORY,
            chatMetadata: FULL_AUTHORS_NOTE_METADATA,
            userMessage: GOLDEN_FIXTURE_MARKERS.chatTurn3,
            personaDescription: GOLDEN_FIXTURE_MARKERS.personaDescription,
            useWorldInfo: true,
            instructEnabled: false,
            instructPresetName: 'Alpaca',
            contextPresetName: 'Default',
            onlineModelLabel: 'llama-3.1-8b-instruct',
        });

        expect(typeof body.prompt).toBe('string');
        expect(body.api_type).toBe('llamacpp');
        expect(Array.isArray(body.stop)).toBe(true);
        expect(body.stop).toContain('\nRowan Hale:');
    });
});
