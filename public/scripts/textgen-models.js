import { DOMPurify } from '../lib.js';
import { amount_gen, eventSource, event_types, getRequestHeaders, max_context, online_status, setGenerationParamsFromPreset } from '../script.js';
import { textgenerationwebui_settings as textgen_settings, textgen_types } from './textgen-settings.js';
import { tokenizers } from './tokenizers.js';
import { renderTemplateAsync } from './templates.js';
import { POPUP_TYPE, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { localizePagination, PAGINATION_TEMPLATE, textValueMatcher } from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { updateServiceTierOptions } from './service-tiers.js';

let mancerModels = [];
let togetherModels = [];
let infermaticAIModels = [];
let dreamGenModels = [];
let vllmModels = [];
let aphroditeModels = [];
let featherlessModels = [];
let tabbyModels = [];
let llamacppModels = [];
export let openRouterModels = [];

function shouldUseNativeApiSelects() {
    return isMobile() || (window.matchMedia?.('(max-width: 768px)').matches ?? false);
}

// SillyBunny: share in-flight catalogue requests, not a hardcoded provider list.
let openRouterProvidersRequest = null;

const OPENROUTER_PROVIDER_WARNING_SELECTORS = {
    '#openrouter_providers_text': {
        fallbackSelector: '#openrouter_allow_fallbacks_textgenerationwebui',
        warningSelector: '#openrouter_provider_warning_text',
        tierSelector: '#openrouter_service_tier_text',
    },
    '#openrouter_providers_chat': {
        fallbackSelector: '#openrouter_allow_fallbacks',
        warningSelector: '#openrouter_provider_warning_chat',
        tierSelector: '#openrouter_service_tier_chat',
    },
};

export function updateOpenRouterProvidersWarning(providersSelector) {
    const $providers = $(providersSelector);

    const warningSelectors = OPENROUTER_PROVIDER_WARNING_SELECTORS[providersSelector];

    if ($providers.length === 0 || !warningSelectors) {
        return;
    }

    const $fallback = $(warningSelectors.fallbackSelector);
    const $warning = $(warningSelectors.warningSelector);

    const allowFallback = !!$fallback.prop('checked');
    const selectedCount = $providers.find('option:selected').length;
    const applicableSelectedCount = $providers.find('option:selected:not(:disabled)').length;
    const showWarning = !allowFallback && selectedCount > 0 && applicableSelectedCount === 0;

    $warning.toggleClass('displayNone', !showWarning);
}

/**
 * Restore saved provider names and priority even before the live catalogue arrives.
 * @param {string} providersSelector
 * @param {string[]} selectedProviders
 * @param {string[]} [providerNames]
 */
export function setOpenRouterProviders(providersSelector, selectedProviders, providerNames) {
    setProviderOptions(providersSelector, selectedProviders, providerNames?.map(name => ({ id: name, label: name })));
    updateOpenRouterProvidersWarning(providersSelector);
}

function setProviderOptions(providersSelector, selectedProviders, providers) {
    const select = $(providersSelector)[0];
    if (!select) return;

    const options = new Map(Array.from(select.options, option => [option.value, option]));
    const selected = Array.isArray(selectedProviders) ? selectedProviders.filter(name => typeof name === 'string' && name.trim()) : [];
    const labels = new Map(providers?.map(provider => [provider.id, provider.label]));
    const names = (providers?.map(provider => provider.id) ?? [...options.keys()]).filter(name => !selected.includes(name))
        .sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b));
    select.replaceChildren(...Array.from(new Set([...names, ...selected]), name => {
        const option = options.get(name) ?? new Option(name, name);
        option.text = labels.get(name) ?? option.text;
        option.selected = selected.includes(name);
        return option;
    }));
    $(select).trigger('change.select2');
}

export async function syncOpenRouterProvidersForModel(modelId, providersSelector) {
    const $providers = $(providersSelector);
    if (!$providers.length) return;

    // SillyBunny: a late catalogue or model response must not overwrite a newer selection.
    const request = {};
    $providers.data('openrouterRequest', request);
    const tierSelector = OPENROUTER_PROVIDER_WARNING_SELECTORS[providersSelector]?.tierSelector;
    if ($providers.data('openrouterModel') !== modelId) {
        updateServiceTierOptions(tierSelector);
        $providers.data('openrouterModel', modelId);
    }

    const refreshWarningState = () => {
        updateOpenRouterProvidersWarning(providersSelector);
    };

    try {
        openRouterProvidersRequest ??= fetch('/api/openrouter/providers', {
            method: 'POST',
            headers: getRequestHeaders(),
        }).then(async response => {
            if (!response.ok) throw new Error(`OpenRouter providers request failed: ${response.status}`);
            const names = await response.json();
            if (!Array.isArray(names) || !names.length || !names.every(name => typeof name === 'string' && name.trim())) {
                throw new Error('Invalid OpenRouter providers response');
            }
            return names;
        }).finally(() => {
            openRouterProvidersRequest = null;
        });
        const names = await openRouterProvidersRequest;
        if ($providers.data('openrouterRequest') !== request) return;
        setOpenRouterProviders(providersSelector, Array.from($providers[0].selectedOptions, option => option.value), names);
    } catch (error) {
        console.warn('Failed to refresh OpenRouter provider catalogue', error);
    }

    if ($providers.data('openrouterRequest') !== request) return;

    if (!modelId || !modelId.includes('/')) {
        $providers.find('option').prop('disabled', false);
        $providers.trigger('change.select2');
        refreshWarningState();
        return;
    }

    try {
        const response = await fetch('/api/openrouter/models/providers', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ model: modelId, include_service_tiers: true }),
        });

        if ($providers.data('openrouterRequest') !== request) return;

        if (!response.ok) {
            refreshWarningState();
            return;
        }

        const data = await response.json();
        if ($providers.data('openrouterRequest') !== request) return;
        const providerNames = Array.isArray(data) ? data : data?.providers;
        if (Array.isArray(data?.service_tiers)) updateServiceTierOptions(tierSelector, data.service_tiers);

        if (!Array.isArray(providerNames) || providerNames.length === 0) {
            $providers.find('option').prop('disabled', false);
            $providers.trigger('change.select2');
            refreshWarningState();
            return;
        }

        $providers.find('option').each(function () {
            const isAvailable = providerNames.includes($(this).val());
            $(this).prop('disabled', !isAvailable);
        });

        $providers.trigger('change.select2');
        refreshWarningState();
    } catch (error) {
        console.error('Failed to fetch OpenRouter providers for model', error);
        refreshWarningState();
    }
}

let nanoGptProvidersRequest = 0;
let nanoGptCatalogueRequest = null;

export async function syncNanoGptProvidersForModel(modelId, providersSelector) {
    const requestId = ++nanoGptProvidersRequest;
    const $providers = $(providersSelector);

    const refreshWarningState = () => {
        updateNanoGptProvidersWarning(providersSelector);
    };

    $providers.removeData('supportsProviderSelection').find('option').prop('disabled', false);
    $providers.trigger('change.select2');
    refreshWarningState();

    try {
        nanoGptCatalogueRequest ??= fetch('/api/nanogpt/providers', {
            method: 'POST',
            headers: getRequestHeaders(),
        }).then(async response => {
            if (!response.ok) throw new Error(`NanoGPT providers request failed: ${response.status}`);
            const providers = await response.json();
            if (!Array.isArray(providers) || !providers.length || !providers.every(provider => typeof provider?.id === 'string' && provider.id.trim() && typeof provider.label === 'string' && provider.label.trim())) {
                throw new Error('Invalid NanoGPT providers response');
            }
            return providers;
        }).finally(() => {
            nanoGptCatalogueRequest = null;
        });
        const providers = await nanoGptCatalogueRequest;
        if (requestId !== nanoGptProvidersRequest) return;
        for (const select of $providers.add('#nanogpt_ignored_providers')) {
            setProviderOptions(`#${select.id}`, Array.from(select.selectedOptions, option => option.value), providers);
        }
    } catch (error) {
        console.warn('Failed to refresh NanoGPT provider catalogue', error);
    }
    if (requestId !== nanoGptProvidersRequest || !modelId) return;

    try {
        const response = await fetch('/api/nanogpt/models/providers', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ model: modelId }),
        });

        if (!response.ok) {
            refreshWarningState();
            return;
        }

        const data = await response.json();
        if (requestId !== nanoGptProvidersRequest || !Array.isArray(data?.providers) || typeof data.supportsProviderSelection !== 'boolean') return;
        const providerIds = data.providers.filter(id => typeof id === 'string' && id.trim());

        // SillyBunny: refresh availability without changing saved restrictions or losing new provider IDs.
        for (const select of $providers.add('#nanogpt_ignored_providers')) {
            for (const id of providerIds) {
                if (!Array.from(select.options).some(option => option.value === id)) {
                    select.add(new Option(id, id));
                }
            }
        }

        $providers.data('supportsProviderSelection', data.supportsProviderSelection);
        $providers.find('option').each(function () {
            const value = $(this).val();
            const isAvailable = !value || (data.supportsProviderSelection && providerIds.includes(value));
            $(this).prop('disabled', !isAvailable);
        });

        $providers.add('#nanogpt_ignored_providers').trigger('change.select2');
        refreshWarningState();
    } catch (error) {
        console.error('Failed to fetch NanoGPT providers for model', error);
        refreshWarningState();
    }
}

export function updateNanoGptProvidersWarning(providersSelector) {
    const $providers = $(providersSelector);

    if ($providers.length === 0) {
        return;
    }

    const selectedCount = $providers.find('option:selected').length;
    const ignored = new Set($('#nanogpt_ignored_providers option:selected').map((_, option) => option.value).get());
    const applicableSelectedCount = $providers.find('option:selected:not(:disabled)').filter((_, option) => !ignored.has(option.value)).length;
    const showWarning = (selectedCount > 0 && applicableSelectedCount === 0)
        || ($providers.data('supportsProviderSelection') === false && ignored.size > 0);

    $('#nanogpt_provider_warning').toggleClass('displayNone', !showWarning);
    $('#nanogpt_billing_warning').toggleClass('displayNone', selectedCount === 0 && ignored.size === 0);
}

export async function loadOllamaModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Ollama models data', data);
        return;
    }

    if (!data.find(x => x.id === textgen_settings.ollama_model)) {
        textgen_settings.ollama_model = data[0]?.id || '';
    }

    $('#ollama_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.name;
        option.selected = model.id === textgen_settings.ollama_model;
        $('#ollama_model').append(option);
    }
}

export async function loadTabbyModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Tabby models data', data);
        return;
    }

    tabbyModels = data;
    tabbyModels.sort((a, b) => a.id.localeCompare(b.id));
    tabbyModels.unshift({ id: '' });

    if (!tabbyModels.find(x => x.id === textgen_settings.tabby_model)) {
        textgen_settings.tabby_model = tabbyModels[0]?.id || '';
    }

    $('#tabby_model').empty();
    for (const model of tabbyModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.tabby_model;
        $('#tabby_model').append(option);
    }
}

export async function loadLlamaCppModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid llama.cpp models data', data);
        return;
    }

    llamacppModels = data;
    llamacppModels.sort((a, b) => a.id.localeCompare(b.id));
    llamacppModels.unshift({ id: '' });

    if (!llamacppModels.find(x => x.id === textgen_settings.llamacpp_model)) {
        textgen_settings.llamacpp_model = llamacppModels[0]?.id || '';
    }

    $('#llamacpp_model').empty();
    for (const model of llamacppModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.llamacpp_model;
        $('#llamacpp_model').append(option);
    }
}

export async function loadTogetherAIModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Together AI models data', data);
        return;
    }

    data.sort((a, b) => a.id.localeCompare(b.id));
    togetherModels = data;

    if (!data.find(x => x.id === textgen_settings.togetherai_model)) {
        textgen_settings.togetherai_model = data[0]?.id || '';
    }

    $('#model_togetherai_select').empty();
    for (const model of data) {
        // Hey buddy, I think you've got the wrong door.
        if (model.type === 'image') {
            continue;
        }

        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.display_name;
        option.selected = model.id === textgen_settings.togetherai_model;
        $('#model_togetherai_select').append(option);
    }
}

export async function loadInfermaticAIModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Infermatic AI models data', data);
        return;
    }

    data.sort((a, b) => a.id.localeCompare(b.id));
    infermaticAIModels = data;

    if (!data.find(x => x.id === textgen_settings.infermaticai_model)) {
        textgen_settings.infermaticai_model = data[0]?.id || '';
    }

    $('#model_infermaticai_select').empty();
    for (const model of data) {
        if (model.display_type === 'image') {
            continue;
        }

        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.infermaticai_model;
        $('#model_infermaticai_select').append(option);
    }
}

export function loadGenericModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Generic models data', data);
        return;
    }

    data.sort((a, b) => a.id.localeCompare(b.id));
    const dataList = $('#generic_model_fill');
    dataList.empty();

    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        dataList.append(option);
    }
}

export async function loadDreamGenModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid DreamGen models data', data);
        return;
    }

    dreamGenModels = data;

    if (!data.find(x => x.id === textgen_settings.dreamgen_model)) {
        textgen_settings.dreamgen_model = data[0]?.id || '';
    }

    $('#model_dreamgen_select').empty();
    for (const model of data) {
        if (model.display_type === 'image') {
            continue;
        }

        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.dreamgen_model;
        $('#model_dreamgen_select').append(option);
    }
}

export async function loadMancerModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Mancer models data', data);
        return;
    }

    data.sort((a, b) => a.name.localeCompare(b.name));
    mancerModels = data;

    if (!data.find(x => x.id === textgen_settings.mancer_model)) {
        textgen_settings.mancer_model = data[0]?.id || '';
    }

    $('#mancer_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.name;
        option.selected = model.id === textgen_settings.mancer_model;
        $('#mancer_model').append(option);
    }
}

export async function loadOpenRouterModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid OpenRouter models data', data);
        return;
    }

    data.sort((a, b) => a.name.localeCompare(b.name));
    openRouterModels = data;

    if (!data.find(x => x.id === textgen_settings.openrouter_model)) {
        textgen_settings.openrouter_model = data[0]?.id || '';
    }

    $('#openrouter_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.name;
        option.selected = model.id === textgen_settings.openrouter_model;
        $('#openrouter_model').append(option);
    }

    // Calculate the cost of the selected model + update on settings change
    calculateOpenRouterCost();
    syncOpenRouterProvidersForModel(textgen_settings.openrouter_model, '#openrouter_providers_text');
}

export async function loadVllmModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid vLLM models data', data);
        return;
    }

    vllmModels = data;

    if (!data.find(x => x.id === textgen_settings.vllm_model)) {
        textgen_settings.vllm_model = data[0]?.id || '';
    }

    $('#vllm_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.vllm_model;
        $('#vllm_model').append(option);
    }
}

export async function loadAphroditeModels(data) {
    if (!Array.isArray(data)) {
        console.error('Invalid Aphrodite models data', data);
        return;
    }

    aphroditeModels = data;

    if (!data.find(x => x.id === textgen_settings.aphrodite_model)) {
        textgen_settings.aphrodite_model = data[0]?.id || '';
    }

    $('#aphrodite_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.aphrodite_model;
        $('#aphrodite_model').append(option);
    }
}

let featherlessCurrentPage = 1;
export async function loadFeatherlessModels(data) {
    const searchBar = document.getElementById('featherless_model_search_bar');
    const modelCardBlock = document.getElementById('featherless_model_card_block');
    const paginationContainer = $('#featherless_model_pagination_container');
    const sortOrderSelect = document.getElementById('featherless_model_sort_order');
    const classSelect = document.getElementById('featherless_class_selection');
    const categoriesSelect = document.getElementById('featherless_category_selection');
    const storageKey = 'FeatherlessModels_PerPage';

    // Store the original models data for search and filtering
    let originalModels = [];

    if (!Array.isArray(data)) {
        console.error('Invalid Featherless models data', data);
        return;
    }

    originalModels = data;  // Store the original data for search
    featherlessModels = data;

    if (!data.find(x => x.id === textgen_settings.featherless_model)) {
        textgen_settings.featherless_model = data[0]?.id || '';
    }

    // Populate class select options with unique classes
    populateClassSelection(data);

    // Retrieve the stored number of items per page or default to 10
    const perPage = Number(accountStorage.getItem(storageKey)) || 10;

    // Initialize pagination
    applyFiltersAndSort();

    // Function to set up pagination (also used for filtered results)
    function setupPagination(models, perPage, pageNumber = featherlessCurrentPage) {
        paginationContainer.pagination({
            dataSource: models,
            pageSize: perPage,
            pageNumber: pageNumber,
            sizeChangerOptions: [6, 10, 26, 50, 100, 250, 500, 1000],
            pageRange: 1,
            showPageNumbers: true,
            showSizeChanger: false,
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            callback: function (modelsOnPage, pagination) {
                modelCardBlock.innerHTML = '';

                modelsOnPage.forEach(model => {
                    const card = document.createElement('div');
                    card.classList.add('model-card');

                    const modelNameContainer = document.createElement('div');
                    modelNameContainer.classList.add('model-name-container');

                    const modelTitle = document.createElement('div');
                    modelTitle.classList.add('model-title');
                    modelTitle.textContent = model.id.replace(/_/g, '_\u200B');
                    modelNameContainer.appendChild(modelTitle);

                    const detailsContainer = document.createElement('div');
                    detailsContainer.classList.add('details-container');

                    const modelClassDiv = document.createElement('div');
                    modelClassDiv.classList.add('model-class');
                    modelClassDiv.textContent = t`Class` + `: ${model.model_class || 'N/A'}`;

                    const contextLengthDiv = document.createElement('div');
                    contextLengthDiv.classList.add('model-context-length');
                    contextLengthDiv.textContent = t`Context Length` + `: ${model.context_length}`;

                    const dateAddedDiv = document.createElement('div');
                    dateAddedDiv.classList.add('model-date-added');
                    dateAddedDiv.textContent = t`Added On` + `: ${new Date(model.created * 1000).toLocaleDateString()}`;

                    detailsContainer.appendChild(modelClassDiv);
                    detailsContainer.appendChild(contextLengthDiv);
                    detailsContainer.appendChild(dateAddedDiv);

                    card.appendChild(modelNameContainer);
                    card.appendChild(detailsContainer);

                    modelCardBlock.appendChild(card);

                    if (model.id === textgen_settings.featherless_model) {
                        card.classList.add('selected');
                    }

                    card.addEventListener('click', function () {
                        document.querySelectorAll('.model-card').forEach(c => c.classList.remove('selected'));
                        card.classList.add('selected');
                        onFeatherlessModelSelect(model.id);
                    });
                });

                // Update the current page value whenever the page changes
                featherlessCurrentPage = pagination.pageNumber;
                localizePagination(paginationContainer);
            },
            afterSizeSelectorChange: function (e) {
                const newPerPage = e.target.value;
                accountStorage.setItem(storageKey, newPerPage);
                setupPagination(models, Number(newPerPage), featherlessCurrentPage); // Use the stored current page number
            },
        });
    }

    // Unset previously added listeners
    $(searchBar).off('input');
    $(sortOrderSelect).off('change');
    $(classSelect).off('change');
    $(categoriesSelect).off('change');

    // Add event listener for input on the search bar
    searchBar.addEventListener('input', function () {
        applyFiltersAndSort();
    });

    // Add event listener for the sort order select
    sortOrderSelect.addEventListener('change', function () {
        applyFiltersAndSort();
    });

    // Add event listener for the class select
    classSelect.addEventListener('change', function () {
        applyFiltersAndSort();
    });

    categoriesSelect.addEventListener('change', function () {
        applyFiltersAndSort();
    });

    // Function to populate class selection dropdown
    function populateClassSelection(models) {
        const uniqueClasses = [...new Set(models.map(model => model.model_class).filter(Boolean))];  // Get unique class names
        uniqueClasses.sort((a, b) => a.localeCompare(b));
        uniqueClasses.forEach(className => {
            const option = document.createElement('option');
            option.value = className;
            option.textContent = className;
            classSelect.appendChild(option);
        });
    }

    // Function to apply sorting and filtering based on user input
    async function applyFiltersAndSort() {
        if (!(searchBar instanceof HTMLInputElement) ||
            !(sortOrderSelect instanceof HTMLSelectElement) ||
            !(classSelect instanceof HTMLSelectElement) ||
            !(categoriesSelect instanceof HTMLSelectElement)) {
            return;
        }
        const searchQuery = searchBar.value.toLowerCase();
        const selectedSortOrder = sortOrderSelect.value;
        const selectedClass = classSelect.value;
        const selectedCategory = categoriesSelect.value;
        let featherlessTop = [];
        let featherlessNew = [];

        if (selectedCategory === 'Top') {
            featherlessTop = await fetchFeatherlessStats();
        }
        const featherlessIds = featherlessTop.map(stat => stat.id);

        if (selectedCategory === 'New') {
            featherlessNew = await fetchFeatherlessNew();
        }
        const featherlessNewIds = featherlessNew.map(stat => stat.id);

        let filteredModels = originalModels.filter(model => {
            const matchesSearch = model.id.toLowerCase().includes(searchQuery);
            const matchesClass = selectedClass ? model.model_class === selectedClass : true;
            const matchesTop = featherlessIds.includes(model.id);
            const matchesNew = featherlessNewIds.includes(model.id);

            if (selectedCategory === 'All') {
                return matchesSearch && matchesClass;
            } else if (selectedCategory === 'Top') {
                return matchesSearch && matchesClass && matchesTop;
            } else if (selectedCategory === 'New') {
                return matchesSearch && matchesClass && matchesNew;
            } else {
                return matchesSearch && matchesClass;
            }
        });

        if (selectedSortOrder === 'asc') {
            filteredModels.sort((a, b) => a.id.localeCompare(b.id));
        } else if (selectedSortOrder === 'desc') {
            filteredModels.sort((a, b) => b.id.localeCompare(a.id));
        } else if (selectedSortOrder === 'date_asc') {
            filteredModels.sort((a, b) => a.created - b.created);
        } else if (selectedSortOrder === 'date_desc') {
            filteredModels.sort((a, b) => b.created - a.created);
        }

        const currentModelIndex = filteredModels.findIndex(x => x.id === textgen_settings.featherless_model);
        featherlessCurrentPage = currentModelIndex >= 0 ? (currentModelIndex / perPage) + 1 : 1;

        setupPagination(filteredModels, Number(accountStorage.getItem(storageKey)) || perPage, featherlessCurrentPage);
    }

    // Required to keep the /model command function
    $('#featherless_model').empty();
    for (const model of data) {
        const option = document.createElement('option');
        option.value = model.id;
        option.text = model.id;
        option.selected = model.id === textgen_settings.featherless_model;
        $('#featherless_model').append(option);
    }
}

async function fetchFeatherlessStats() {
    const response = await fetch('https://api.featherless.ai/feather/popular');
    const data = await response.json();
    return data.popular;
}

async function fetchFeatherlessNew() {
    const response = await fetch('https://api.featherless.ai/feather/models?sort=-created_at&perPage=20');
    const data = await response.json();
    return data.items;
}

function onFeatherlessModelSelect(modelId) {
    const model = featherlessModels.find(x => x.id === modelId);
    textgen_settings.featherless_model = modelId;
    $('#featherless_model').val(modelId);
    $('#api_button_textgenerationwebui').trigger('click');
    setGenerationParamsFromPreset({ max_length: model.context_length });
}

let featherlessIsGridView = false;  // Default state set to grid view

// Ensure the correct initial view is applied when the page loads
document.addEventListener('DOMContentLoaded', function () {
    const modelCardBlock = document.getElementById('featherless_model_card_block');
    modelCardBlock.classList.add('list-view');

    const toggleButton = document.getElementById('featherless_model_grid_toggle');
    toggleButton.addEventListener('click', function () {
        // Toggle between grid and list view
        if (featherlessIsGridView) {
            modelCardBlock.classList.remove('grid-view');
            modelCardBlock.classList.add('list-view');
            this.title = 'Toggle to grid view';
        } else {
            modelCardBlock.classList.remove('list-view');
            modelCardBlock.classList.add('grid-view');
            this.title = 'Toggle to list view';
        }

        featherlessIsGridView = !featherlessIsGridView;
    });
});
function onMancerModelSelect() {
    const modelId = String($('#mancer_model').val());
    textgen_settings.mancer_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');

    const limits = mancerModels.find(x => x.id === modelId)?.limits;
    setGenerationParamsFromPreset({ max_length: limits.context });
}

function onTogetherModelSelect() {
    const modelName = String($('#model_togetherai_select').val());
    textgen_settings.togetherai_model = modelName;
    $('#api_button_textgenerationwebui').trigger('click');
    const model = togetherModels.find(x => x.id === modelName);
    setGenerationParamsFromPreset({ max_length: model.context_length });
}

function onInfermaticAIModelSelect() {
    const modelName = String($('#model_infermaticai_select').val());
    textgen_settings.infermaticai_model = modelName;
    $('#api_button_textgenerationwebui').trigger('click');
    const model = infermaticAIModels.find(x => x.id === modelName);
    setGenerationParamsFromPreset({ max_length: model.context_length });
}

function onDreamGenModelSelect() {
    const modelName = String($('#model_dreamgen_select').val());
    textgen_settings.dreamgen_model = modelName;
    $('#api_button_textgenerationwebui').trigger('click');
    // TODO(DreamGen): Consider retuning max_tokens from API and setting it here.
}

function onOllamaModelSelect() {
    const modelId = String($('#ollama_model').val());
    textgen_settings.ollama_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
}

function onTabbyModelSelect() {
    const modelId = String($('#tabby_model').val());
    textgen_settings.tabby_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
}

function onLlamaCppModelSelect() {
    const modelId = String($('#llamacpp_model').val());
    textgen_settings.llamacpp_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
}

function onOpenRouterModelSelect() {
    const modelId = String($('#openrouter_model').val());
    textgen_settings.openrouter_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
    const model = openRouterModels.find(x => x.id === modelId);
    syncOpenRouterProvidersForModel(modelId, '#openrouter_providers_text');
    setGenerationParamsFromPreset({ max_length: model.context_length });
}

function onVllmModelSelect() {
    const modelId = String($('#vllm_model').val());
    textgen_settings.vllm_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
}

function onAphroditeModelSelect() {
    const modelId = String($('#aphrodite_model').val());
    textgen_settings.aphrodite_model = modelId;
    $('#api_button_textgenerationwebui').trigger('click');
}

function getMancerModelTemplate(option) {
    const model = mancerModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const creditsPerPrompt = (model.limits?.context - model.limits?.completion) * model.pricing?.prompt;
    const creditsPerCompletion = model.limits?.completion * model.pricing?.completion;
    const creditsTotal = Math.round(creditsPerPrompt + creditsPerCompletion).toFixed(0);

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.name)}</strong> | <span>${model.limits?.context} ctx</span> / <span>${model.limits?.completion} res</span> | <small>Credits per request (max): ${creditsTotal}</small></div>
        </div>
    `));
}

function getTogetherModelTemplate(option) {
    const model = togetherModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.id)}</strong> | <span>${model.context_length || '???'} tokens</span></div>
            <div><small>${DOMPurify.sanitize(model.description)}</small></div>
        </div>
    `));
}

function getInfermaticAIModelTemplate(option) {
    const model = infermaticAIModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.id)}</strong></div>
        </div>
    `));
}

function getDreamGenModelTemplate(option) {
    const model = dreamGenModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.id)}</strong></div>
        </div>
    `));
}

function getOpenRouterModelTemplate(option) {
    const model = openRouterModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    let tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
    let tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);

    const price = 0 === Number(model.pricing?.prompt) ? 'Free' : `${tokens_rounded}k t/$ `;

    return $((`
        <div class="flex-container flexFlowColumn" title="${DOMPurify.sanitize(model.id)}">
            <div><strong>${DOMPurify.sanitize(model.name)}</strong> | ${model.context_length} ctx | <small>${price}</small></div>
        </div>
    `));
}

function getVllmModelTemplate(option) {
    const model = vllmModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.id)}</strong></div>
        </div>
    `));
}

function getAphroditeModelTemplate(option) {
    const model = aphroditeModels.find(x => x.id === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    return $((`
        <div class="flex-container flexFlowColumn">
            <div><strong>${DOMPurify.sanitize(model.id)}</strong></div>
        </div>
    `));
}

async function downloadOllamaModel() {
    try {
        const serverUrl = textgen_settings.server_urls[textgen_types.OLLAMA];

        if (!serverUrl) {
            toastr.info('Please connect to an Ollama server first.');
            return;
        }

        const html = `Enter a model tag, for example <code>llama2:latest</code>.<br>
        See <a target="_blank" href="https://ollama.ai/library">Library</a> for available models.`;
        const name = await callGenericPopup(html, POPUP_TYPE.INPUT, '', { okButton: 'Download' });

        if (!name) {
            return;
        }

        toastr.info('Download may take a while, please wait...', 'Working on it');

        const response = await fetch('/api/backends/text-completions/ollama/download', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: name,
                api_server: serverUrl,
            }),
        });

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        // Force refresh the model list
        toastr.success('Download complete. Please select the model from the dropdown.');
        $('#api_button_textgenerationwebui').trigger('click');
    } catch (err) {
        console.error(err);
        toastr.error('Failed to download Ollama model. Please try again.');
    }
}

async function downloadTabbyModel() {
    try {
        const serverUrl = textgen_settings.server_urls[textgen_types.TABBY];

        if (online_status === 'no_connection' || !serverUrl) {
            toastr.info('Please connect to a TabbyAPI server first.');
            return;
        }

        const downloadHtml = $(await renderTemplateAsync('tabbyDownloader'));
        const popupResult = await callGenericPopup(downloadHtml, POPUP_TYPE.CONFIRM, '', { okButton: 'Download', cancelButton: 'Cancel' });

        // User cancelled the download
        if (!popupResult) {
            return;
        }

        const repoId = downloadHtml.find('input[name="hf_repo_id"]').val().toString();
        if (!repoId) {
            toastr.error('A HuggingFace repo ID must be provided. Skipping Download.');
            return;
        }

        if (repoId.split('/').length !== 2) {
            toastr.error('A HuggingFace repo ID must be formatted as Author/Name. Please try again.');
            return;
        }

        const params = {
            repo_id: repoId,
            folder_name: downloadHtml.find('input[name="folder_name"]').val() || undefined,
            revision: downloadHtml.find('input[name="revision"]').val() || undefined,
            token: downloadHtml.find('input[name="hf_token"]').val() || undefined,
        };

        for (const suffix of ['include', 'exclude']) {
            const patterns = downloadHtml.find(`textarea[name="tabby_download_${suffix}"]`).val().toString();
            if (patterns) {
                params[suffix] = patterns.split('\n');
            }
        }

        // Params for the server side of ST
        params.api_server = serverUrl;
        params.api_type = textgen_settings.type;

        toastr.info('Downloading. Check the Tabby console for progress reports.');

        const response = await fetch('/api/backends/text-completions/tabby/download', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(params),
        });

        if (response.status === 403) {
            toastr.error('The provided key has invalid permissions. Please use an admin key for downloading.');
            return;
        } else if (!response.ok) {
            throw new Error(response.statusText);
        }

        toastr.success('Download complete.');
    } catch (err) {
        console.error(err);
        toastr.error('Failed to download HuggingFace model in TabbyAPI. Please try again.');
    }
}

function calculateOpenRouterCost() {
    if (textgen_settings.type !== textgen_types.OPENROUTER) {
        return;
    }

    let cost = 'Unknown';
    const model = openRouterModels.find(x => x.id === textgen_settings.openrouter_model);

    if (model?.pricing) {
        const completionCost = Number(model.pricing.completion);
        const promptCost = Number(model.pricing.prompt);
        const completionTokens = amount_gen;
        const promptTokens = (max_context - completionTokens);
        const totalCost = (completionCost * completionTokens) + (promptCost * promptTokens);
        if (!isNaN(totalCost)) {
            cost = '$' + totalCost.toFixed(3);
        }
    }

    $('#or_prompt_cost').text(cost);

    // Schedule an update when settings change
    eventSource.removeListener(event_types.SETTINGS_UPDATED, calculateOpenRouterCost);
    eventSource.once(event_types.SETTINGS_UPDATED, calculateOpenRouterCost);
}

export function getCurrentOpenRouterModelTokenizer() {
    const modelId = textgen_settings.openrouter_model;
    const model = openRouterModels.find(x => x.id === modelId);
    if (modelId?.includes('jamba')) {
        return tokenizers.JAMBA;
    }
    switch (model?.architecture?.tokenizer) {
        case 'Llama2':
            return tokenizers.LLAMA;
        case 'Llama3':
            return tokenizers.LLAMA3;
        case 'Yi':
            return tokenizers.YI;
        case 'Mistral':
            return tokenizers.MISTRAL;
        case 'Gemini':
            return tokenizers.GEMMA;
        case 'Claude':
            return tokenizers.CLAUDE;
        case 'Cohere':
            return tokenizers.COMMAND_R;
        case 'Qwen':
            return tokenizers.QWEN2;
        default:
            return tokenizers.OPENAI;
    }
}

export function getCurrentDreamGenModelTokenizer() {
    const modelId = textgen_settings.dreamgen_model;
    const model = dreamGenModels.find(x => x.id === modelId);
    if (model.id.startsWith('lucid-v1-medium') || model.id.startsWith('lucid-v1-base')) {
        return tokenizers.MISTRAL;
    } else if (model.id.startsWith('lucid-v1-extra-large') || model.id.startsWith('lucid-v1-max')) {
        return tokenizers.LLAMA3;
    } else {
        return tokenizers.MISTRAL;
    }
}

export function initTextGenModels() {
    $('#mancer_model').on('change', onMancerModelSelect);
    $('#model_togetherai_select').on('change', onTogetherModelSelect);
    $('#model_infermaticai_select').on('change', onInfermaticAIModelSelect);
    $('#model_dreamgen_select').on('change', onDreamGenModelSelect);
    $('#ollama_model').on('change', onOllamaModelSelect);
    $('#openrouter_model').on('change', onOpenRouterModelSelect);
    $('#ollama_download_model').on('click', downloadOllamaModel);
    $('#vllm_model').on('change', onVllmModelSelect);
    $('#aphrodite_model').on('change', onAphroditeModelSelect);
    $('#tabby_download_model').on('click', downloadTabbyModel);
    $('#tabby_model').on('change', onTabbyModelSelect);
    $('#llamacpp_model').on('change', onLlamaCppModelSelect);
    $('#featherless_model').on('change', () => onFeatherlessModelSelect(String($('#featherless_model').val())));

    const providersSelect = $('.openrouter_providers');
    for (const selector of Object.keys(OPENROUTER_PROVIDER_WARNING_SELECTORS)) {
        void syncOpenRouterProvidersForModel('', selector);
    }

    const nanoGptProvidersSelect = $('#nanogpt_allowed_providers, #nanogpt_ignored_providers');
    void syncNanoGptProvidersForModel('', '#nanogpt_allowed_providers');

    if (shouldUseNativeApiSelects()) {
        return;
    }

    // Keep API Select2 dropdowns inside the scrolling API drawer so they move with the control.
    const apiDropdownParent = $('#rm_api_block');
    const select2Defaults = {
        dropdownParent: apiDropdownParent.length ? apiDropdownParent : $(document.body),
        minimumResultsForSearch: 0,
    };
    $('#mancer_model').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getMancerModelTemplate,
    });
    $('#model_togetherai_select').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getTogetherModelTemplate,
    });
    $('#ollama_model').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
    });
    $('#tabby_model').select2({
        ...select2Defaults,
        placeholder: t`[Currently loaded]`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        allowClear: true,
    });
    $('#llamacpp_model').select2({
        ...select2Defaults,
        placeholder: t`[Currently loaded]`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        allowClear: true,
    });
    $('#model_infermaticai_select').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getInfermaticAIModelTemplate,
    });
    $('#model_dreamgen_select').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getDreamGenModelTemplate,
    });
    $('#openrouter_model').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getOpenRouterModelTemplate,
        matcher: textValueMatcher,
    });
    $('#vllm_model').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getVllmModelTemplate,
    });
    $('#aphrodite_model').select2({
        ...select2Defaults,
        placeholder: t`Select a model`,
        searchInputPlaceholder: t`Search models...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        templateResult: getAphroditeModelTemplate,
    });
    $('.openrouter_quantizations').select2({
        ...select2Defaults,
        closeOnSelect: false,
        placeholder: t`Select quantizations. No selection = all quantizations.`,
        searchInputCssClass: 'text_pole',
        searchInputPlaceholder: t`Search quantizations...`,
        width: '100%',
    });
    providersSelect.select2({
        ...select2Defaults,
        sorter: data => data.sort((a, b) => a.text.localeCompare(b.text)),
        placeholder: t`Select providers. No selection = all providers.`,
        searchInputPlaceholder: t`Search providers...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        closeOnSelect: false,
    });
    // SillyBunny: refresh open results after async updates, surviving shell reinitialisation.
    $(document).on('change.select2', '.openrouter_providers, #nanogpt_allowed_providers, #nanogpt_ignored_providers', function () {
        const select2 = $(this).data('select2');
        if (select2?.isOpen()) {
            select2.trigger('query', { term: select2.selection.$search.val() || '' });
        }
    });
    providersSelect.on('select2:select', function (/** @type {any} */ evt) {
        const element = evt.params.data.element;
        const $element = $(element);

        $element.detach();
        $(this).append($element);
        $(this).trigger('change');
    });
    nanoGptProvidersSelect.select2({
        ...select2Defaults,
        sorter: data => data.sort((a, b) => a.text.localeCompare(b.text)),
        placeholder: t`Select providers`,
        searchInputPlaceholder: t`Search providers...`,
        searchInputCssClass: 'text_pole',
        width: '100%',
        allowClear: true,
        closeOnSelect: false,
    });
}
