import { characters, eventSource, event_types, flushCharacterSaveDebounced, getOneCharacter } from '../script.js';
import { getContext } from './extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { listConnectionProfiles, populateConnectionProfileSelect } from './extensions/in-chat-agents/profile-utils.js';
import { isAbortLikeError } from './util/abort-error.js';
import { CARD_FIELDS, createDraft, projectDescription, projectCardFields, getDraftTarget, setDraftTarget, acceptCandidate, reconcileSavedFields } from './sillybunny-character-creator/model.js';
import { loadDraft, saveDraft, discardDraft } from './sillybunny-character-creator/storage.js';
import { CREATOR_RECIPES, getCreatorRecipe } from './sillybunny-character-creator/recipes.js';
import { generateCreatorTarget } from './sillybunny-character-creator/generation.js';
import { loadCreatorSource, createCreatorCard, saveCreatorChanges } from './sillybunny-character-creator/cards.js';

const LABELS = {
    name: 'Name', description: 'Description', profile: 'Profile / PList', voice: 'Voice interview / dialogue',
    personality: 'Personality summary', scenario: 'Scenario', first_mes: 'First greeting',
    mes_example: 'Dialogue examples', alternate_greetings: 'Alternate greetings', questions: 'Clarifying questions',
};
const FORM_FIELDS = {
    name: 'character_name_pole', description: 'description_textarea', personality: 'personality_textarea',
    scenario: 'scenario_pole', first_mes: 'firstmessage_textarea', mes_example: 'mes_example_textarea',
};
let root;
let draft = null;
let pending = null;
let pane = 'sections';
let launchFocus = null;
let opening = false;
let saving = false;
let navigationId = 0;
let activeRun = null;
let runId = 0;
let saveTimer;
let localVersion = 0;
let storedVersion = 0;
let storageError = null;
let pendingNewDraftRemoval = null;
let stateLabel = 'Draft';
let message = '';
let questions = '';
let failure = null;
let invalidTokenInput;
let conflicts = [];
let changedBefore = new Set();
let selectedFields = new Set();
const refinements = new Map();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isOpen = () => document.getElementById('sheld')?.dataset.sbCreatorMode === 'on';
const busy = () => opening || saving || Boolean(activeRun);
const titleFor = target => LABELS[target] || `Alternate greeting ${draft?.working.alternate_greetings.findIndex(item => `greeting:${item.id}` === target) + 1}`;

function node(tag, className = '', text = '') {
    const result = document.createElement(tag);
    result.className = className;
    result.textContent = text;
    return result;
}

async function confirmAction(title, text, action = 'Continue') {
    const content = node('div');
    content.append(node('h3', '', title), node('p', '', text));
    return await new Popup(content, POPUP_TYPE.CONFIRM, '', { okButton: action, cancelButton: 'Cancel' }).show() === POPUP_RESULT.AFFIRMATIVE;
}

async function reportError(error) {
    message = error.message || String(error);
    if (isOpen()) {
        render();
    } else {
        const content = node('div');
        content.append(node('h3', '', 'Creator'), node('p', '', message));
        await new Popup(content, POPUP_TYPE.TEXT).show();
    }
}

function action(label, callback, { primary = false, lock = false, generate = false, disabled = false } = {}) {
    const button = node('button', `menu_button sb-creator-button${primary ? ' sb-creator-primary' : ''}`, label);
    button.type = 'button';
    button.disabled = disabled || (lock && busy()) || (generate && (busy() || !hasProfile()));
    if (lock) button.dataset.creatorLock = 'true';
    if (generate) button.dataset.creatorGenerate = 'true';
    button.addEventListener('click', () => { Promise.resolve().then(callback).catch(reportError); });
    return button;
}

function field(label, value, key, onInput, { rows = 4, type = 'textarea', lock = false } = {}) {
    const wrapper = node('label', 'sb-creator-field');
    wrapper.append(node('span', 'sb-creator-label', label));
    const input = node(type === 'textarea' ? 'textarea' : 'input', 'text_pole');
    input.id = `sb_creator_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    input.dataset.creatorFocus = key;
    if (type === 'textarea') input.rows = rows;
    else input.type = type;
    input.value = value;
    input.disabled = saving || (lock && busy());
    if (lock) input.dataset.creatorLock = 'true';
    input.addEventListener('input', () => onInput(input.value, input));
    wrapper.append(input);
    return wrapper;
}

function disclosure(label, key) {
    const details = node('details', 'sb-creator-details');
    details.dataset.creatorDetails = key;
    details.append(node('summary', '', label));
    return details;
}

function textValue(value) {
    return typeof value === 'string' ? value : Array.isArray(value)
        ? value.map((text, index) => `${index + 1}. ${text}`).join('\n\n')
        : projectDescription(value);
}

function hasProfile() {
    return Boolean(draft?.profileId && listConnectionProfiles().some(profile => profile.id === draft.profileId));
}

function setState(label, detail = '') {
    stateLabel = label;
    message = detail;
    updateStatus();
}

function updateStatus() {
    const status = root?.querySelector('[data-creator-status]');
    if (!status) return;
    const persistence = storageError ? 'Browser draft not saved' : localVersion !== storedVersion ? 'Saving browser draft…' : 'Browser draft saved';
    const text = `${stateLabel}${draft ? ` · ${persistence}` : ''}`;
    if (status.textContent !== text) status.textContent = text;
}

function changed({ context = true } = {}) {
    if (!draft) return;
    if (context) draft.revision++;
    draft.updatedAt = Date.now();
    localVersion++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void persistNow(); }, 500);
    updateStatus();
}

async function persistNow() {
    clearTimeout(saveTimer);
    if (!draft) return true;
    const owner = draft;
    const version = localVersion;
    const removeNewDraft = pendingNewDraftRemoval === owner;
    try {
        await saveDraft(owner);
        if (removeNewDraft) {
            await discardDraft(null);
            pendingNewDraftRemoval = null;
        }
        if (draft === owner) {
            storedVersion = version;
            storageError = null;
            updateStatus();
        }
        return true;
    } catch (error) {
        if (draft === owner) {
            storageError = error;
            updateStatus();
        }
        return false;
    }
}

async function preserveForNavigation() {
    if (await persistNow()) return true;
    return confirmAction('Browser draft not saved', 'The draft is still in memory, but leaving or reloading may lose it. Stay to download the draft or retry browser storage. Leave anyway?', 'Leave anyway');
}

function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function editorAvatar() {
    if (document.getElementById('form_create')?.getAttribute('actiontype') !== 'editcharacter') return null;
    return document.getElementById('avatar_url_pole')?.value || null;
}

function legacySnapshot(avatar) {
    if (editorAvatar() !== avatar) return null;
    const fields = Object.fromEntries(Object.entries(FORM_FIELDS).map(([key, id]) => [key, document.getElementById(id)?.value || '']));
    fields.alternate_greetings = Array.from(document.querySelectorAll('#character_greetings_editor .alternate_greeting_text'), input => input.value);
    return fields;
}

function asTextareaValue(value) {
    // DOM textareas normalize line endings; the stored card baseline must remain verbatim.
    return Array.isArray(value) ? value.map(asTextareaValue) : value.replace(/\r\n?/g, '\n');
}

function syncPolishButton() {
    const button = document.getElementById('sb_character_creator_polish');
    if (button) button.disabled = !editorAvatar() || busy();
}

function activate() {
    document.getElementById('sheld').dataset.sbCreatorMode = 'on';
    window.SillyBunnyShell?.closeCharacters();
    window.dispatchEvent(new CustomEvent('sb:creator-workspace-state-changed'));
}

function chooseDraft(value) {
    draft = value;
    pendingNewDraftRemoval = null;
    pending = null;
    localVersion = storedVersion = 0;
    storageError = null;
    failure = null;
    conflicts = [];
    invalidTokenInput = undefined;
    questions = '';
    refinements.clear();
    selectedFields = new Set();
    changedBefore = new Set();
    setState('Draft', draft.generationInterrupted ? 'The previous generation was interrupted. Completed proposals are still available.' : '');
    draft.generationInterrupted = false;
    pane = matchMedia('(max-width: 768px)').matches ? 'brief' : 'sections';
    changed({ context: false });
}

function freshDraft(avatar, fields) {
    const value = createDraft({ sourceAvatar: avatar, fields, recipeId: avatar ? 'keep-existing' : 'tld-hybrid' });
    const profileId = getContext().extensionSettings.connectionManager?.selectedProfile;
    if (listConnectionProfiles().some(profile => profile.id === profileId)) value.profileId = profileId;
    if (!avatar) value.generationTargets = ['name', ...getCreatorRecipe(value.recipeId).defaultTargets];
    return value;
}

async function openWorkspace({ avatar, startNew = false } = {}) {
    if (busy()) return;
    if (avatar === undefined && draft && !startNew) {
        if (!isOpen()) launchFocus = document.activeElement;
        activate();
        render();
        root.querySelector('h2')?.focus();
        return;
    }
    avatar ??= null;
    const requestId = ++navigationId;
    if (!isOpen()) launchFocus = document.activeElement;
    if (draft && !await preserveForNavigation()) return;
    opening = true;
    syncPolishButton();
    try {
        const form = avatar ? legacySnapshot(avatar) : null;
        await flushCharacterSaveDebounced();
        const fields = avatar ? (await loadCreatorSource(avatar)).fields : null;
        if (form && CARD_FIELDS.some(key => !equal(form[key], asTextareaValue(fields[key])))) {
            throw new Error('The existing editor has changes that were not saved. Save or resolve them there before opening Polish; its form has been left intact.');
        }
        const stored = await loadDraft(avatar).catch(error => {
            if (Object.hasOwn(error, 'rawDraft')) return { corrupt: true, raw: error.rawDraft, error };
            throw error;
        });
        if (requestId !== navigationId) return;
        activate();
        if (stored) {
            draft = null;
            pending = { avatar, fields, stored };
        } else {
            chooseDraft(freshDraft(avatar, fields));
        }
    } finally {
        opening = false;
        syncPolishButton();
    }
    render();
    root.querySelector('h2')?.focus();
}

function stopGeneration() {
    const run = activeRun;
    if (!run) return;
    activeRun = null;
    run.controller.abort();
    draft.generationRunning = false;
    changed({ context: false });
    setState(draft.candidates.length ? 'Proposed' : 'Draft', 'Stopped. Completed proposals were kept; late results will be ignored.');
    render();
}

async function closeWorkspace({ restoreFocus = true } = {}) {
    if (saving) {
        setState('Saving', 'Wait for the character save to finish before leaving Creator.');
        return false;
    }
    navigationId++;
    stopGeneration();
    if (!await preserveForNavigation()) return false;
    delete document.getElementById('sheld').dataset.sbCreatorMode;
    window.dispatchEvent(new CustomEvent('sb:creator-workspace-state-changed'));
    if (restoreFocus && launchFocus?.isConnected && launchFocus.getClientRects().length) launchFocus.focus({ preventScroll: true });
    else if (restoreFocus) document.getElementById('sb-character-toggle')?.focus({ preventScroll: true });
    return true;
}

function targetsInOrder() {
    const description = draft.working.description;
    const recipe = getCreatorRecipe(draft.recipeId);
    const blocks = description.mode === 'parts' && description.recipeId === recipe.id
        ? ['profile', 'voice'].filter(target => recipe.supportedTargets.includes(target)) : ['description'];
    return ['name', ...blocks, 'personality', 'scenario', 'mes_example', 'first_mes', ...draft.working.alternate_greetings.map(item => `greeting:${item.id}`)];
}

async function generate(targets, instruction = '') {
    if (busy() || !draft) return;
    if (invalidTokenInput !== undefined) throw new Error('Maximum output tokens per section must be a positive whole number.');
    if (!hasProfile()) throw new Error('Select an available saved connection profile before generating. Manual editing remains available.');
    if (!targets.length) throw new Error('Select at least one section to generate.');
    const allowed = targetsInOrder();
    if (targets.some(target => target !== 'questions' && !allowed.includes(target))) throw new Error('The selected section is no longer available. Review the generation selection.');
    const frozen = structuredClone(draft);
    const tentative = structuredClone(frozen);
    const run = { id: ++runId, controller: new AbortController(), owner: draft };
    activeRun = run;
    failure = null;
    draft.generationRunning = true;
    changed({ context: false });
    let currentTarget = targets[0];
    let hasTentative = false;
    try {
        for (const target of targets) {
            currentTarget = target;
            setState('Generating', `${titleFor(target)} · ${targets.indexOf(target) + 1} of ${targets.length}`);
            render();
            let value;
            if (target === 'description' && frozen.recipeId !== 'keep-existing') {
                const converted = { mode: 'parts', recipeId: frozen.recipeId, profile: '', voice: '' };
                const conversionDraft = structuredClone(tentative);
                conversionDraft.working.description = converted;
                for (const part of getCreatorRecipe(frozen.recipeId).descriptionTargets) {
                    const context = converted.profile || converted.voice ? projectCardFields(conversionDraft) : projectCardFields(tentative);
                    converted[part] = await generateCreatorTarget({ draft: conversionDraft, target: part, instruction, runContext: context, signal: run.controller.signal });
                    if (activeRun !== run) return;
                }
                value = converted;
            } else {
                value = await generateCreatorTarget({ draft: tentative, target, instruction, runContext: hasTentative ? projectCardFields(tentative) : null, signal: run.controller.signal });
            }
            if (activeRun !== run || draft !== run.owner) return;
            if (target === 'questions') {
                questions = value;
            } else {
                draft.candidates.push({ target, value, before: getDraftTarget(frozen, target), inputRevision: frozen.revision, runId: run.id });
                setDraftTarget(tentative, target, value);
                hasTentative = true;
            }
            changed({ context: false });
        }
        setState(draft.candidates.length ? 'Proposed' : 'Draft', targets[0] === 'questions' ? 'Questions are for your brief, not the character card. Add your answers below.' : 'Proposals are ready to review. Nothing has been accepted or saved to the card.');
        if (targets[0] === 'questions') pane = 'brief';
        else if (!['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) pane = 'review';
    } catch (error) {
        if (activeRun !== run) return;
        if (!isAbortLikeError(error, run.controller.signal)) {
            failure = { target: currentTarget, error, raw: error.rawOutput, before: currentTarget === 'questions' ? '' : getDraftTarget(frozen, currentTarget), inputRevision: frozen.revision, runId: run.id };
            setState('Draft', `${titleFor(currentTarget)} failed. The remaining queue was stopped; completed proposals were kept.`);
            pane = 'review';
        }
    } finally {
        if (activeRun === run) {
            activeRun = null;
            draft.generationRunning = false;
            changed({ context: false });
            render();
        }
    }
}

function accept(proposal) {
    acceptCandidate(draft, proposal);
    changed({ context: false });
    setState('Accepted', 'Accepted into the draft. Review and save when ready.');
    render();
}

function acceptAll() {
    // Validate the entire transition first, including overlapping whole-description/block proposals.
    const trial = structuredClone(draft);
    for (const proposal of [...trial.candidates]) acceptCandidate(trial, proposal);
    for (const proposal of [...draft.candidates]) acceptCandidate(draft, proposal);
    changed({ context: false });
    setState('Accepted', 'All proposals were accepted into the draft, not the card.');
    render();
}

function setProjectedField(fieldName, value) {
    if (fieldName === 'alternate_greetings') {
        draft.working.alternate_greetings = value.map(text => ({ id: draft.nextGreetingId++, text }));
        changed();
    } else {
        setDraftTarget(draft, fieldName, value);
        changed({ context: false });
    }
}

function resolveConflict(conflict, useProposal) {
    draft.baseline[conflict.field] = structuredClone(conflict.current);
    if (!useProposal) setProjectedField(conflict.field, conflict.current);
    conflicts = conflicts.filter(item => item !== conflict);
    changed();
    setState(conflicts.length ? 'Conflict' : 'Draft', 'Conflict choice recorded. Save again to check the latest card before applying changes.');
    render();
}

function changedFields() {
    const projected = projectCardFields(draft);
    const current = new Set(CARD_FIELDS.filter(key => !equal(projected[key], draft.baseline[key])));
    for (const key of current) if (!changedBefore.has(key)) selectedFields.add(key);
    for (const key of selectedFields) if (!current.has(key)) selectedFields.delete(key);
    changedBefore = current;
    return current;
}

async function saveCharacter() {
    if (busy() || !draft) return;
    if (draft.creationOutcomeUnknown) throw new Error('Check the character list before allowing another creation attempt.');
    const owner = draft;
    const fields = projectCardFields(owner);
    const selected = [...selectedFields];
    const cleared = selected.filter(key => (Array.isArray(fields[key]) ? fields[key].length === 0 : !fields[key].trim()) && (Array.isArray(owner.baseline[key]) ? owner.baseline[key].length > 0 : Boolean(owner.baseline[key])));
    if (owner.sourceAvatar && cleared.length && !await confirmAction('Clear selected fields?', `This will clear: ${cleared.map(key => LABELS[key]).join(', ')}.`, 'Clear and save')) return;
    saving = true;
    setState('Saving');
    render();
    try {
        if (owner.sourceAvatar) {
            const result = await saveCreatorChanges(owner, selected);
            if (result.status === 'conflict') {
                conflicts = result.conflicts;
                setState('Conflict', 'Selected fields changed elsewhere. Review each conflict before saving again.');
            } else {
                conflicts = [];
                setState('Saved', result.refreshError ? `Saved, but refresh failed: ${result.refreshError.message}. Do not repeat the write; reopen the editor to refresh.` : result.status === 'unchanged' ? 'The selected values are already saved.' : 'Selected changes saved. Existing chats were not changed.');
            }
            changed({ context: false });
            await persistNow();
        } else {
            const result = await createCreatorCard(fields);
            owner.sourceAvatar = result.avatar;
            reconcileSavedFields(owner, fields, result.fields);
            pendingNewDraftRemoval = owner;
            changed({ context: false });
            // Retry browser saves must also finish removing the old new-card slot.
            await persistNow();
            setState('Saved', result.refreshError ? `Created ${result.avatar}, but refresh failed: ${result.refreshError.message}. Do not create it again.` : `Created ${result.avatar}. Add an avatar or metadata in the existing editor.`);
        }
    } catch (error) {
        if (error.creationOutcomeUnknown) {
            owner.creationOutcomeUnknown = true;
            changed({ context: false });
        }
        setState('Draft', error.message);
    } finally {
        saving = false;
        render();
    }
}

async function openInEditor() {
    const avatar = draft?.sourceAvatar;
    if (!avatar || busy()) return;
    await flushCharacterSaveDebounced();
    await getOneCharacter(avatar);
    const index = characters.findIndex(character => character.avatar === avatar);
    if (index < 0) throw new Error('The saved character could not be loaded. Its draft is still available here.');
    if (!await closeWorkspace({ restoreFocus: false })) return;
    window.SillyBunnyShell?.openTab('characters', 'editor', { avatar });
}

function renderPending(body) {
    const section = node('section', 'sb-creator-recovery');
    if (!pending) return;
    const { avatar, fields, stored } = pending;
    section.append(node('h3', '', stored.corrupt ? 'Stored draft needs attention' : 'Resume your draft?'));
    section.append(node('p', '', stored.corrupt ? stored.error.message : 'Resume accepted edits and proposals, or explicitly discard this browser draft and start fresh. The saved card is not changed.'));
    if (stored.corrupt) section.append(action('Download stored record', () => download(stored.raw, 'creator-stored-record.json')));
    else section.append(action('Resume draft', () => { chooseDraft(stored); render(); }, { primary: true }));
    section.append(action('Discard and start fresh', async () => {
        if (!await confirmAction('Discard browser draft?', 'Accepted draft edits and unaccepted proposals in this draft will be removed. The saved character is unchanged.', 'Discard draft')) return;
        await discardDraft(avatar);
        chooseDraft(freshDraft(avatar, fields));
        render();
    }));
    body.append(section);
}

function renderBrief() {
    const section = node('section', 'sb-creator-pane sb-creator-brief');
    section.id = 'sb_creator_pane_brief';
    section.setAttribute('aria-label', 'Brief');
    section.append(node('h3', '', 'Character brief'));
    section.append(field('Idea and known facts', draft.brief, 'brief', value => { draft.brief = value; changed(); }, { rows: 7 }));
    const recipeLabel = node('label', 'sb-creator-field');
    recipeLabel.append(node('span', 'sb-creator-label', 'Writing recipe'));
    const select = node('select', 'text_pole');
    select.id = 'sb_creator_recipe';
    select.dataset.creatorLock = 'true';
    select.disabled = busy();
    const groups = new Map();
    for (const recipe of CREATOR_RECIPES) {
        if (!groups.has(recipe.family)) {
            const group = node('optgroup');
            group.label = recipe.family;
            groups.set(recipe.family, group);
            select.append(group);
        }
        groups.get(recipe.family).append(new Option(recipe.label, recipe.id));
    }
    select.value = draft.recipeId;
    select.addEventListener('change', () => {
        draft.recipeId = select.value;
        const available = targetsInOrder();
        const hadDescription = draft.generationTargets.some(target => ['profile', 'voice', 'description'].includes(target));
        draft.generationTargets = draft.generationTargets.filter(target => available.includes(target));
        if (hadDescription && available.includes('description') && !draft.generationTargets.includes('description')) draft.generationTargets.push('description');
        changed();
        setState('Draft', 'Recipe selected for future generation. Existing text was not rewritten.');
        render();
    });
    recipeLabel.append(select);
    section.append(recipeLabel);
    const profileLabel = node('label', 'sb-creator-field');
    profileLabel.append(node('span', 'sb-creator-label', 'Connection profile'));
    const profiles = node('select', 'text_pole');
    profiles.id = 'sb_creator_profile';
    profiles.disabled = busy();
    profiles.dataset.creatorLock = 'true';
    populateConnectionProfileSelect(profiles, { emptyLabel: 'Select a saved profile', selectedValue: draft.profileId });
    profiles.addEventListener('change', () => { draft.profileId = profiles.value; changed(); render(); });
    profileLabel.append(profiles);
    section.append(profileLabel);
    if (!hasProfile()) section.append(node('p', 'sb-creator-note', 'Generation needs a saved Chat Completion or Text Completion profile. You can still edit every section manually.'));
    const connectionActions = node('div', 'sb-creator-actions');
    connectionActions.append(action('Configure connections', () => window.SillyBunnyShell?.openTab('left', 'api'), { lock: true }), action('Refresh profiles', render, { lock: true }));
    section.append(connectionActions);
    section.append(action('Ask clarifying questions', () => generate(['questions']), { generate: true }));
    if (questions) section.append(node('pre', 'sb-creator-text', questions));
    section.append(field('Confirmed answers', draft.answers, 'answers', value => { draft.answers = value; changed(); }, { rows: 3 }));
    const settings = disclosure('Generation settings and recipe sources', 'generation-settings');
    settings.append(field('Additional instructions', draft.additionalInstructions, 'instructions', value => { draft.additionalInstructions = value; changed(); }));
    const ceiling = field('Maximum output tokens per section', invalidTokenInput ?? draft.sectionMaxTokens, 'section_tokens', (value, input) => {
        const number = Number(value);
        const valid = Number.isSafeInteger(number) && number > 0;
        invalidTokenInput = valid ? undefined : value;
        input.setCustomValidity(valid ? '' : 'Enter a positive whole number.');
        if (valid) { draft.sectionMaxTokens = number; changed(); }
    }, { type: 'number', lock: true });
    ceiling.querySelector('input').min = '1';
    ceiling.querySelector('input').step = '1';
    if (invalidTokenInput !== undefined) ceiling.querySelector('input').setCustomValidity('Enter a positive whole number.');
    settings.append(ceiling, node('p', 'sb-creator-note', 'Recipe selection guides generation, not which fields are saved. Connection and preset settings for your chats are unchanged.'));
    const recipe = getCreatorRecipe(draft.recipeId);
    settings.append(node('p', '', recipe.profileInstruction));
    for (const source of recipe.sources) {
        const link = node('a', 'sb-creator-source', source.label);
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        settings.append(link);
    }
    section.append(settings);
    return section;
}

function renderSection(target) {
    const section = node('section', 'sb-creator-section');
    const head = node('div', 'sb-creator-section-heading');
    const label = node('label', 'sb-creator-check');
    const check = node('input');
    check.type = 'checkbox';
    check.checked = draft.generationTargets.includes(target);
    check.disabled = busy();
    check.dataset.creatorLock = 'true';
    check.setAttribute('aria-label', `Include ${titleFor(target)} in generation`);
    check.addEventListener('change', () => {
        draft.generationTargets = check.checked ? [...draft.generationTargets, target] : draft.generationTargets.filter(item => item !== target);
        changed({ context: false });
    });
    label.append(check, node('span', '', titleFor(target)));
    head.append(label);
    const conversion = target === 'description' && draft.recipeId !== 'keep-existing';
    head.append(action(conversion ? 'Convert description' : 'Generate', () => generate([target]), { generate: true }));
    section.append(head);
    const value = getDraftTarget(draft, target);
    if (target === 'description' && value.mode === 'parts') {
        section.append(node('p', 'sb-creator-note', 'The current description uses another recipe. Conversion produces one reviewable proposal; it does not replace your draft automatically.'), node('pre', 'sb-creator-text', projectDescription(value)));
    } else {
        section.append(field(`Edit ${titleFor(target)}`, target === 'description' ? value.text : value, `field_${target}`, text => {
            setDraftTarget(draft, target, text);
            stateLabel = 'Draft';
            changed({ context: false });
        }, { type: target === 'name' ? 'text' : 'textarea', rows: ['profile', 'description', 'first_mes'].includes(target) ? 8 : 5 }));
    }
    const refine = disclosure('Refine this section', `refine_${target}`);
    refine.append(field('What should change?', refinements.get(target) || '', `refine_${target}`, text => refinements.set(target, text), { rows: 2 }));
    refine.append(action('Generate refinement', () => {
        const instruction = refinements.get(target)?.trim();
        if (!instruction) throw new Error('Describe the change before generating a refinement.');
        return generate([target], instruction);
    }, { generate: true }));
    section.append(refine);
    if (target.startsWith('greeting:')) {
        const id = Number(target.split(':')[1]);
        const index = draft.working.alternate_greetings.findIndex(item => item.id === id);
        const controls = node('div', 'sb-creator-actions');
        for (const [offset, text] of [[-1, 'Move up'], [1, 'Move down']]) {
            controls.append(action(text, () => {
                const items = draft.working.alternate_greetings;
                [items[index], items[index + offset]] = [items[index + offset], items[index]];
                changed();
                render();
            }, { lock: true, disabled: index + offset < 0 || index + offset >= draft.working.alternate_greetings.length }));
        }
        controls.append(action('Remove greeting', async () => {
            if (!await confirmAction('Remove alternate greeting?', 'Remove this slot from the draft? The saved card changes only after you save alternate greetings.', 'Remove slot')) return;
            draft.working.alternate_greetings = draft.working.alternate_greetings.filter(item => item.id !== id);
            draft.generationTargets = draft.generationTargets.filter(item => item !== target);
            changed();
            render();
        }, { lock: true }));
        section.append(controls);
    }
    return section;
}

function renderSections() {
    const section = node('section', 'sb-creator-pane sb-creator-sections');
    section.id = 'sb_creator_pane_sections';
    section.setAttribute('aria-label', 'Sections');
    section.append(node('h3', '', 'Draft sections'), node('p', 'sb-creator-note', 'Check only the sections you want the model to propose. Unchecked content stays in your draft.'));
    section.append(action('Generate selected', () => generate(targetsInOrder().filter(target => draft.generationTargets.includes(target))), { primary: true, generate: true }));
    if (draft.working.description.mode === 'parts') {
        section.append(action('Edit description as raw text', async () => {
            if (!await confirmAction('Switch to raw description?', 'The text will be preserved, but profile and voice block editing will stop. Returning to blocks requires an explicit conversion.', 'Use raw text')) return;
            setDraftTarget(draft, 'description', projectDescription(draft.working.description));
            draft.generationTargets = draft.generationTargets.filter(target => !['profile', 'voice'].includes(target));
            changed({ context: false });
            render();
        }, { lock: true }));
    }
    for (const target of targetsInOrder()) section.append(renderSection(target));
    section.append(action('Add alternate greeting', () => {
        const id = draft.nextGreetingId++;
        draft.working.alternate_greetings.push({ id, text: '' });
        changed();
        render();
        document.getElementById(`sb_creator_field_greeting_${id}`)?.focus();
    }, { lock: true }));
    return section;
}

function renderProposal(proposal, index) {
    const section = node('section', 'sb-creator-proposal');
    section.append(node('h4', '', `${titleFor(proposal.target)} · Proposed`));
    let current;
    let valid = true;
    try { current = getDraftTarget(draft, proposal.target); } catch { valid = false; }
    const stale = !valid || !equal(current, proposal.before);
    section.append(node('p', 'sb-creator-note', !valid ? 'This target no longer exists. Keep the proposed text for manual use or discard it.' : stale ? 'The target changed since generation. Compare both values and reconcile before accepting.' : proposal.inputRevision !== draft.revision ? 'Other draft context has changed since this proposal was requested. Review it before accepting.' : 'Accepting changes only the draft.'));
    const comparison = node('div', 'sb-creator-comparison');
    const currentPanel = node('div');
    currentPanel.append(node('h5', '', 'Current draft'), node('pre', 'sb-creator-text', valid ? textValue(current) : 'Target removed'));
    const proposedPanel = node('div');
    proposedPanel.append(node('h5', '', 'Proposed text'));
    if (typeof proposal.value === 'object' && proposal.value.mode === 'parts') {
        for (const part of ['profile', 'voice']) {
            if (!proposal.value[part] && !getCreatorRecipe(proposal.value.recipeId).descriptionTargets.includes(part)) continue;
            proposedPanel.append(field(LABELS[part], proposal.value[part], `proposal_${index}_${part}`, value => { proposal.value[part] = value; changed({ context: false }); }));
        }
    } else {
        proposedPanel.append(field('Edit proposal', textValue(proposal.value), `proposal_${index}`, value => {
            proposal.value = proposal.target === 'description' && typeof proposal.value === 'object' ? { mode: 'opaque', text: value } : value;
            changed({ context: false });
        }, { rows: 8 }));
    }
    comparison.append(currentPanel, proposedPanel);
    section.append(comparison);
    const controls = node('div', 'sb-creator-actions');
    controls.append(action('Accept into draft', () => accept(proposal), { lock: true, disabled: stale }));
    if (valid && stale) controls.append(action('Review against current draft', () => {
        proposal.before = getDraftTarget(draft, proposal.target);
        proposal.inputRevision = draft.revision;
        changed({ context: false });
        render();
    }, { lock: true }));
    controls.append(action('Discard proposal', () => {
        draft.candidates.splice(draft.candidates.indexOf(proposal), 1);
        changed({ context: false });
        render();
    }, { lock: true }));
    section.append(controls);
    return section;
}

function renderFailure(section) {
    if (!failure) return;
    const failed = failure;
    const block = node('section', 'sb-creator-notice');
    block.append(node('h4', '', `${titleFor(failed.target)} failed`), node('p', '', failed.error.message));
    block.append(action('Retry this section', () => generate([failed.target]), { generate: true }));
    if (typeof failed.raw === 'string') {
        block.append(field('Raw response — repair manually', failed.raw, 'failed_response', value => { failed.raw = value; }, { rows: 8 }));
        if (failed.target !== 'questions') block.append(action('Stage repaired text for review', () => {
            if (!failed.raw.trim()) throw new Error('Enter the repaired section text first.');
            draft.candidates.push({ target: failed.target, value: failed.raw, before: failed.before, inputRevision: failed.inputRevision, runId: failed.runId });
            failure = null;
            changed({ context: false });
            render();
        }, { lock: true }));
    }
    section.append(block);
}

function renderReview() {
    const section = node('section', 'sb-creator-pane sb-creator-review');
    section.id = 'sb_creator_pane_review';
    section.setAttribute('aria-label', 'Review');
    section.append(node('h3', '', 'Review proposals'));
    renderFailure(section);
    if (draft.candidates.length) {
        section.append(action('Accept all proposals into draft', acceptAll, { lock: true }));
        draft.candidates.forEach((proposal, index) => section.append(renderProposal(proposal, index)));
    } else section.append(node('p', 'sb-creator-note', 'No pending proposals. Manual edits and accepted text appear in the card review below.'));
    for (const conflict of conflicts) {
        const block = node('section', 'sb-creator-proposal');
        block.append(node('h4', '', `${LABELS[conflict.field]} · Conflict`));
        for (const [key, label] of [['baseline', 'Last loaded / saved'], ['current', 'Current saved card'], ['proposed', 'Your draft']]) {
            block.append(node('h5', '', label), node('pre', 'sb-creator-text', textValue(conflict[key])));
        }
        const controls = node('div', 'sb-creator-actions');
        controls.append(action('Keep current card value', () => resolveConflict(conflict, false), { lock: true }), action('Use proposal after review', () => resolveConflict(conflict, true), { lock: true }));
        block.append(controls);
        section.append(block);
    }
    section.append(node('h3', '', draft.sourceAvatar ? 'Save selected changes' : 'Create character'), node('p', 'sb-creator-note', 'Only accepted draft text is included. Pending proposals are excluded. Avatars, lorebooks, metadata and existing chats are not edited here.'));
    const projected = projectCardFields(draft);
    const changedSet = changedFields();
    for (const key of CARD_FIELDS) {
        const block = disclosure(`${LABELS[key]}${draft.sourceAvatar ? changedSet.has(key) ? ' · Changed' : ' · Unchanged' : ''}`, `review_${key}`);
        block.append(node('pre', 'sb-creator-text', textValue(projected[key]) || '(Empty)'));
        if (draft.sourceAvatar && changedSet.has(key)) {
            const label = node('label', 'sb-creator-check');
            const check = node('input');
            check.type = 'checkbox';
            check.checked = selectedFields.has(key);
            check.disabled = busy();
            check.dataset.creatorLock = 'true';
            check.addEventListener('change', () => { if (check.checked) selectedFields.add(key); else selectedFields.delete(key); });
            label.append(check, node('span', '', `Save ${LABELS[key]}`));
            block.append(label);
        }
        section.append(block);
    }
    if (draft.creationOutcomeUnknown) {
        section.append(node('p', 'sb-creator-notice', 'A previous creation request has an unknown outcome. Check the character list before retrying to avoid a duplicate.'));
        section.append(action('Open character list', () => window.SillyBunnyShell?.openTab('characters', 'characters'), { lock: true }));
        section.append(action('I checked; allow another attempt', async () => {
            if (!await confirmAction('Allow another creation attempt?', 'Continue only if the previous request did not create this character.', 'Allow retry')) return;
            draft.creationOutcomeUnknown = false;
            changed({ context: false });
            render();
        }, { lock: true }));
    }
    section.append(action(saving ? 'Saving…' : draft.sourceAvatar ? 'Save selected changes' : 'Create character', saveCharacter, { primary: true, lock: true, disabled: Boolean(draft.creationOutcomeUnknown) || Boolean(draft.sourceAvatar && !changedSet.size) }));
    if (draft.sourceAvatar) section.append(action('Open in editor', openInEditor, { lock: true }));
    return section;
}

function render() {
    if (!root) return;
    const focus = root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focus?.dataset.creatorFocus;
    const selection = focusKey && typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd] : null;
    const scroll = root.dataset.pane === pane ? root.querySelector('.sb-creator-body')?.scrollTop || 0 : 0;
    const disclosures = new Set(Array.from(root.querySelectorAll('details[open]'), element => element.dataset.creatorDetails));
    root.replaceChildren();
    root.dataset.pane = pane;
    const header = node('header', 'sb-creator-header');
    const heading = node('div', 'sb-creator-heading');
    const title = node('h2', '', 'Creator');
    title.tabIndex = -1;
    heading.append(title, node('p', 'sb-creator-note', draft?.sourceAvatar ? `Polish · ${draft.working.name || draft.sourceAvatar}` : 'Create a character card'));
    const back = action('Back', () => closeWorkspace(), { disabled: saving });
    header.append(heading, back);
    root.append(header);
    const status = node('p', 'sb-creator-status');
    status.dataset.creatorStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    root.append(status);
    if (message) root.append(node('p', 'sb-creator-notice', message));
    if (draft) {
        const toolbar = node('div', 'sb-creator-toolbar');
        toolbar.append(action('New character', () => openWorkspace({ avatar: null, startNew: true }), { lock: true }));
        const source = node('select', 'text_pole');
        source.setAttribute('aria-label', 'Choose a character to polish');
        source.dataset.creatorLock = 'true';
        source.disabled = busy();
        source.append(new Option('Polish an existing character…', ''));
        for (const character of characters) source.append(new Option(character.name || character.avatar, character.avatar));
        source.addEventListener('change', () => { if (source.value) void openWorkspace({ avatar: source.value }).catch(reportError); });
        toolbar.append(source);
        if (activeRun) toolbar.append(action('Stop generation', stopGeneration));
        root.append(toolbar);
        if (storageError) {
            const notice = node('div', 'sb-creator-notice');
            notice.append(node('p', '', `Browser storage failed: ${storageError.message}. The draft is still in memory; character saving remains available.`));
            notice.append(action('Retry browser save', async () => { await persistNow(); render(); }), action('Download draft', () => download(draft, 'creator-draft.json')));
            root.append(notice);
        }
        const tabs = node('div', 'sb-creator-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Creator sections');
        for (const [key, label] of [['brief', 'Brief'], ['sections', 'Sections'], ['review', `Review${draft.candidates.length ? ` (${draft.candidates.length})` : ''}`]]) {
            const tab = action(label, () => { pane = key; render(); });
            tab.id = `sb_creator_tab_${key}`;
            // The legacy accessibility observer assigns role=button to .menu_button.
            tab.classList.remove('menu_button');
            tab.dataset.pane = key;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(pane === key));
            tab.setAttribute('aria-controls', `sb_creator_pane_${key}`);
            tab.tabIndex = pane === key ? 0 : -1;
            tab.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const options = ['brief', 'sections', 'review'];
                pane = event.key === 'Home' ? options[0] : event.key === 'End' ? options[2] : options[(options.indexOf(key) + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
                render();
                root.querySelector(`#sb_creator_tab_${pane}`)?.focus();
            });
            tabs.append(tab);
        }
        root.append(tabs);
    }
    const body = node('div', 'sb-creator-body');
    if (draft) body.append(renderBrief(), renderSections(), renderReview());
    else renderPending(body);
    root.append(body);
    if (draft) {
        const footer = node('footer', 'sb-creator-footer');
        footer.append(action('Download draft', () => download(draft, 'creator-draft.json')));
        footer.append(action('Discard browser draft', async () => {
            if (!await confirmAction('Discard this browser draft?', 'Remove accepted edits and proposals from this browser draft? The saved card is not changed.', 'Discard draft')) return;
            clearTimeout(saveTimer);
            const avatar = draft.sourceAvatar;
            await discardDraft(avatar);
            const fields = avatar ? (await loadCreatorSource(avatar)).fields : null;
            chooseDraft(freshDraft(avatar, fields));
            render();
        }, { lock: true }));
        root.append(footer);
    }
    for (const details of root.querySelectorAll('details')) details.open = disclosures.has(details.dataset.creatorDetails);
    body.scrollTop = scroll;
    if (focusKey) {
        const input = Array.from(root.querySelectorAll('[data-creator-focus]')).find(element => element.dataset.creatorFocus === focusKey);
        if (input?.getClientRects().length) {
            input.focus({ preventScroll: true });
            if (selection && typeof input.setSelectionRange === 'function') input.setSelectionRange(...selection);
        }
    } else if (focus?.id) {
        const control = document.getElementById(focus.id);
        if (root.contains(control) && control?.getClientRects().length) control.focus({ preventScroll: true });
    }
    updateStatus();
    syncPolishButton();
}

function init() {
    if (root) return;
    root = node('section', 'sb-creator-workspace');
    root.id = 'sb_character_creator_workspace';
    root.setAttribute('aria-label', 'Creator workspace');
    document.getElementById('sheld').append(root);
    root.addEventListener('focusout', () => { void persistNow(); });
    window.addEventListener('sb:open-creator-workspace', event => { void openWorkspace(event.detail || {}).catch(reportError); });
    window.addEventListener('sb:close-creator-workspace', event => {
        void closeWorkspace().then(closed => { if (closed) event.detail?.onClosed?.(); }).catch(reportError);
    });
    document.getElementById('sb_character_creator_polish')?.addEventListener('click', () => {
        const avatar = editorAvatar();
        if (avatar) void openWorkspace({ avatar }).catch(reportError);
    });
    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, syncPolishButton);
    eventSource.on(event_types.CHARACTER_EDITED, syncPolishButton);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (isOpen() || opening) void closeWorkspace({ restoreFocus: false }).catch(reportError);
    });
    const form = document.getElementById('form_create');
    if (form) new MutationObserver(syncPolishButton).observe(form, { attributes: true, attributeFilter: ['actiontype'] });
    window.addEventListener('beforeunload', event => {
        if (saving || activeRun || storageError || localVersion !== storedVersion) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    window.addEventListener('pagehide', () => { if (draft) void persistNow(); });
    syncPolishButton();
}

eventSource.on(event_types.APP_READY, init);
