// Artist lists for random selection
const ARTISTS_NATURAL = ["a1 (initial-g)", "abubu", "afrobull", "aiue oka", "akairiot", "akamatsu ken", "alex ahad", "alzi xiaomi", "amazuyu tatsuki", "aoi nagisa (metalder)", "ask (askzy)", "atdan", "awa", "ayami kojima", "azasuke", "azto dio", "bkub", "blade (galaxist)", "boris (noborhys)", "bow (bhp)", "butcha-u", "chouzuki maryou", "ciloranko", "circle anco", "crote", "dagasi", "dairi", "dino (dinoartforame)", "dishwasher1910", "drawfag", "dsmile", "ebifurya", "eroquis", "fkey", "fuzichoco", "gomennasai", "hammer (sunset beach)", "hana kazari", "hara (harayutaka)", "haruyama kazunori", "hews", "hiroki (yyqw7151)", "hiten", "hoshi (snacherubi)", "inoino", "itomugi-kun", "ixy", "kagami hirotaka", "kanon (kurogane knights)", "kantoku", "kawacy", "ke-ta", "kou hiyoyo", "kouji (campus life)", "kuavera", "kuon (kwonchan)", "lack", "lm7", "lolita channel", "m-da s-tarou", "matsunaga kouyou", "mika pikazo", "mikeinel", "mizuki hitoshi", "mizumizuni", "morikura en", "naga u", "nardack", "neco", "nel-zel formula", "neocoill", "nian", "nixeu", "nyamota", "nyantcha", "ojipon", "onikobe rin", "piromizu", "pochi (pochi-goya)", "qp:flapper", "rebecca (keinelove)", "redjuice", "rei (sanbonzakura)", "rurudo", "ruu (tksymkw)", "shirataki", "sincos", "sky-freedom", "tofuubear", "tony taka", "tukiwani", "wanke", "yaegashi nan", "yamakaze", "yoko juusuke", "yoshiaki", "yuuki tatsuya"];

const ARTISTS_TAGS = ["a1_(initial-g)", "abubu", "afrobull", "aiue_oka", "akairiot", "akamatsu_ken", "alex_ahad", "alzi_xiaomi", "amazuyu_tatsuki", "aoi_nagisa_(metalder)", "ask_(askzy)", "atdan", "awa", "ayami_kojima", "azasuke", "azto_dio", "bkub", "blade_(galaxist)", "boris_(noborhys)", "bow_(bhp)", "butcha-u", "chouzuki_maryou", "ciloranko", "circle_anco", "crote", "dagasi", "dairi", "dino_(dinoartforame)", "dishwasher1910", "drawfag", "dsmile", "ebifurya", "eroquis", "fkey", "fuzichoco", "gomennasai", "hammer_(sunset_beach)", "hana_kazari", "hara_(harayutaka)", "haruyama_kazunori", "hews", "hiroki_(yyqw7151)", "hiten", "hoshi_(snacherubi)", "inoino", "itomugi-kun", "ixy", "kagami_hirotaka", "kanon_(kurogane_knights)", "kantoku", "kawacy", "ke-ta", "kou_hiyoyo", "kouji_(campus_life)", "kuavera", "kuon_(kwonchan)", "lack", "lm7", "lolita_channel", "m-da_s-tarou", "matsunaga_kouyou", "mika_pikazo", "mikeinel", "mizuki_hitoshi", "mizumizuni", "morikura_en", "naga_u", "nardack", "neco", "nel-zel_formula", "neocoill", "nian", "nixeu", "nyamota", "nyantcha", "ojipon", "onikobe_rin", "piromizu", "pochi_(pochi-goya)", "qp:flapper", "rebecca_(keinelove)", "redjuice", "rei_(sanbonzakura)", "rurudo", "ruu_(tksymkw)", "shirataki", "sincos", "sky-freedom", "tofuubear", "tony_taka", "tukiwani", "wanke", "yaegashi_nan", "yamakaze", "yoko_juusuke", "yoshiaki", "yuuki_tatsuya"];

function getRandomArtist(useTagFormat = false) {
    const artists = useTagFormat ? ARTISTS_TAGS : ARTISTS_NATURAL;
    return artists[Math.floor(Math.random() * artists.length)];
}

const extensionName = "quick-image-gen";
let extension_settings, getContext, saveSettingsDebounced, saveSettings, generateQuietPrompt, generateRaw, generateRawData, createRawPrompt, secret_state, rotateSecret, getRequestHeaders;
let createGenerationParameters, getChatCompletionModel;
let saveBase64AsFile, getSanitizedFilename, humanizedDateTime;

const DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT = "You are a visual image generation assistant. Use the user's text as the image instruction and any attached images as visual references. Return the generated image in the provider's supported image format.";
const DEFAULT_PROXY_CHAT_IMAGE_MAX_TOKENS = 16384;
const DEFAULT_PROXY_STANDARD_CHAT_MAX_TOKENS = 4096;
const PROXY_CHAT_IMAGE_MAX_TOKENS_MIN = 1;
const PROXY_CHAT_IMAGE_MAX_TOKENS_MAX = 65536;
const AUTO_GENERATE_EVERY_DEFAULT = 1;
const AUTO_GENERATE_EVERY_MIN = 1;
const AUTO_GENERATE_EVERY_MAX = 100;
const AUTO_GENERATE_DELAY_DEFAULT = 500;
const AUTO_GENERATE_DELAY_MIN = 0;
const AUTO_GENERATE_DELAY_MAX = 60000;

const PROXY_CHAT_IMAGE_DEFAULTS = Object.freeze({
    proxyChatImageMode: false,
    proxyChatImageAllowImagesEndpoint: false,
    proxyChatImageSystemPrompt: DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT,
    proxyChatImageIncludePersonality: false,
    proxyChatImageMaxTokens: DEFAULT_PROXY_CHAT_IMAGE_MAX_TOKENS,
});

const DEFAULT_INJECT_TAG_NAME = "image";
const LEGACY_INJECT_PROMPT_DEFAULT = 'When describing a scene visually, include an image tag: <pic prompt="detailed visual description">\nUse this for important visual moments. The prompt should describe the scene in detail including character appearances, poses, expressions, clothing, and setting.';
const LEGACY_INJECT_REGEX_DEFAULT = '<pic\\s+prompt="([^"]+)"\\s*/?>';
const DUAL_INJECT_PROMPT_DEFAULT = 'When describing a scene visually, include an image tag using one of these formats:\n- Simple: <image>detailed visual description</image>\n- Alternative: <pic prompt="detailed visual description">\nUse this for important visual moments. The description should detail character appearances, poses, expressions, clothing, and setting.';
const DUAL_INJECT_REGEX_DEFAULT = '<pic\\s+prompt="([^"]+)"\\s*/?>|<image>([\\s\\S]*?)</image>';

function escapeRegex(text) {
    return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInjectTagName(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "");
    return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : DEFAULT_INJECT_TAG_NAME;
}

function buildDefaultInjectPrompt(tagName = DEFAULT_INJECT_TAG_NAME) {
    const safeTagName = normalizeInjectTagName(tagName);
    return `When describing a scene visually, include an image tag using one of these formats:\n- Simple: <${safeTagName}>detailed visual description</${safeTagName}>\n- Alternative: <pic prompt="detailed visual description">\nUse this for important visual moments. The description should detail character appearances, poses, expressions, clothing, and setting.`;
}

function buildDefaultInjectRegex(tagName = DEFAULT_INJECT_TAG_NAME) {
    const normalizedTag = normalizeInjectTagName(tagName);
    const pairedTagNames = [...new Set([normalizedTag, DEFAULT_INJECT_TAG_NAME])];
    const pairedPatterns = pairedTagNames.map(name => `<${escapeRegex(name)}>([\\s\\S]*?)<\\/${escapeRegex(name)}>`);
    return [...pairedPatterns, LEGACY_INJECT_REGEX_DEFAULT].join("|");
}

function isGeneratedInjectPrompt(value, tagName = DEFAULT_INJECT_TAG_NAME) {
    if (typeof value !== "string") return false;
    return [
        buildDefaultInjectPrompt(tagName),
        DUAL_INJECT_PROMPT_DEFAULT,
        LEGACY_INJECT_PROMPT_DEFAULT,
    ].includes(value);
}

function isGeneratedInjectRegex(value, tagName = DEFAULT_INJECT_TAG_NAME) {
    if (typeof value !== "string") return false;
    return [
        buildDefaultInjectRegex(tagName),
        DUAL_INJECT_REGEX_DEFAULT,
        LEGACY_INJECT_REGEX_DEFAULT,
    ].includes(value);
}

function getInjectTagName(settings) {
    return normalizeInjectTagName(settings?.injectTagName ?? DEFAULT_INJECT_TAG_NAME);
}

function getInjectPromptTemplate(settings) {
    return typeof settings?.injectPrompt === "string" && settings.injectPrompt.trim()
        ? settings.injectPrompt
        : buildDefaultInjectPrompt(getInjectTagName(settings));
}

function getInjectRegexPattern(settings) {
    return typeof settings?.injectRegex === "string" && settings.injectRegex.trim()
        ? settings.injectRegex
        : buildDefaultInjectRegex(getInjectTagName(settings));
}

function getInjectTagPreview(tagName = DEFAULT_INJECT_TAG_NAME) {
    const safeTagName = normalizeInjectTagName(tagName);
    return `<${safeTagName}>detailed visual description</${safeTagName}>`;
}

function normalizeOutputMode(value) {
    return String(value || "").trim().toLowerCase() === "image_url" ? "image_url" : "inline";
}

function normalizeManualInsertTarget(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "user" || normalized === "latest") return normalized;
    return "assistant";
}

function normalizePaletteMode(value) {
    return String(value || "").trim().toLowerCase() === "inject" ? "inject" : "direct";
}

const NANOBANANA_MODEL_OPTIONS = [
    { id: "gemini-3-pro-image-preview", name: "Nano Banana Pro (Gemini 3 Pro Image)" },
    { id: "gemini-3.1-flash-image-preview", name: "Nano Banana 2 (Gemini 3.1 Flash Image)" },
    { id: "gemini-2.5-flash-image", name: "Nano Banana (Gemini 2.5 Flash Image)" },
    { id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash Exp" },
];

const NBP_DIRECTOR_PROMPTS = {
    house: {
        name: "TLD House Anime",
        text: [
            "You are an expert anime illustration director specializing in high-production character art in a Girls' Frontline 2 / Realistic Nijigen-inspired style.",
            "Render anime first and polished second: a refined anime CG illustration, never a filtered photograph, oily glamour render, or flat cartoon.",
            "Face: fully anime-styled with large expressive eyes, soft simplified features, small nose and mouth, even readable lighting, visible iris color, layered catchlights, and clear emotional expression.",
            "Skin: smooth, stylized, cleanly shaded with soft tonal transitions and small controlled anime-CG highlight accents only where light naturally catches rounded forms.",
            "Hair: stylized grouped strands with layered highlight bands and clear volume separation.",
            "Clothing: believable fabric weight, fold logic, tension, seams, and material distinction while staying inside an anime illustration language.",
            "Legwear: when present, render as a distinct surface over skin with controlled material highlights and clean transitions.",
            "Feet: when visible, render clean anatomy, continuous limb path, natural arches and soles, exactly five toes per foot with clear toe separation, soft warm accents, and tasteful anime-CG sheen.",
            "Toenails: when visible, treat as distinct surfaces from skin and preserve existing polish color, finish, edge shape, and gloss character.",
            "Anatomical accuracy: exactly two arms, two legs, five fingers per hand, five toes per foot. Every limb traces a continuous path from joint to extremity and bends only in anatomically possible directions.",
            "When reference images are provided, use them as the identity, outfit, pose, composition, and value-structure anchor. Change only what the prompt requests.",
        ].join(" "),
    },
    preservation: {
        name: "Reference Preservation",
        text: [
            "This is a localized preservation edit. The source image is the primary anchor.",
            "Preserve character identity, face, hairstyle, outfit design, composition, lighting intensity, value range, and non-target regions.",
            "Repair or enhance only the requested region. Do not globally reinterpret, beautify, redesign, or increase contrast unless explicitly requested.",
            "Use controlled satin highlights only. Keep the image anime first, polished second.",
        ].join(" "),
    },
    structural: {
        name: "Anatomy Repair",
        text: [
            "Prioritize anatomical construction and continuity.",
            "Correct only visible structural errors. Ensure exactly two arms, two legs, five fingers per hand, and five toes per foot.",
            "Every limb must trace a continuous path from joint to extremity. Joints bend only in anatomically possible directions.",
            "Do not idealize, redesign, change outfit details, or change the scene beyond the requested correction.",
        ].join(" "),
    },
    custom: {
        name: "Custom Director",
        text: "",
    },
};

const NBP_NEGATIVE_GUIDANCE = "Avoid wet-looking skin, oily shine, greasy gloss, plastic skin, blown white highlight patches, exaggerated redness, extra toes, fused toes, missing toes, malformed feet, broken ankles, extra limbs, missing limbs, stronger contrast than the source image, photorealistic face drift, flat cartoon simplification, text, watermark, and signature.";
const NANOBANANA_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const NANOBANANA_FLASH31_EXTRA_RATIOS = ["1:4", "1:8", "4:1", "8:1"];
const QIG_DEFAULT_COLLAPSED_SECTIONS = {
    providerSettings: false,
    promptAdvanced: false,
    injectOptions: true,
    advancedSettings: true,
};
let qigKeyboardShortcutsBound = false;

function normalizeNbpDirectorPreset(value) {
    return NBP_DIRECTOR_PROMPTS[value] ? value : "house";
}

function buildNbpDirectorInstruction(settings = getSettings()) {
    if (!settings?.nanobananaNbpMode) return "";
    const presetKey = normalizeNbpDirectorPreset(settings.nanobananaNbpPreset);
    const customDirector = String(settings.nanobananaNbpCustomDirector || "").trim();
    const preset = presetKey === "custom"
        ? (customDirector || NBP_DIRECTOR_PROMPTS.house.text)
        : (NBP_DIRECTOR_PROMPTS[presetKey]?.text || NBP_DIRECTOR_PROMPTS.house.text);
    const custom = String(settings.nanobananaNbpCustomPrompt || "").trim();
    const useNegativeGuidance = settings.nanobananaNbpUseNegative !== false;
    return [
        "Nano Banana Pro director instructions:",
        preset,
        custom ? `Scene-specific house direction: ${custom}` : "",
        useNegativeGuidance ? `Negative guidance: ${NBP_NEGATIVE_GUIDANCE}` : "",
    ].filter(Boolean).join(" ");
}

function buildNanobananaModelOptions(selectedModel) {
    const selected = String(selectedModel || "").trim();
    const seen = new Set();
    const options = NANOBANANA_MODEL_OPTIONS.map(model => {
        seen.add(model.id);
        return `<option value="${escapeHtml(model.id)}" ${selected === model.id ? "selected" : ""}>${escapeHtml(model.name)}</option>`;
    });
    if (selected && !seen.has(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(`${selected} (custom saved model)`)}</option>`);
    }
    return options.join("");
}

function getCollapsedSections(settings = getSettings()) {
    const stored = settings?.collapsedSections && typeof settings.collapsedSections === "object"
        ? settings.collapsedSections
        : {};
    return { ...QIG_DEFAULT_COLLAPSED_SECTIONS, ...stored };
}

function setCollapsedSection(sectionId, collapsed, { persist = true } = {}) {
    const s = getSettings();
    if (!s) return;
    s.collapsedSections = { ...getCollapsedSections(s), [sectionId]: !!collapsed };
    if (persist) saveSettingsDebounced?.();
}

function isEditableShortcutTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function bindQigKeyboardShortcuts() {
    if (qigKeyboardShortcutsBound) return;
    qigKeyboardShortcutsBound = true;
    document.addEventListener("keydown", (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || isEditableShortcutTarget(event.target)) return;
        const key = String(event.key || "").toLowerCase();
        if (key === "enter") {
            const generateBtn = document.getElementById("qig-generate-btn");
            if (!generateBtn || generateBtn.disabled || isGenerating) return;
            event.preventDefault();
            runConfiguredPaletteGeneration();
            return;
        }
        if (!event.shiftKey) return;
        if (key === "g") {
            event.preventDefault();
            showGallery();
        } else if (key === "h") {
            event.preventDefault();
            showPromptHistory();
        }
    });
}

function setupQigCollapsibleSection(sectionId, buttonId, contentId) {
    const button = document.getElementById(buttonId);
    const content = document.getElementById(contentId);
    if (!button || !content) return;
    const apply = (collapsed) => {
        button.setAttribute("aria-expanded", collapsed ? "false" : "true");
        content.hidden = collapsed;
        content.classList.toggle("qig-collapsible__content--collapsed", collapsed);
        const icon = button.querySelector(".qig-collapsible__icon");
        if (icon) {
            icon.classList.toggle("fa-chevron-right", collapsed);
            icon.classList.toggle("fa-chevron-down", !collapsed);
        }
    };
    apply(button.getAttribute("aria-expanded") === "false");
    button.onclick = () => {
        const collapsed = button.getAttribute("aria-expanded") !== "false";
        setCollapsedSection(sectionId, collapsed);
        apply(collapsed);
    };
}

function getNanobananaAspectRatio(settings = getSettings()) {
    const width = Math.max(1, parseIntOr(settings?.width, SIZE_DEFAULT));
    const height = Math.max(1, parseIntOr(settings?.height, SIZE_DEFAULT));
    const ratio = width / height;
    const options = /3\.1.*flash/i.test(settings?.nanobananaModel || "")
        ? [...NANOBANANA_ASPECT_RATIOS, ...NANOBANANA_FLASH31_EXTRA_RATIOS]
        : NANOBANANA_ASPECT_RATIOS;
    return options.reduce((best, option) => {
        const [w, h] = option.split(":").map(Number);
        const score = Math.abs(Math.log(ratio / (w / h)));
        return score < best.score ? { value: option, score } : best;
    }, { value: "1:1", score: Number.POSITIVE_INFINITY }).value;
}

function getNanobananaImageSize(settings = getSettings()) {
    if (!/gemini-3/i.test(settings?.nanobananaModel || "")) return null;
    const maxSide = Math.max(parseIntOr(settings?.width, SIZE_DEFAULT), parseIntOr(settings?.height, SIZE_DEFAULT));
    if (/3\.1.*flash/i.test(settings?.nanobananaModel || "") && maxSide <= 512) return "512";
    if (maxSide >= 3072) return "4K";
    if (maxSide >= 1536) return "2K";
    return "1K";
}

function applyChatGptNbpWorkflowPreset({ persist = true, notify = true } = {}) {
    const s = getSettings();
    Object.assign(s, {
        provider: "nanobanana",
        nanobananaModel: "gemini-3-pro-image-preview",
        nanobananaNbpMode: true,
        nanobananaNbpPreset: "house",
        nanobananaNbpUseNegative: true,
        useLastMessage: true,
        messageRange: "-1",
        useLLMPrompt: true,
        llmPromptStyle: "natural",
        llmEditPrompt: false,
        appendQuality: true,
        style: "none",
        width: 1024,
        height: 1536,
        batchCount: 1,
        sequentialSeeds: false,
        autoInsert: true,
        outputMode: "inline",
        manualInsertTarget: "assistant",
    });
    if (persist) saveSettingsDebounced?.();
    if (notify) toastr?.success?.("Configured ChatGPT + Nano Banana Pro workflow");
    return s;
}

const defaultSettings = {
    provider: "pollinations",
    style: "none",
    prompt: "{{char}} in the current scene",
    negativePrompt: "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, deformed, ugly, duplicate, morbid, mutilated, out of frame, mutation, disfigured",
    qualityTags: "masterpiece, best quality, highly detailed, sharp focus, 8k",
    appendQuality: true,
    useLastMessage: true,
    useLLMPrompt: false,
    llmPromptStyle: "tags",
    llmCustomInstruction: "",
    llmEditPrompt: false,
    llmAddQuality: false,
    llmAddLighting: false,
    llmAddArtist: false,
    llmPrefill: "",
    messageRange: "-1",
    width: 512,
    height: 512,
    steps: 25,
    cfgScale: 7,
    sampler: "euler_a",
    seed: -1,
    autoGenerate: false,
    autoGenerateEveryMessages: AUTO_GENERATE_EVERY_DEFAULT,
    autoGenerateDelayMs: AUTO_GENERATE_DELAY_DEFAULT,
    twoStepPrompt: false,
    twoStepInstruction: "",
    autoSetBackground: false,
    backgroundMode: "temporary",
    autoInsert: false,
    outputMode: "inline",
    manualInsertTarget: "assistant",
    insertAsHiddenReply: false,
    saveToServer: false,
    saveToServerEmbedMetadata: true,
    disablePaletteButton: false,
    paletteMode: "direct",
    confirmBeforeGenerate: false,
    enableParagraphPicker: false,
    batchCount: 1,
    sequentialSeeds: false,
    lastLoadedPresetId: "",
    // Reverse Proxy
    proxyUrl: "",
    proxyKey: "",
    proxyModel: "",
    proxyLoras: "",
    proxyFacefix: false,
    proxySteps: 25,
    proxyCfg: 6,
    proxySampler: "Euler a",
    proxySeed: -1,
    proxyRefImages: [],
    proxyExtraInstructions: "",
    proxyEndpointMode: "auto",
    proxyPayloadMode: "extended",
    proxyRefImageMode: "auto",
    proxySse: "auto",
    proxyTimeout: 600,
    proxyComfyMode: false,
    proxyComfyTimeout: 300,
    proxyComfyNodeId: "",
    proxyComfyWorkflow: "",
    // New-API / chat-completions image workflow
    ...PROXY_CHAT_IMAGE_DEFAULTS,
    // NovelAI
    naiKey: "",
    naiModel: "nai-diffusion-4-5-curated",
    naiProxyUrl: "",
    naiProxyKey: "",
    // OpenAI GPT Image
    gptImageKey: "",
    gptImageModel: "gpt-image-2",
    gptImageProxyUrl: "",
    gptImageProxyKey: "",
    gptImageQuality: "auto",
    gptImageFormat: "png",
    gptImageBackground: "auto",
    gptImageModeration: "auto",
    // ArliAI
    arliKey: "",
    arliModel: "arliai-realistic-v1",
    // Routeway
    routewayKey: "",
    routewayModel: "flux-1-schnell",
    // Navy.ai
    navyKey: "",
    navyModel: "flux",
    // NanoGPT
    nanogptKey: "",
    nanogptModel: "image-flux-schnell",
    nanogptRefImages: [],
    nanogptStrength: 0.75,
    // Chutes
    chutesKey: "",
    chutesModel: "stabilityai/stable-diffusion-xl-base-1.0",
    // CivitAI
    civitaiKey: "",
    civitaiModel: "urn:air:sd1:checkpoint:civitai:4201@130072",
    civitaiScheduler: "EulerA",
    civitaiLoras: "",
    // Nanobanana (Gemini)
    nanobananaKey: "",
    nanobananaModel: "gemini-3-pro-image-preview",
    nanobananaNbpMode: true,
    nanobananaNbpPreset: "house",
    nanobananaNbpUseNegative: true,
    nanobananaNbpCustomDirector: "",
    nanobananaNbpCustomPrompt: "",
    nanobananaExtraInstructions: "",
    nanobananaRefImages: [],
    collapsedSections: { ...QIG_DEFAULT_COLLAPSED_SECTIONS },
    // Stability AI
    stabilityKey: "",
    // Replicate
    replicateKey: "",
    replicateModel: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
    // Fal.ai
    falKey: "",
    falModel: "fal-ai/flux/schnell",
    // Together AI
    togetherKey: "",
    togetherModel: "stabilityai/stable-diffusion-xl-base-1.0",
    // Z.AI
    zaiKey: "",
    zaiModel: "cogview-4-250304",
    zaiQuality: "hd",
    // Pollinations
    pollinationsKey: "",
    pollinationsModel: "",
    // Local (A1111/ComfyUI)
    localUrl: "http://127.0.0.1:7860",
    localType: "a1111",
    localModel: "model.safetensors",
    localRefImage: "",
    localDenoise: 0.75,
    // A1111 specific
    a1111Model: "",
    a1111ClipSkip: 1,
    a1111Scheduler: "Automatic",
    a1111RestoreFaces: false,
    a1111Tiling: false,
    a1111Subseed: -1,
    a1111SubseedStrength: 0,
    a1111Adetailer: false,
    a1111AdetailerModel: "face_yolov8n.pt",
    a1111AdetailerPrompt: "",
    a1111AdetailerNegative: "",
    a1111AdetailerDenoise: 0.4,
    a1111AdetailerConfidence: 0.3,
    a1111AdetailerMaskBlur: 4,
    a1111AdetailerDilateErode: 4,
    a1111AdetailerInpaintOnlyMasked: true,
    a1111AdetailerInpaintPadding: 32,
    a1111Adetailer2: false,
    a1111Adetailer2Model: "hand_yolov8n.pt",
    a1111Adetailer2Prompt: "",
    a1111Adetailer2Negative: "",
    a1111Adetailer2Denoise: 0.4,
    a1111Adetailer2Confidence: 0.3,
    a1111Adetailer2MaskBlur: 4,
    a1111Adetailer2DilateErode: 4,
    a1111Adetailer2InpaintOnlyMasked: true,
    a1111Adetailer2InpaintPadding: 32,
    a1111Loras: "",
    a1111Vae: "",
    a1111HiresFix: false,
    a1111HiresUpscaler: "Latent",
    a1111HiresScale: 2,
    a1111HiresSteps: 0,
    a1111HiresDenoise: 0.55,
    a1111HiresSampler: "",
    a1111HiresScheduler: "",
    a1111HiresPrompt: "",
    a1111HiresNegative: "",
    a1111HiresResizeX: 0,
    a1111HiresResizeY: 0,
    a1111IpAdapter: false,
    a1111IpAdapterMode: "ip-adapter-faceid-portrait_sd15",
    a1111IpAdapterWeight: 0.7,
    a1111IpAdapterPixelPerfect: true,
    a1111IpAdapterResizeMode: "Crop and Resize",
    a1111IpAdapterControlMode: "Balanced",
    a1111IpAdapterStartStep: 0,
    a1111IpAdapterEndStep: 1,
    // A1111 Generic ControlNet
    a1111ControlNet: false,
    a1111ControlNetModel: "",
    a1111ControlNetModule: "none",
    a1111ControlNetWeight: 1.0,
    a1111ControlNetResizeMode: "Crop and Resize",
    a1111ControlNetControlMode: "Balanced",
    a1111ControlNetPixelPerfect: true,
    a1111ControlNetGuidanceStart: 0,
    a1111ControlNetGuidanceEnd: 1,
    a1111ControlNetImage: "",
    a1111SaveToWebUI: true,
    // ComfyUI specific
    comfyWorkflow: "",
    comfyClipSkip: 1,
    comfyDenoise: 1.0,
    comfyScheduler: "normal",
    comfyTimeout: 300,
    comfyUpscale: false,
    comfyUpscaleModel: "RealESRGAN_x4plus.pth",
    comfyLoras: "",
    // ST Style integration
    useSTStyle: true,
    // Inject Mode (wickedcode01-style)
    injectEnabled: false,
    injectTagName: DEFAULT_INJECT_TAG_NAME,
    injectPrompt: buildDefaultInjectPrompt(DEFAULT_INJECT_TAG_NAME),
    injectRegex: buildDefaultInjectRegex(DEFAULT_INJECT_TAG_NAME),
    injectPosition: "afterScenario",
    injectDepth: 0,
    injectInsertMode: "replace",
    injectAutoClean: true,
    // LLM Override (separate AI for image prompts via Connection Manager)
    llmOverrideEnabled: false,
    llmOverrideProfileId: "",
    llmOverridePreset: "",
    llmOverrideMaxTokens: 500,
    // ComfyUI Flux/UNET support
    comfySkipNegativePrompt: false,
    comfyFluxClipModel1: "",
    comfyFluxClipModel2: "",
    comfyFluxVaeModel: "",
    comfyFluxClipType: "flux",
    _replacementMapsMigrated: false,
    _legacyTemplatesIgnored: false,
    // Backups of localStorage stores (survive browser storage wipes)
    _backupCharSettings: null,
    _backupProfiles: null,
    _backupCharRefImages: null,
    _backupGenPresets: null,
    _backupComfyWorkflows: null,
    _backupContextualFilters: null,
    _backupFilterPools: null,
    _backupActiveFilterPoolIdsByCard: null,
    _backupActiveFilterPoolIdsGlobal: null,
    _backupActiveFilterPoolIdsByChar: null,
};

let lastPrompt = "";
let lastNegative = "";
let lastPromptWasLLM = false;
let lastProxyContextRefImages = [];
let lastGenerationSourceMessageIndex = null;
let originalPrompt = "";
let originalNegative = "";
function safeParse(key, fallback) {
    try {
        const val = JSON.parse(localStorage.getItem(key));
        return val != null ? val : fallback;
    } catch { return fallback; }
}
function safeSetStorage(key, value, errorMessage = "") {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        log(`Storage write failed for ${key}: ${e.message}`);
        if (errorMessage) toastr?.error?.(errorMessage);
        return false;
    }
}
// Backup mapping: localStorage key → extensionSettings backup key
const BACKUP_KEYS = {
    qig_char_settings: "_backupCharSettings",
    qig_profiles: "_backupProfiles",
    qig_char_ref_images: "_backupCharRefImages",
    qig_gen_presets: "_backupGenPresets",
    qig_comfy_workflows: "_backupComfyWorkflows",
    qig_contextual_filters: "_backupContextualFilters",
    qig_filter_pools: "_backupFilterPools",
    qig_active_pool_ids_global: "_backupActiveFilterPoolIdsGlobal",
    qig_active_pool_ids_by_card: "_backupActiveFilterPoolIdsByCard",
    qig_active_pool_ids_by_char: "_backupActiveFilterPoolIdsByChar",
};
function writeBackupToSettings(localKey, data) {
    const backupKey = BACKUP_KEYS[localKey];
    if (!backupKey) return false;
    try {
        const es = extension_settings?.[extensionName];
        if (!es) return false;
        es[backupKey] = data;
        return true;
    } catch (e) {
        log(`Backup write failed for ${backupKey}: ${e.message}`);
        return false;
    }
}

function backupToSettings(localKey, data) {
    if (writeBackupToSettings(localKey, data)) {
        saveSettingsDebounced?.();
    }
}

async function flushSettingsBackup() {
    if (typeof saveSettings === "function") {
        await saveSettings();
        return;
    }

    saveSettingsDebounced?.();
}

async function saveBackupToSettings(localKey, data) {
    if (!writeBackupToSettings(localKey, data)) {
        return false;
    }

    await flushSettingsBackup();
    return true;
}

function saveLocalStoreBackup(localKey, data, errorMessage) {
    if (!safeSetStorage(localKey, JSON.stringify(data), errorMessage)) return false;
    backupToSettings(localKey, data);
    return true;
}

async function saveLocalStoreBackupNow(localKey, data, errorMessage) {
    if (!safeSetStorage(localKey, JSON.stringify(data), errorMessage)) return false;
    return saveBackupToSettings(localKey, data);
}
function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function generateUUID() {
    if (typeof crypto !== "undefined") {
        if (typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        if (typeof crypto.getRandomValues === "function") {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = [...bytes].map(b => b.toString(16).padStart(2, "0"));
            return [
                hex.slice(0, 4).join(""),
                hex.slice(4, 6).join(""),
                hex.slice(6, 8).join(""),
                hex.slice(8, 10).join(""),
                hex.slice(10, 16).join("")
            ].join("-");
        }
    }
    return "qig_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

let sessionGallery = safeParse("qig_gallery", []);
let promptHistory = safeParse("qig_prompt_history", []);
let charSettings = safeParse("qig_char_settings", {});
let connectionProfiles = safeParse("qig_profiles", {});
let charRefImages = safeParse("qig_char_ref_images", {});
let generationPresets = safeParse("qig_gen_presets", []);
let comfyWorkflows = safeParse("qig_comfy_workflows", []);
let contextualFilters = safeParse("qig_contextual_filters", []);
let filterPools = safeParse("qig_filter_pools", []);
let activeFilterPoolIdsGlobal = safeParse("qig_active_pool_ids_global", []);
let activeFilterPoolIdsByCard = safeParse("qig_active_pool_ids_by_card", {});
let activeFilterPoolIdsByChar = safeParse("qig_active_pool_ids_by_char", {});
let selectedComfyWorkflowId = "";
let isGenerating = false;
const blobUrls = new Set();
let batchKeyHandler = null;
const _processedInjectIndices = new Set();
let _injectProcessingCount = 0;
let currentAbortController = null;
let _autoGenTimeout = null;
const _autoInjectTimeouts = new Set();
let _autoGenerateEligibleCount = 0;
let _autoGenerateLastEligibleMessageIndex = null;
let cancelRequested = false;
let cancelRequestSerial = 0;
let _internalLlmRequestCount = 0;
let _suppressAutoGenerateUntil = 0;
let _lastAutoGenerateSuppressionLogTs = 0;
let paletteGenerateLockUntil = 0;
let paletteCancelLockUntil = 0;
let _palettePresetMenuCleanup = null;
let _paletteInjectActive = false;
let _paletteInjectSerial = 0;
let transientGenerationTarget = null;
let transientGenerationSettingsOverride = null;
let qigMessageActionObserver = null;
let qigMessageActionRefreshQueued = false;
let qigMessageActionClicksBound = false;
let qigSlashCommandsRegistered = false;
const PALETTE_GENERATE_LOCK_MS = 350;
const PALETTE_CANCEL_LOCK_MS = 500;
const INTERNAL_LLM_AUTOGEN_GRACE_MS = 2000;
const INJECT_CONSUMED_EXTRA_KEY = "qig_inject_consumed";
const QIG_MESSAGE_ACTION_CLASS = "qig-message-generate";
const FILTER_SCOPE_GLOBAL = "global";
const FILTER_SCOPE_CARD = "card";
const FILTER_SCOPE_CHAR = "char";
const DEFAULT_FILTER_POOL_ID = "qig_pool_default_global";
const DEFAULT_FILTER_POOL_NAME = "Default";
const FILTER_MANAGER_SCOPE_CURRENT_CARD = "__qig_scope_current_card__";
const FILTER_MANAGER_SCOPE_CURRENT_CHAR = "__qig_scope_current_char__";
const FILTER_MANAGER_SCOPE_GLOBAL_ONLY = "__qig_scope_global_only__";
let filterManagerUiState = {
    selectedScopeCharId: FILTER_MANAGER_SCOPE_CURRENT_CARD,
    hideInactive: false,
    draggedFilterId: null,
    dropTargetFilterId: null,
    dropPosition: "after",
};

function getCancelCheckpoint() {
    return cancelRequestSerial;
}

function wasCancelRequestedSince(checkpoint) {
    return typeof checkpoint === "number" && checkpoint !== cancelRequestSerial;
}

function checkAborted(checkpoint) {
    if (cancelRequested || currentAbortController?.signal?.aborted || wasCancelRequestedSince(checkpoint)) {
        throw new DOMException("Generation cancelled by user", "AbortError");
    }
}

function generateRandomSeed() {
    return Math.floor(Math.random() * 2147483647);
}

function resolveRandomSeed(seedValue = -1, target = null) {
    const numericSeed = Number(seedValue);
    if (Number.isFinite(numericSeed) && numericSeed >= 0) return numericSeed;
    const resolvedSeed = generateRandomSeed();
    if (target && typeof target === "object") target.__qigResolvedSeed = resolvedSeed;
    return resolvedSeed;
}

function normalizeSeedOverride(seedValue) {
    if (seedValue == null || seedValue === "") return null;
    const numericSeed = Number(seedValue);
    if (!Number.isFinite(numericSeed) || numericSeed <= 0) return null;
    return Math.floor(numericSeed);
}

function getGenerationSeedKey(settings = getSettings()) {
    return settings?.provider === "proxy" ? "proxySeed" : "seed";
}

function getGenerationSeedValue(settings = getSettings()) {
    const source = settings || getSettings();
    const value = Number(source?.[getGenerationSeedKey(source)]);
    return Number.isFinite(value) ? value : -1;
}

function setGenerationSeedValue(settings, value) {
    if (!settings || typeof settings !== "object") return value;
    settings[getGenerationSeedKey(settings)] = value;
    return value;
}

function getAbortError(signal, message = "Generation cancelled by user") {
    const reason = signal?.reason;
    if (reason instanceof DOMException && reason.name === "AbortError") return reason;
    return new DOMException(message, "AbortError");
}

async function runAbortableTask(taskFactory, signal) {
    if (!signal) return await taskFactory();
    if (signal.aborted) throw getAbortError(signal);

    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            handler(value);
        };
        const onAbort = () => finish(reject, getAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });

        Promise.resolve()
            .then(taskFactory)
            .then((value) => finish(resolve, value))
            .catch((error) => finish(reject, error));
    });
}

function beginInternalLLMRequest(label = "internal LLM request") {
    _internalLlmRequestCount += 1;
    _suppressAutoGenerateUntil = Math.max(_suppressAutoGenerateUntil, Date.now() + INTERNAL_LLM_AUTOGEN_GRACE_MS);
    log(`Auto-generate guard: begin ${label} (depth ${_internalLlmRequestCount})`);
}

function endInternalLLMRequest(label = "internal LLM request") {
    _internalLlmRequestCount = Math.max(0, _internalLlmRequestCount - 1);
    _suppressAutoGenerateUntil = Math.max(_suppressAutoGenerateUntil, Date.now() + INTERNAL_LLM_AUTOGEN_GRACE_MS);
    log(`Auto-generate guard: end ${label} (depth ${_internalLlmRequestCount})`);
}

async function runWithInternalLLMRequest(label, taskFactory) {
    beginInternalLLMRequest(label);
    try {
        return await taskFactory();
    } finally {
        endInternalLLMRequest(label);
    }
}

function logAutoGenerateSuppression(messageIndex, reason) {
    const now = Date.now();
    if (now - _lastAutoGenerateSuppressionLogTs < 750) return;
    _lastAutoGenerateSuppressionLogTs = now;
    const idxLabel = Number.isInteger(messageIndex) ? ` for message ${messageIndex}` : "";
    log(`Auto-generate: Ignoring MESSAGE_RECEIVED${idxLabel} (${reason})`);
}

function shouldSuppressAutoGenerateFromInternalLLM(messageIndex) {
    if (_internalLlmRequestCount > 0) {
        logAutoGenerateSuppression(messageIndex, `QIG internal LLM request active, depth ${_internalLlmRequestCount}`);
        return true;
    }
    const remainingMs = _suppressAutoGenerateUntil - Date.now();
    if (remainingMs > 0) {
        logAutoGenerateSuppression(messageIndex, `within ${remainingMs}ms of QIG internal LLM request`);
        return true;
    }
    return false;
}

function clearPendingAutoGenerateTimer() {
    if (_autoGenTimeout) {
        clearTimeout(_autoGenTimeout);
        _autoGenTimeout = null;
    }
    if (_autoInjectTimeouts.size) {
        for (const timeoutId of _autoInjectTimeouts) clearTimeout(timeoutId);
        _autoInjectTimeouts.clear();
    }
}

function resetAutoGenerateCadence({ clearTimer = false } = {}) {
    _autoGenerateEligibleCount = 0;
    _autoGenerateLastEligibleMessageIndex = null;
    if (clearTimer) clearPendingAutoGenerateTimer();
}

function shouldRunAutoGenerateForEligibleMessage(messageIndex, settings = getSettings()) {
    const normalizedIndex = Number.isInteger(messageIndex) ? messageIndex : null;
    if (normalizedIndex !== null && _autoGenerateLastEligibleMessageIndex === normalizedIndex) {
        logAutoGenerateSuppression(messageIndex, "duplicate eligible message event");
        return false;
    }

    const every = normalizeAutoGenerateEveryMessages(settings?.autoGenerateEveryMessages);
    _autoGenerateLastEligibleMessageIndex = normalizedIndex;
    _autoGenerateEligibleCount += 1;

    if (_autoGenerateEligibleCount < every) {
        log(`Auto-generate: ${_autoGenerateEligibleCount}/${every} eligible AI replies`);
        return false;
    }

    _autoGenerateEligibleCount = 0;
    return true;
}

function buildPrefillFallbackInstruction(prefill) {
    const resolvedPrefill = String(prefill || "");
    if (!resolvedPrefill.trim()) return "";
    return `\n\nIMPORTANT: Continue the output directly from this exact prefix. Treat it as already-written response text, do not quote it, and do not restart from the scene.\nPrefix:\n${resolvedPrefill}`;
}

async function runInternalQuietPromptRequest(instruction, {
    signal = null,
    quietName,
    requestLabel = "internal quiet prompt",
    prefill = "",
} = {}) {
    const quietPrompt = `${instruction}${buildPrefillFallbackInstruction(prefill)}`;
    const quietOptions = {
        quietPrompt,
        skipWIAN: true,
        quietName: quietName || `ImageGen_${Date.now()}`,
        quietToLoud: false,
    };

    try {
        return await runAbortableTask(() => generateQuietPrompt(quietOptions), signal);
    } catch (e) {
        if (e.name === "AbortError") throw e;
        log(`${requestLabel}: generateQuietPrompt with options failed: ${e.message}, using simple call`);
        return await runAbortableTask(() => generateQuietPrompt({ quietPrompt, quietToLoud: false }), signal);
    }
}

async function callInternalQuietPrompt(instruction, { signal = null, quietName, label = "internal quiet prompt", prefill = "" } = {}) {
    const requestLabel = String(label || quietName || "internal quiet prompt");
    return await runWithInternalLLMRequest(requestLabel, async () =>
        await runInternalQuietPromptRequest(instruction, { signal, quietName, requestLabel, prefill })
    );
}

function canUseDirectMainChatRawRequest() {
    const ctx = typeof getContext === "function" ? getContext() : null;
    return Boolean(
        ctx?.mainApi === "openai"
        && typeof createRawPrompt === "function"
        && typeof createGenerationParameters === "function"
        && typeof getChatCompletionModel === "function"
        && typeof getRequestHeaders === "function"
    );
}

async function callDirectMainChatRawRequest(instruction, {
    signal = null,
    prefill = "",
} = {}) {
    if (!canUseDirectMainChatRawRequest()) {
        throw new Error("direct main chat raw request is unavailable");
    }

    const ctx = getContext();
    const settings = {
        ...ctx.chatCompletionSettings,
        show_thoughts: false,
        enable_web_search: false,
        request_images: false,
        n: 1,
    };
    const model = getChatCompletionModel(settings);
    if (!model) {
        throw new Error("no active chat completion model is configured");
    }

    const prompt = createRawPrompt(instruction, "openai", false, false, "", String(prefill || ""));
    if (!Array.isArray(prompt)) {
        throw new Error("direct main chat prompt did not resolve to chat messages");
    }

    const { generate_data } = await createGenerationParameters(settings, model, "quiet", prompt);
    delete generate_data.tools;
    delete generate_data.tool_choice;

    const response = await runAbortableTask(async () => {
        const result = await fetch("/api/backends/chat-completions/generate", {
            method: "POST",
            headers: getRequestHeaders(),
            cache: "no-cache",
            body: JSON.stringify(generate_data),
            signal,
        });

        if (!result.ok) {
            const message = await result.text().catch(() => "");
            throw new Error(message || `chat-completions request failed with status ${result.status}`);
        }

        const data = await result.json();
        if (data?.error) {
            throw new Error(data.error.message || "chat-completions request returned an error");
        }
        return data;
    }, signal);

    return {
        ...extractLLMResponseDetails(response),
        route: "main_chat_ai",
        requestMethod: "directChatCompletions",
    };
}

async function callInternalStandaloneLLM(instruction, {
    signal = null,
    quietName,
    label = "internal standalone prompt",
    prefill = "",
    returnMeta = false,
} = {}) {
    const requestLabel = String(label || quietName || "internal standalone prompt");
    const resolvedPrefill = String(prefill || "");
    let attemptedDirectRawRequest = false;

    const maybeCallDirectMainChatRawRequest = async () => {
        if (attemptedDirectRawRequest || !canUseDirectMainChatRawRequest()) return null;
        attemptedDirectRawRequest = true;
        try {
            const meta = await callDirectMainChatRawRequest(instruction, {
                signal,
                prefill: resolvedPrefill,
            });
            if (meta?.text) {
                return meta;
            }
            logLLMHelperResponseMeta(meta, `${requestLabel}: direct backend response`);
            log(`${requestLabel}: direct backend returned no text, using quiet prompt fallback`);
        } catch (e) {
            if (e.name === "AbortError") throw e;
            log(`${requestLabel}: direct backend request failed: ${e.message}, using quiet prompt fallback`);
        }
        return null;
    };

    return await runWithInternalLLMRequest(requestLabel, async () => {
        if (returnMeta && typeof generateRawData === "function") {
            try {
                const response = await runAbortableTask(() => generateRawData({
                    prompt: instruction,
                    quietToLoud: false,
                    prefill: resolvedPrefill,
                }), signal);
                const details = extractLLMResponseDetails(response);
                const meta = {
                    ...details,
                    route: "main_chat_ai",
                    requestMethod: "generateRawData",
                };
                if (details.text) {
                    return returnMeta ? meta : details.text;
                }
                logLLMHelperResponseMeta(meta, `${requestLabel}: generateRawData response`);
                const directMeta = await maybeCallDirectMainChatRawRequest();
                if (directMeta?.text) {
                    return returnMeta ? directMeta : directMeta.text;
                }
                log(`${requestLabel}: generateRawData returned no text, using quiet prompt fallback`);
            } catch (e) {
                if (e.name === "AbortError") throw e;
                const directMeta = await maybeCallDirectMainChatRawRequest();
                if (directMeta?.text) {
                    return returnMeta ? directMeta : directMeta.text;
                }
                log(`${requestLabel}: generateRawData failed: ${e.message}, using quiet prompt fallback`);
            }
        } else if (typeof generateRaw === "function") {
            try {
                const text = await runAbortableTask(() => generateRaw({
                    prompt: instruction,
                    quietToLoud: false,
                    trimNames: false,
                    prefill: resolvedPrefill,
                }), signal);
                const meta = {
                    text,
                    route: "main_chat_ai",
                    sourcePath: "response",
                    extractionStatus: text ? "text" : "empty_string",
                    finishReason: null,
                    responseShape: summarizeLLMValueShape(text),
                    contentShape: summarizeLLMValueShape(text),
                    requestMethod: "generateRaw",
                };
                return returnMeta ? meta : text;
            } catch (e) {
                if (e.name === "AbortError") throw e;
                const directMeta = await maybeCallDirectMainChatRawRequest();
                if (directMeta?.text) {
                    return returnMeta ? directMeta : directMeta.text;
                }
                log(`${requestLabel}: generateRaw failed: ${e.message}, using quiet prompt fallback`);
            }
        }

        const directMeta = await maybeCallDirectMainChatRawRequest();
        if (directMeta?.text) {
            return returnMeta ? directMeta : directMeta.text;
        }

        const fallbackText = await runInternalQuietPromptRequest(instruction, {
            signal,
            quietName,
            requestLabel: `${requestLabel} fallback`,
            prefill: resolvedPrefill,
        });
        const fallbackMeta = {
            text: fallbackText,
            route: "main_chat_ai",
            sourcePath: "response",
            extractionStatus: fallbackText ? "text" : "empty_string",
            finishReason: null,
            responseShape: summarizeLLMValueShape(fallbackText),
            contentShape: summarizeLLMValueShape(fallbackText),
            requestMethod: "generateQuietPrompt",
        };
        return returnMeta ? fallbackMeta : fallbackText;
    });
}

const HTML_MESSAGE_TAG_RE = /<\/?(?:div|span|button|i|p|br|ul|ol|li|a|img|svg|section|article|table|tr|td|th)\b/i;
const UI_HTML_MESSAGE_RE = /menu_button|drawer-opener|data-target=|fa-solid|inline-flex|extensions-settings-button|sys-settings-button|rightNavHolder/i;

function normalizeSceneMessageText(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    if (!HTML_MESSAGE_TAG_RE.test(raw)) return raw;
    if (UI_HTML_MESSAGE_RE.test(raw)) return "";
    try {
        const temp = document.createElement("div");
        temp.innerHTML = raw;
        return String(temp.innerText || temp.textContent || "")
            .replace(/\u00a0/g, " ")
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
}

function getCurrentMessageSwipeText(message) {
    if (!Array.isArray(message?.swipes)) return "";
    const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
    return typeof message.swipes[swipeId] === "string" ? message.swipes[swipeId] : "";
}

function getSceneMessageSources(message) {
    if (!message || typeof message !== "object") return [];

    const sources = [];
    const seenTexts = new Set();
    const pushSource = (key, label, value) => {
        const normalized = normalizeSceneMessageText(value);
        if (!normalized || seenTexts.has(normalized)) return;
        seenTexts.add(normalized);
        sources.push({ key, label, text: normalized });
    };

    pushSource("extra.display_text", "display text", message?.extra?.display_text);
    pushSource("mes", "message", message?.mes);
    pushSource("swipes.current", "current swipe", getCurrentMessageSwipeText(message));
    pushSource("extra.reasoning_display_text", "reasoning display", message?.extra?.reasoning_display_text);
    pushSource("extra.reasoning", "reasoning", message?.extra?.reasoning);

    return sources;
}

function resolveSceneMessageSource(message) {
    const sources = getSceneMessageSources(message);
    return sources.length ? sources[0] : null;
}

function getSceneMessageSpeakerName(message, ctx = getContext?.()) {
    const fallbackName = message?.is_user ? ctx?.name1 : ctx?.name2;
    const resolved = String(message?.name || fallbackName || "Unknown").trim();
    return resolved || "Unknown";
}

function buildSceneMessageContext(entries, ctx = getContext?.(), { logDebug = false } = {}) {
    const selectedIndices = entries
        .map(entry => entry?.index)
        .filter(index => Number.isInteger(index));

    if (logDebug) {
        log(`Scene context: selected message indices ${selectedIndices.length ? selectedIndices.join(", ") : "(none)"}`);
    }

    const resolvedEntries = [];
    for (const entry of entries) {
        const source = resolveSceneMessageSource(entry?.message);
        if (!source) {
            if (logDebug) {
                log(`Scene context: message #${entry?.index ?? "?"} resolved empty after normalization`);
            }
            continue;
        }

        if (logDebug) {
            log(`Scene context: message #${entry.index} using ${source.label} (${source.key}), ${source.text.length} chars`);
        }

        resolvedEntries.push({
            ...entry,
            speakerName: getSceneMessageSpeakerName(entry.message, ctx),
            source,
        });
    }

    if (!resolvedEntries.length) {
        if (logDebug) {
            log("Scene context: no usable message text after normalization");
        }
        return { text: "", isMultiMessage: false, resolvedEntries: [] };
    }

    if (resolvedEntries.length === 1) {
        const text = resolvedEntries[0].source.text;
        if (logDebug) {
            log(`Scene context: built single-message scene (${text.length} chars)`);
        }
        return { text, isMultiMessage: false, resolvedEntries };
    }

    const text = resolvedEntries
        .map(entry => `${entry.speakerName}: ${entry.source.text}`)
        .join("\n\n");
    if (logDebug) {
        log(`Scene context: built multi-message scene (${resolvedEntries.length} messages, ${text.length} chars)`);
    }
    if (text.length > 10000) {
        console.warn("[QIG] Multi-message context exceeds 10000 chars:", text.length);
    }
    return { text, isMultiMessage: true, resolvedEntries };
}

function isSceneTranscriptPrompt(text) {
    const blocks = String(text || "")
        .split(/\n{2,}/)
        .map(block => block.trim())
        .filter(Boolean);
    if (blocks.length < 2) return false;
    return blocks.every(block => /^[^:\n]{1,80}:\s+\S/.test(block));
}

function customInstructionHasMacro(template, macroName) {
    const source = String(template || "");
    const macro = String(macroName || "").trim();
    if (!macro) return false;
    const escaped = macro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "i").test(source);
}

const PROVIDER_KEYS = {
    pollinations: ["pollinationsKey", "pollinationsModel"],
    novelai: ["naiKey", "naiModel", "naiProxyUrl", "naiProxyKey"],
    gptimage: ["gptImageKey", "gptImageModel", "gptImageProxyUrl", "gptImageProxyKey", "gptImageQuality", "gptImageFormat", "gptImageBackground", "gptImageModeration"],
    arliai: ["arliKey", "arliModel"],
    routeway: ["routewayKey", "routewayModel"],
    navy: ["navyKey", "navyModel"],
    nanogpt: ["nanogptKey", "nanogptModel", "nanogptRefImages", "nanogptStrength"],
    chutes: ["chutesKey", "chutesModel"],
    civitai: ["civitaiKey", "civitaiModel", "civitaiScheduler", "civitaiLoras"],
    nanobanana: ["nanobananaKey", "nanobananaModel", "nanobananaExtraInstructions", "nanobananaRefImages"],
    stability: ["stabilityKey"],
    replicate: ["replicateKey", "replicateModel"],
    fal: ["falKey", "falModel"],
    together: ["togetherKey", "togetherModel"],
    zai: ["zaiKey", "zaiModel", "zaiQuality"],
    local: ["localUrl", "localType", "localModel", "localRefImage", "localDenoise", "a1111Model", "a1111ClipSkip", "a1111Scheduler", "a1111RestoreFaces", "a1111Tiling", "a1111Subseed", "a1111SubseedStrength", "a1111Adetailer", "a1111AdetailerModel", "a1111AdetailerPrompt", "a1111AdetailerNegative", "a1111AdetailerDenoise", "a1111AdetailerConfidence", "a1111AdetailerMaskBlur", "a1111AdetailerDilateErode", "a1111AdetailerInpaintOnlyMasked", "a1111AdetailerInpaintPadding", "a1111Adetailer2", "a1111Adetailer2Model", "a1111Adetailer2Prompt", "a1111Adetailer2Negative", "a1111Adetailer2Denoise", "a1111Adetailer2Confidence", "a1111Adetailer2MaskBlur", "a1111Adetailer2DilateErode", "a1111Adetailer2InpaintOnlyMasked", "a1111Adetailer2InpaintPadding", "a1111Loras", "a1111Vae", "a1111HiresFix", "a1111HiresUpscaler", "a1111HiresScale", "a1111HiresSteps", "a1111HiresDenoise", "a1111HiresSampler", "a1111HiresScheduler", "a1111HiresPrompt", "a1111HiresNegative", "a1111HiresResizeX", "a1111HiresResizeY", "a1111SaveToWebUI", "a1111IpAdapter", "a1111IpAdapterMode", "a1111IpAdapterWeight", "a1111IpAdapterPixelPerfect", "a1111IpAdapterResizeMode", "a1111IpAdapterControlMode", "a1111IpAdapterStartStep", "a1111IpAdapterEndStep", "a1111ControlNet", "a1111ControlNetModel", "a1111ControlNetModule", "a1111ControlNetWeight", "a1111ControlNetResizeMode", "a1111ControlNetControlMode", "a1111ControlNetPixelPerfect", "a1111ControlNetGuidanceStart", "a1111ControlNetGuidanceEnd", "a1111ControlNetImage", "comfyWorkflow", "comfyClipSkip", "comfyDenoise", "comfyScheduler", "comfyTimeout", "comfyUpscale", "comfyUpscaleModel", "comfyLoras", "comfySkipNegativePrompt", "comfyFluxClipModel1", "comfyFluxClipModel2", "comfyFluxVaeModel", "comfyFluxClipType"],
    proxy: ["proxyUrl", "proxyKey", "proxyModel", "proxyLoras", "proxyFacefix", "proxySteps", "proxyCfg", "proxySampler", "proxySeed", "proxyExtraInstructions", "proxyRefImages", "proxyEndpointMode", "proxyPayloadMode", "proxyRefImageMode", "proxySse", "proxyTimeout", "proxyComfyMode", "proxyComfyTimeout", "proxyComfyNodeId", "proxyComfyWorkflow", "proxyChatImageMode", "proxyChatImageAllowImagesEndpoint", "proxyChatImageSystemPrompt", "proxyChatImageIncludePersonality", "proxyChatImageMaxTokens"]
};

const PROVIDERS = {
    pollinations: { name: "Pollinations (Free + Paid)", needsKey: false },
    novelai: { name: "NovelAI", needsKey: true },
    gptimage: { name: "GPT Image (OpenAI)", needsKey: true },
    arliai: { name: "ArliAI", needsKey: true },
    routeway: { name: "Routeway", needsKey: true },
    navy: { name: "Navy.ai", needsKey: true },
    nanogpt: { name: "NanoGPT", needsKey: true },
    chutes: { name: "Chutes", needsKey: true },
    civitai: { name: "CivitAI", needsKey: true },
    nanobanana: { name: "Nanobanana (Gemini)", needsKey: true },
    stability: { name: "Stability AI", needsKey: true },
    replicate: { name: "Replicate", needsKey: true },
    fal: { name: "Fal.ai", needsKey: true },
    together: { name: "Together AI", needsKey: true },
    zai: { name: "Z.AI", needsKey: true },
    local: { name: "Local (A1111/ComfyUI)", needsKey: false },
    proxy: { name: "Reverse Proxy (OpenAI-compatible)", needsKey: false }
};

const NAI_RESOLUTIONS = [
    { label: "Small Portrait (512×768)", w: 512, h: 768 },
    { label: "Small Landscape (768×512)", w: 768, h: 512 },
    { label: "Small Square (640×640)", w: 640, h: 640 },
    { label: "Normal Portrait (832×1216)", w: 832, h: 1216 },
    { label: "Normal Landscape (1216×832)", w: 1216, h: 832 },
    { label: "Normal Square (1024×1024)", w: 1024, h: 1024 },
    { label: "Large Portrait (1024×1536)", w: 1024, h: 1536 },
    { label: "Large Landscape (1536×1024)", w: 1536, h: 1024 },
    { label: "Large Square (1472×1472)", w: 1472, h: 1472 },
    { label: "Wallpaper Portrait (1088×1920)", w: 1088, h: 1920 },
    { label: "Wallpaper Landscape (1920×1088)", w: 1920, h: 1088 }
];

const SIZE_MIN = 256;
const SIZE_MAX = 2048;
const SIZE_STEP = 64;
const SIZE_DEFAULT = 512;
const NAI_CUSTOM_RESOLUTION_VALUE = "custom";

function normalizeDimension(value, fallback = SIZE_DEFAULT) {
    const numeric = Number.parseInt(value, 10);
    const base = Number.isFinite(numeric) ? numeric : fallback;
    const clamped = Math.max(SIZE_MIN, Math.min(SIZE_MAX, base));
    return Math.round(clamped / SIZE_STEP) * SIZE_STEP;
}

function normalizeSize(settings) {
    if (!settings || typeof settings !== "object") return false;
    const width = normalizeDimension(settings.width, SIZE_DEFAULT);
    const height = normalizeDimension(settings.height, SIZE_DEFAULT);
    const changed = settings.width !== width || settings.height !== height;
    settings.width = width;
    settings.height = height;
    return changed;
}

function syncSizeInputs(width, height) {
    const wEl = document.getElementById("qig-width");
    const hEl = document.getElementById("qig-height");
    if (wEl) wEl.value = width;
    if (hEl) hEl.value = height;
}

function getNaiResolutionOptionValue(width, height) {
    const w = Number.parseInt(width, 10);
    const h = Number.parseInt(height, 10);
    const preset = NAI_RESOLUTIONS.find(r => r.w === w && r.h === h);
    return preset ? `${preset.w}x${preset.h}` : NAI_CUSTOM_RESOLUTION_VALUE;
}

function syncNaiResolutionSelect() {
    const select = document.getElementById("qig-nai-resolution");
    if (!select) return;
    const s = getSettings();
    if (!s) return;
    const customOption = Array.from(select.options).find(opt => opt.value === NAI_CUSTOM_RESOLUTION_VALUE);
    if (customOption) customOption.textContent = `Custom (${s.width}×${s.height})`;
    const nextValue = getNaiResolutionOptionValue(s.width, s.height);
    const exists = Array.from(select.options).some(opt => opt.value === nextValue);
    select.value = exists ? nextValue : NAI_CUSTOM_RESOLUTION_VALUE;
}

function getNovelAIProxyGenerateUrl(proxyUrl) {
    const trimmed = String(proxyUrl || "").trim().replace(/\/$/, "");
    if (!trimmed) return "";
    if (/\/generate$/i.test(trimmed)) return trimmed;
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/generate");
    if (/\/v1$/i.test(trimmed)) return trimmed.replace(/\/v1$/i, "/generate");
    return `${trimmed}/generate`;
}

function resolveNovelAIProxyImageUrl(rawUrl, proxyUrl) {
    const url = String(rawUrl || "");
    if (url.startsWith("data:")) return url;
    if (/^https?:\/\//i.test(url)) return url;

    const baseUrl = String(proxyUrl || "")
        .replace(/\/generate\/?$/i, "")
        .replace(/\/chat\/completions\/?$/i, "")
        .replace(/\/$/, "");
    try {
        return new URL(url, baseUrl + "/").toString();
    } catch {
        return baseUrl + (url.startsWith("/") ? url : "/" + url);
    }
}

function extractNovelAIProxyImageUrl(json, proxyUrl) {
    const urlCandidates = [
        json?.url,
        json?.image_url,
        json?.imageUrl,
        json?.data?.url,
        json?.data?.[0]?.url,
        json?.output?.[0]?.url,
        json?.output?.[0],
        json?.image,
    ];
    for (const candidate of urlCandidates) {
        if (typeof candidate !== "string" || !candidate) continue;
        if (/^[A-Za-z0-9+/]{100,}[=]{0,2}$/.test(candidate)) {
            return `data:image/png;base64,${candidate}`;
        }
        if (candidate.startsWith("data:")) return candidate;
        if (/^https?:\/\//i.test(candidate) || candidate.startsWith("/")) {
            return resolveNovelAIProxyImageUrl(candidate, proxyUrl);
        }
    }

    const base64Candidates = [
        json?.b64_json,
        json?.base64,
        json?.image_base64,
        json?.imageBase64,
        json?.data?.base64,
        json?.data?.[0]?.base64,
        json?.data?.[0]?.b64_json,
        json?.output?.[0]?.b64_json,
    ];
    for (const candidate of base64Candidates) {
        if (typeof candidate === "string" && candidate) {
            return candidate.startsWith("data:") ? candidate : `data:image/png;base64,${candidate}`;
        }
    }

    throw new Error(`NovelAI proxy error: ${JSON.stringify(json)}`);
}

function isHttpUrl(value) {
    return /^https?:\/\/\S+$/i.test(String(value || "").trim());
}

function isDataImageUrl(value) {
    return /^data:image\/[^;]+;base64,/i.test(String(value || "").trim());
}

function safeDecodeUrlComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function splitTrailingUrlPunctuation(value) {
    const raw = String(value || "");
    const match = raw.match(/[)\],.;!?]+$/);
    if (!match) {
        return { url: raw, trailing: "" };
    }
    return {
        url: raw.slice(0, -match[0].length),
        trailing: match[0],
    };
}

function isLikelyDirectImageHttpUrl(value) {
    const url = String(value || "").trim();
    if (!isHttpUrl(url)) return false;
    try {
        const parsed = new URL(url);
        const pathname = safeDecodeUrlComponent(parsed.pathname || "");
        if (/\.(?:png|jpe?g|webp|gif|bmp|svg|avif|tiff?)$/i.test(pathname)) {
            return true;
        }

        const query = parsed.search || "";
        const formatMatch = query.match(/(?:^|[?&])(?:format|fm|ext)=([^&]+)/i);
        if (formatMatch && /\b(?:png|jpe?g|webp|gif|bmp|svg|avif|tiff?)\b/i.test(safeDecodeUrlComponent(formatMatch[1]))) {
            return true;
        }

        const mimeMatch = query.match(/(?:^|[?&])(?:mime|content[-_]?type)=([^&]+)/i);
        if (mimeMatch && /^image\//i.test(safeDecodeUrlComponent(mimeMatch[1]))) {
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

function normalizeExtractedProxyPromptText(value) {
    return String(value || "")
        .split("\n")
        .map(line => line
            .replace(/\s+([)\]}])/g, "$1")
            .replace(/([([{])\s+/g, "$1")
            .replace(/[ \t]{2,}/g, " ")
            .trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function extractPromptImageUrls(promptText, existingUrls = []) {
    const source = typeof promptText === "string" ? promptText : "";
    const seenUrls = new Set(
        (existingUrls || [])
            .map(url => String(url || "").trim())
            .filter(Boolean)
    );
    const imageUrls = [];
    const cleanedText = normalizeExtractedProxyPromptText(source.replace(/https?:\/\/[^\s<>"'`]+/gi, match => {
        const { url, trailing } = splitTrailingUrlPunctuation(match);
        if (!isLikelyDirectImageHttpUrl(url)) return match;
        if (!seenUrls.has(url)) {
            seenUrls.add(url);
            imageUrls.push(url);
        }
        const preservedTrailing = trailing.replace(/[.,;!?]+/g, "");
        return preservedTrailing || " ";
    }));

    return { imageUrls, cleanedText };
}

function getProxyPromptFallback(hasRefImages) {
    return hasRefImages
        ? "Create a new image that matches the provided reference image(s)."
        : "Create a new image.";
}

function normalizeProxyPromptInputs(prompt, refImages = []) {
    const extracted = extractPromptImageUrls(prompt, refImages);
    const mergedRefImages = [...refImages, ...extracted.imageUrls];
    if (extracted.imageUrls.length > 0) {
        log(`Auto-detected ${extracted.imageUrls.length} direct image URL(s) in prompt text`);
        extracted.imageUrls.forEach(img => log(`  prompt image URL: ${img.substring(0, Math.min(img.length, 80))}${img.length > 80 ? "..." : ""}`));
    }
    return {
        promptText: extracted.cleanedText,
        promptImageUrls: extracted.imageUrls,
        refImages: mergedRefImages,
    };
}

function normalizeProxyRuntimeRefImages(refImages) {
    const normalized = [];
    for (const raw of refImages || []) {
        if (typeof raw !== "string") continue;
        const value = raw.trim();
        if (!value) continue;
        normalized.push(value);
    }
    return normalized;
}

function mergeProxyRefImages(...groups) {
    const merged = [];
    const seen = new Set();
    for (const group of groups) {
        for (const raw of group || []) {
            if (typeof raw !== "string") continue;
            const value = raw.trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            merged.push(value);
        }
    }
    return merged;
}

function isPrivateIpv4Hostname(hostname) {
    const parts = String(hostname || "").split(".");
    if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) return false;
    const nums = parts.map(part => parseInt(part, 10));
    if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return false;
    if (nums[0] === 10 || nums[0] === 127) return true;
    if (nums[0] === 192 && nums[1] === 168) return true;
    return nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31;
}

function shouldInlineAutoProxyRefUrl(url) {
    const source = String(url || "").trim();
    if (!source || isDataImageUrl(source)) return false;
    if (source.startsWith("blob:")) return true;

    try {
        const parsed = new URL(source, window.location?.href || "http://localhost/");
        if (!/^https?:$/i.test(parsed.protocol)) return false;

        const hostname = String(parsed.hostname || "").toLowerCase();
        const currentOrigin = window.location?.origin || "";
        const currentHostname = String(window.location?.hostname || "").toLowerCase();

        if (currentOrigin && parsed.origin === currentOrigin) return true;
        if (currentHostname && hostname === currentHostname) return true;
        if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(hostname)) return true;
        return isPrivateIpv4Hostname(hostname);
    } catch {
        return false;
    }
}

async function normalizeAutoProxyRefUrl(url, { messageIndex = null, sourceLabel = "" } = {}) {
    const source = String(url || "").trim();
    if (!source) return "";
    if (isDataImageUrl(source)) return source;

    const absoluteUrl = toAbsoluteImageUrl(source);
    if (!absoluteUrl) return "";
    if (!shouldInlineAutoProxyRefUrl(absoluteUrl)) {
        return isHttpUrl(absoluteUrl) ? absoluteUrl : "";
    }

    try {
        const { buffer, contentType } = await fetchImageBuffer(absoluteUrl);
        const formatInfo = detectImageFormat(buffer, contentType, absoluteUrl);
        log(`Auto chat ref: Inlined ${sourceLabel || "message image"}${messageIndex != null ? ` from message #${messageIndex}` : ""}`);
        return `data:${formatInfo.mime};base64,${arrayBufferToBase64(buffer)}`;
    } catch (e) {
        log(`Auto chat ref: Failed to inline ${sourceLabel || "message image"}${messageIndex != null ? ` from message #${messageIndex}` : ""}: ${e.message}`);
        return "";
    }
}

function normalizeProxyEndpointSetting(value) {
    return ["auto", "chat_completions", "images_generations"].includes(value) ? value : "auto";
}

function normalizeProxyPayloadSetting(value) {
    return ["extended", "openai_strict"].includes(value) ? value : "extended";
}

function normalizeProxyRefImageSetting(value) {
    return ["auto", "url_only", "inline_or_url"].includes(value) ? value : "auto";
}

function normalizeProxySseSetting(value) {
    return ["auto", "on", "off"].includes(value) ? value : "auto";
}

function getProxyChatImageEndpointMode(settings = getSettings()) {
    if (!settings?.proxyChatImageMode) return null;
    return settings.proxyChatImageAllowImagesEndpoint ? "auto" : "chat_completions";
}

function normalizeProxyChatImageMaxTokens(value) {
    return Math.trunc(clampNumber(value, PROXY_CHAT_IMAGE_MAX_TOKENS_MIN, PROXY_CHAT_IMAGE_MAX_TOKENS_MAX, DEFAULT_PROXY_CHAT_IMAGE_MAX_TOKENS));
}

function normalizeProxyChatImageSettings(target, source = target) {
    if (!target || typeof target !== "object") return target;
    const sourceSettings = source && typeof source === "object" ? source : target;
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(sourceSettings, key);

    target.proxyChatImageMode = hasOwn("proxyChatImageMode")
        ? !!sourceSettings.proxyChatImageMode
        : PROXY_CHAT_IMAGE_DEFAULTS.proxyChatImageMode;
    target.proxyChatImageAllowImagesEndpoint = hasOwn("proxyChatImageAllowImagesEndpoint")
        ? !!sourceSettings.proxyChatImageAllowImagesEndpoint
        : PROXY_CHAT_IMAGE_DEFAULTS.proxyChatImageAllowImagesEndpoint;
    target.proxyChatImageIncludePersonality = hasOwn("proxyChatImageIncludePersonality")
        ? !!sourceSettings.proxyChatImageIncludePersonality
        : PROXY_CHAT_IMAGE_DEFAULTS.proxyChatImageIncludePersonality;
    target.proxyChatImageSystemPrompt = String(
        hasOwn("proxyChatImageSystemPrompt")
            ? sourceSettings.proxyChatImageSystemPrompt
            : PROXY_CHAT_IMAGE_DEFAULTS.proxyChatImageSystemPrompt,
    ).trim() || DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT;
    target.proxyChatImageMaxTokens = normalizeProxyChatImageMaxTokens(
        hasOwn("proxyChatImageMaxTokens")
            ? sourceSettings.proxyChatImageMaxTokens
            : PROXY_CHAT_IMAGE_DEFAULTS.proxyChatImageMaxTokens,
    );

    if (target.proxyChatImageMode && !target.proxyChatImageAllowImagesEndpoint) {
        target.proxyEndpointMode = "chat_completions";
    }
    return target;
}

function inferProxyEndpointMode(proxyUrl) {
    const trimmed = String(proxyUrl || "").trim().replace(/\/$/, "");
    if (/\/chat\/completions$/i.test(trimmed)) return "chat_completions";
    if (/\/images(?:\/generations)?$/i.test(trimmed)) return "images_generations";
    if (trimmed.includes("/v1") && !trimmed.includes("/images")) return "chat_completions";
    return "images_generations";
}

function resolveProxyEndpointMode(proxyUrl, settings) {
    const chatImageMode = getProxyChatImageEndpointMode(settings);
    if (chatImageMode === "chat_completions") return "chat_completions";
    const configured = normalizeProxyEndpointSetting(settings?.proxyEndpointMode);
    return configured === "auto" ? inferProxyEndpointMode(proxyUrl) : configured;
}

function resolveProxyRequestUrl(proxyUrl, endpointMode) {
    const trimmed = String(proxyUrl || "").trim().replace(/\/$/, "");
    if (!trimmed) return "";

    if (endpointMode === "chat_completions") {
        if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
        if (/\/images\/generations$/i.test(trimmed)) return trimmed.replace(/\/images\/generations$/i, "/chat/completions");
        if (/\/images$/i.test(trimmed)) return trimmed.replace(/\/images$/i, "/chat/completions");
        if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
        return `${trimmed}/chat/completions`;
    }

    if (/\/images\/generations$/i.test(trimmed)) return trimmed;
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/images/generations");
    if (/\/images$/i.test(trimmed)) return `${trimmed}/generations`;
    if (/\/v1$/i.test(trimmed)) return `${trimmed}/images/generations`;
    return trimmed;
}

function parseProxyLoras(raw) {
    return raw
        ? raw.split(",")
            .map(l => {
                const t = l.trim();
                const lc = t.lastIndexOf(":");
                const hasWeight = lc > 0 && !isNaN(parseFloat(t.slice(lc + 1)));
                const id = (hasWeight ? t.slice(0, lc) : t).trim();
                const weight = hasWeight ? parseFloat(t.slice(lc + 1)) : NaN;
                return { id, weight: isNaN(weight) ? 0.8 : weight };
            })
            .filter(l => l.id)
        : undefined;
}

function summarizeProxyRefImage(img) {
    if (isDataImageUrl(img)) {
        const base64 = String(img).replace(/^data:image\/[^;]+;base64,/i, "");
        return `${Math.round(base64.length * 0.75 / 1024)}KB inline`;
    }
    if (isHttpUrl(img)) return "remote URL";
    return "local/non-public URL";
}

function normalizeProxyRefImages(refImages, refMode) {
    const normalized = [];
    for (const raw of refImages || []) {
        if (typeof raw !== "string") continue;
        const value = raw.trim();
        if (!value) continue;
        if (refMode === "url_only" && !isHttpUrl(value)) {
            throw new Error("This proxy compatibility mode only accepts public image URLs for reference images. Remove uploaded/local refs and paste https:// image URLs instead.");
        }
        normalized.push(value);
    }
    return normalized;
}

function shouldUseProxySse(settings, payloadMode) {
    const configured = normalizeProxySseSetting(settings?.proxySse);
    if (configured === "on") return true;
    if (configured === "off") return false;
    return payloadMode !== "openai_strict";
}

async function readProxyErrorResponse(res) {
    const text = await res.text().catch(() => "");
    return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function extractProxyImageFromString(value) {
    const contentStr = typeof value === "string" ? value.trim() : "";
    if (!contentStr) return null;
    if (contentStr.startsWith("data:image/")) return contentStr;
    if (isHttpUrl(contentStr)) return contentStr;

    const embeddedUrlMatch = contentStr.match(/(https?:\/\/\S+)/i);
    if (embeddedUrlMatch) {
        return embeddedUrlMatch[1].replace(/[)\],.;]+$/, "");
    }

    const b64Match = contentStr.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (b64Match) return b64Match[0];

    const rawB64Match = contentStr.match(/^[A-Za-z0-9+/]{100,}[=]{0,2}$/);
    if (rawB64Match) return `data:image/png;base64,${rawB64Match[0]}`;

    return null;
}

function extractProxyImageValue(candidate) {
    if (!candidate) return null;
    if (typeof candidate === "string") return extractProxyImageFromString(candidate);
    if (candidate.image_url?.url) return candidate.image_url.url;
    if (candidate.url) return candidate.url;
    if (candidate.b64_json) return `data:image/png;base64,${candidate.b64_json}`;
    if (candidate.base64) return `data:image/png;base64,${candidate.base64}`;
    if (candidate.source?.data) return `data:${candidate.source.media_type || "image/png"};base64,${candidate.source.data}`;
    if (candidate.inline_data?.data) return `data:${candidate.inline_data.mime_type || "image/png"};base64,${candidate.inline_data.data}`;
    if (candidate.inlineData?.data) return `data:${candidate.inlineData.mimeType || "image/png"};base64,${candidate.inlineData.data}`;
    return null;
}

function extractProxyImageFromJson(data) {
    const directCandidates = [
        data?.data?.[0],
        data?.output?.[0],
        { url: data?.url },
        { url: data?.image_url },
        { url: data?.imageUrl },
        { b64_json: data?.b64_json || data?.image_base64 || data?.imageBase64 },
        { base64: data?.base64 },
        extractProxyImageFromString(data?.image),
    ];
    for (const candidate of directCandidates) {
        const result = extractProxyImageValue(candidate);
        if (result) return result;
    }

    const images = data?.choices?.[0]?.message?.images;
    if (Array.isArray(images)) {
        for (const img of images) {
            const result = extractProxyImageValue(img);
            if (result) return result;
        }
    }

    const msgContent = data?.choices?.[0]?.message?.content;
    if (Array.isArray(msgContent)) {
        for (const item of msgContent) {
            const result = extractProxyImageValue(item);
            if (result) return result;
        }
    } else {
        const result = extractProxyImageFromString(msgContent);
        if (result) return result;
    }

    const parts = data?.choices?.[0]?.message?.parts;
    if (Array.isArray(parts)) {
        for (const part of parts) {
            const result = extractProxyImageValue(part);
            if (result) return result;
        }
    }

    for (const candidate of data?.candidates || []) {
        for (const part of candidate?.content?.parts || []) {
            const result = extractProxyImageValue(part);
            if (result) return result;
        }
    }

    return null;
}

function extractProxyImageFromSseText(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]" || trimmed === "data: : keepalive") continue;
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        const direct = extractProxyImageFromString(payload);
        if (direct) return direct;

        try {
            const parsed = JSON.parse(payload);
            log(`SSE event: ${JSON.stringify(parsed).substring(0, 200)}`);
            const result = extractProxyImageFromJson(parsed);
            if (result) return result;
        } catch {
            // Ignore non-JSON SSE lines.
        }
    }
    return null;
}

function buildProxyChatPayload(prompt, negative, s, refImages, payloadMode, proxySeed) {
    const negPrompt = negative ? `\nAvoid: ${negative}` : "";
    const extraInstr = s.proxyExtraInstructions ? `\n${s.proxyExtraInstructions}` : "";
    const content = [];
    const normalizedPrompt = normalizeProxyPromptInputs(prompt, refImages);
    const allRefImages = normalizedPrompt.refImages;
    const hasRefImages = allRefImages.length > 0;
    const promptText = normalizedPrompt.promptText || getProxyPromptFallback(hasRefImages);

    if (hasRefImages) {
        log(`Attaching ${allRefImages.length} reference image(s) to chat request`);
        for (const img of allRefImages) {
            log(`  ref image: ${img.substring(0, Math.min(img.length, 80))}${img.length > 80 ? "..." : ""} (${summarizeProxyRefImage(img)})`);
            content.push({ type: "image_url", image_url: { url: img } });
        }
    } else {
        log("No reference images found in proxyRefImages or prompt text");
    }

    const textPrompt = hasRefImages
        ? `Look at the reference image(s) provided. Match their style, composition, and visual characteristics. ${promptText}`
        : `Generate an image: ${promptText}`;
    content.push({ type: "text", text: `${textPrompt}${negPrompt}${extraInstr}` });

    const messages = [];
    if (s.proxyChatImageMode) {
        const systemPrompt = buildProxyChatImageSystemPrompt(s, getContext?.());
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
    }
    messages.push({ role: "user", content });

    const payload = {
        model: s.proxyModel,
        messages,
        max_tokens: getProxyChatMaxTokens(s),
    };

    if (payloadMode !== "openai_strict") {
        payload.width = s.width;
        payload.height = s.height;
        payload.steps = s.proxySteps || 25;
        payload.cfg_scale = s.proxyCfg || 6;
        payload.sampler = s.proxySampler || "Euler a";
        payload.seed = proxySeed;
        payload.negative_prompt = negative;
        payload.loras = parseProxyLoras(s.proxyLoras);
        payload.facefix = s.proxyFacefix || undefined;
    }

    if (/gemini.*image|gemini.*preview/i.test(s.proxyModel)) {
        payload.response_modalities = ["TEXT", "IMAGE"];
        payload.generationConfig = { responseModalities: ["TEXT", "IMAGE"] };
        log("Gemini image model detected, adding responseModalities");
    }

    if (s.proxyChatImageMode) {
        log(`New-API Chat Image payload: messages=${messages.length}, refs=${allRefImages.length}, max_tokens=${payload.max_tokens}`);
    }

    return payload;
}

function buildProxyImagesPayload(prompt, negative, s, refImages, payloadMode, proxySeed, sseEnabled) {
    const normalizedPrompt = normalizeProxyPromptInputs(prompt, refImages);
    const allRefImages = normalizedPrompt.refImages;
    const promptText = normalizedPrompt.promptText || getProxyPromptFallback(allRefImages.length > 0);
    const strictPrompt = payloadMode === "openai_strict"
        ? [promptText, negative ? `Avoid: ${negative}` : "", s.proxyExtraInstructions || ""].filter(Boolean).join("\n")
        : promptText;
    const payload = {
        model: s.proxyModel,
        prompt: strictPrompt,
        n: 1,
        size: `${s.width}x${s.height}`,
    };

    if (payloadMode !== "openai_strict") {
        payload.negative_prompt = negative;
        payload.width = s.width;
        payload.height = s.height;
        payload.steps = s.proxySteps || 25;
        payload.cfg_scale = s.proxyCfg || 6;
        payload.sampler = s.proxySampler || "Euler a";
        payload.seed = proxySeed;
        payload.sse = sseEnabled;
        payload.loras = parseProxyLoras(s.proxyLoras);
        payload.facefix = s.proxyFacefix || undefined;
    }

    if (allRefImages.length > 0) {
        log(`Attaching ${allRefImages.length} reference image(s) to images/generations request`);
        allRefImages.forEach(img => log(`  ref image: ${img.substring(0, Math.min(img.length, 80))}${img.length > 80 ? "..." : ""} (${summarizeProxyRefImage(img)})`));
        // OpenAI-compatible image proxies are inconsistent here:
        // Airforce's own image playground posts `image_urls`, while some other
        // proxy stacks still look for the older `image` field.
        payload.image_urls = allRefImages;
        if (payloadMode !== "openai_strict") {
            payload.image = allRefImages;
        }
        log(`Proxy ref payload fields: ${payloadMode === "openai_strict" ? "image_urls" : "image_urls, image"}`);
    }

    return payload;
}

const STYLES = {
    none: { name: "None", prefix: "", suffix: "" },
    anime: { name: "Anime", prefix: "anime style, anime artwork, 2D illustration, anime key visual, ", suffix: ", sharp lineart, anime coloring, vibrant colors" },
    photorealistic: { name: "Photorealistic", prefix: "realistic, photorealistic, hyperrealistic, ", suffix: ", 8k uhd, dslr" },
    digitalart: { name: "Digital Art", prefix: "digital painting, concept art, ", suffix: ", artstation" },
    oilpainting: { name: "Oil Painting", prefix: "oil painting, classical, ", suffix: ", renaissance style" },
    watercolor: { name: "Watercolor", prefix: "watercolor painting, ", suffix: ", soft edges, flowing colors" },
    pencilsketch: { name: "Pencil Sketch", prefix: "pencil sketch, graphite, ", suffix: ", hand drawn" },
    inkdrawing: { name: "Ink Drawing", prefix: "ink drawing, lineart, ", suffix: ", pen and ink" },
    pixelart: { name: "Pixel Art", prefix: "pixel art, 16-bit, ", suffix: ", retro game style" },
    render3d: { name: "3D Render", prefix: "3d render, octane render, ", suffix: ", unreal engine 5" },
    cyberpunk: { name: "Cyberpunk", prefix: "cyberpunk, neon lights, ", suffix: ", futuristic, sci-fi" },
    fantasy: { name: "Fantasy", prefix: "fantasy art, magical, ", suffix: ", ethereal, mystical" },
    comicbook: { name: "Comic Book", prefix: "comic book style, bold lines, ", suffix: ", halftone" },
    manga: { name: "Manga", prefix: "manga style, japanese manga, black and white, ", suffix: ", screentone, ink" },
    chibi: { name: "Chibi", prefix: "chibi, cute anime, kawaii, ", suffix: ", super deformed, adorable" },
    ghibli: { name: "Ghibli", prefix: "studio ghibli style, anime, miyazaki, ", suffix: ", whimsical, hand painted" },
    ukiyoe: { name: "Ukiyo-e", prefix: "ukiyo-e, ", suffix: ", japanese woodblock print" },
    artnouveau: { name: "Art Nouveau", prefix: "art nouveau, ornate, ", suffix: ", decorative, mucha style" },
    artdeco: { name: "Art Deco", prefix: "art deco, geometric, ", suffix: ", 1920s style" },
    impressionist: { name: "Impressionist", prefix: "impressionist, monet style, ", suffix: ", soft brushstrokes" },
    surrealist: { name: "Surrealist", prefix: "surrealist, dreamlike, ", suffix: ", dali style" },
    popart: { name: "Pop Art", prefix: "pop art, warhol style, ", suffix: ", bold colors" },
    minimalist: { name: "Minimalist", prefix: "minimalist, simple, ", suffix: ", clean lines" },
    gothic: { name: "Gothic", prefix: "gothic, dark, macabre, ", suffix: ", victorian" },
    steampunk: { name: "Steampunk", prefix: "steampunk, victorian sci-fi, ", suffix: ", brass and gears" },
    vaporwave: { name: "Vaporwave", prefix: "vaporwave, 80s aesthetic, ", suffix: ", synthwave, retrowave" },
    lowpoly: { name: "Low Poly", prefix: "low poly, geometric, ", suffix: ", polygonal 3d" },
    isometric: { name: "Isometric", prefix: "isometric, isometric view, ", suffix: ", game asset" },
    stainedglass: { name: "Stained Glass", prefix: "stained glass, colorful glass, ", suffix: ", cathedral" },
    graffiti: { name: "Graffiti", prefix: "graffiti art, street art, ", suffix: ", urban" },
    charcoal: { name: "Charcoal", prefix: "charcoal drawing, smudged, ", suffix: ", dramatic shadows" },
    pastel: { name: "Pastel", prefix: "pastel colors, soft, ", suffix: ", dreamy, light" },
    filmnoir: { name: "Film Noir", prefix: "noir, black and white, ", suffix: ", high contrast, dramatic" },
    vintagephoto: { name: "Vintage Photo", prefix: "vintage photo, old photograph, ", suffix: ", sepia, aged" },
    polaroid: { name: "Polaroid", prefix: "polaroid, instant photo, ", suffix: ", nostalgic" },
    cinematic: { name: "Cinematic", prefix: "cinematic, movie still, ", suffix: ", dramatic lighting, anamorphic" },
    portrait: { name: "Portrait", prefix: "portrait photography, ", suffix: ", studio lighting, professional" },
    landscape: { name: "Landscape", prefix: "landscape photography, ", suffix: ", nature, scenic" },
    macro: { name: "Macro", prefix: "macro photography, close-up, ", suffix: ", detailed" },
    abstract: { name: "Abstract", prefix: "abstract, non-representational, ", suffix: ", shapes and colors" },
    psychedelic: { name: "Psychedelic", prefix: "psychedelic, trippy, ", suffix: ", vibrant, kaleidoscopic" },
    darkfantasy: { name: "Dark Fantasy", prefix: "dark fantasy, grimdark, ", suffix: ", elden ring style" },
    moeanime: { name: "Moe Anime", prefix: "anime style, cute anime, moe, kawaii, ", suffix: ", adorable, soft colors" },
    retroanime: { name: "90s Anime", prefix: "90s anime style, retro anime, cel animation, ", suffix: ", vintage anime, old school anime" }
};

const POLLINATIONS_MODEL_OPTIONS = [
    { id: "", name: "Default (legacy anonymous endpoint)" },
    { id: "flux", name: "Flux" },
    { id: "turbo", name: "Turbo" },
    { id: "xiaolong", name: "Xiaolong" },
    { id: "zimage", name: "Z-Image Turbo" },
    { id: "gptimage", name: "GPT Image 1 Mini" },
    { id: "gptimage-large", name: "GPT Image 1.5" },
    { id: "wan-image", name: "Wan 2.7 Image" },
    { id: "qwen-image", name: "Qwen Image Plus" },
    { id: "klein", name: "FLUX.2 Klein 4B" },
    { id: "kontext", name: "FLUX.1 Kontext" },
    { id: "nanobanana", name: "NanoBanana (Paid)", paid: true },
    { id: "nanobanana-2", name: "NanoBanana 2 (Paid)", paid: true },
    { id: "nanobanana-pro", name: "NanoBanana Pro (Paid)", paid: true },
    { id: "seedream5", name: "Seedream 5.0 Lite (Paid)", paid: true },
    { id: "wan-image-pro", name: "Wan 2.7 Image Pro (Paid)", paid: true },
    { id: "grok-imagine", name: "Grok Imagine (Paid)", paid: true },
    { id: "grok-imagine-pro", name: "Grok Imagine Pro (Paid)", paid: true },
    { id: "p-image", name: "Pruna p-image (Paid)", paid: true },
    { id: "p-image-edit", name: "Pruna p-image-edit (Paid)", paid: true },
    { id: "nova-canvas", name: "Nova Canvas (Paid)", paid: true },
];

const POLLINATIONS_PAID_MODEL_IDS = new Set(
    POLLINATIONS_MODEL_OPTIONS.filter(model => model.paid).map(model => model.id),
);

const PROVIDER_MODELS = {
    pollinations: [
        { id: "", name: "Default" },
        { id: "flux", name: "Flux" },
        { id: "turbo", name: "Turbo" },
        { id: "xiaolong", name: "Xiaolong" }
    ],
    gptimage: [
        { id: "gpt-image-2", name: "GPT Image 2" },
        { id: "gpt-image-1.5", name: "GPT Image 1.5" },
        { id: "gpt-image-1", name: "GPT Image 1" },
        { id: "gpt-image-1-mini", name: "GPT Image 1 Mini" }
    ],
    routeway: [
        { id: "flux-1-schnell", name: "Flux 1 Schnell" },
        { id: "qwen-image-2.0", name: "Qwen Image 2.0" },
        { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro" },
        { id: "seedream-v5.0-lite", name: "Seedream 5.0 Lite" },
        { id: "flux-2-dev", name: "Flux 2 Dev" },
        { id: "sdxl", name: "SDXL" }
    ],
    navy: [
        { id: "flux", name: "Flux" },
        { id: "flux.1-schnell", name: "Flux 1 Schnell" },
        { id: "flux.1-schnell-uncensored", name: "Flux 1 Schnell Uncensored" },
        { id: "flux.2-pro", name: "Flux 2 Pro" },
        { id: "flux.2-flex", name: "Flux 2 Flex" },
        { id: "flux.2-dev", name: "Flux 2 Dev" },
        { id: "flux.2-klein", name: "Flux 2 Klein" },
        { id: "gpt-image-2", name: "GPT Image 2" },
        { id: "gpt-image-1.5", name: "GPT Image 1.5" },
        { id: "nano-banana-pro", name: "Nano Banana Pro" },
        { id: "nano-banana-2", name: "Nano Banana 2" },
        { id: "imagen-4", name: "Imagen 4" }
    ],
    zai: [
        { id: "cogview-4-250304", name: "CogView 4" },
        { id: "glm-image", name: "GLM Image" }
    ]
};

const ROUTEWAY_MODEL_SIZES = {
    "flux-1-schnell": ["1792x1024", "1024x1792", "1024x768", "768x1024", "1080x1350"],
    "qwen-image-2.0": ["1024x1024", "1280x720", "720x1280", "1536x1024", "1024x1536"],
    "qwen-image-2.0-pro": ["1024x1024", "1280x720", "720x1280", "1536x1024", "1024x1536"],
    "seedream-v5.0-lite": ["2048x2048", "2560x1440", "1440x2560", "3072x2048", "2048x3072", "4096x2304", "2304x4096"],
    "flux-2-dev": ["1024x1024", "1280x720", "720x1280", "1536x1024", "1024x1536"],
    sdxl: ["512x512", "768x768", "1024x1024", "1408x1408", "576x1024", "1024x576", "768x1024", "1024x768"]
};

const NAVY_MODEL_SIZES = {
    "gpt-image-2": ["1024x1024", "1536x1024", "1024x1536"],
    "gpt-image-1.5": ["1024x1024", "1536x1024", "1024x1536"]
};

const SAMPLERS = [
    // Euler family
    "euler_a", "euler",
    // DPM++ family
    "dpm++_2m", "dpm++_sde", "dpm++_2m_sde", "dpm++_3m_sde", "dpm++_2s_ancestral",
    // DPM family
    "dpm_2", "dpm_2_ancestral", "dpm_fast", "dpm_adaptive",
    // Classic
    "ddim", "ddpm", "lms", "heun", "heunpp2", "plms",
    // Unified Predictor-Corrector
    "uni_pc", "uni_pc_bh2",
    // Specialty
    "lcm", "deis", "restart",
    // Anima
    "er_sde"
];

// Display names for samplers (used in HTML select and A1111 API)
const SAMPLER_DISPLAY_NAMES = {
    "euler_a": "Euler a", "euler": "Euler",
    "dpm++_2m": "DPM++ 2M", "dpm++_sde": "DPM++ SDE", "dpm++_2m_sde": "DPM++ 2M SDE",
    "dpm++_3m_sde": "DPM++ 3M SDE", "dpm++_2s_ancestral": "DPM++ 2S a",
    "dpm_2": "DPM2", "dpm_2_ancestral": "DPM2 a", "dpm_fast": "DPM fast", "dpm_adaptive": "DPM adaptive",
    "ddim": "DDIM", "ddpm": "DDPM", "lms": "LMS", "heun": "Heun", "heunpp2": "Heun++ 2", "plms": "PLMS",
    "uni_pc": "UniPC", "uni_pc_bh2": "UniPC BH2",
    "lcm": "LCM", "deis": "DEIS", "restart": "Restart",
    "er_sde": "ER SDE"
};

// Sampler grouping for <optgroup> display
const SAMPLER_GROUPS = {
    "Euler": ["euler_a", "euler"],
    "DPM++": ["dpm++_2m", "dpm++_sde", "dpm++_2m_sde", "dpm++_3m_sde", "dpm++_2s_ancestral"],
    "DPM": ["dpm_2", "dpm_2_ancestral", "dpm_fast", "dpm_adaptive"],
    "Classic": ["ddim", "ddpm", "lms", "heun", "heunpp2", "plms"],
    "UniPC": ["uni_pc", "uni_pc_bh2"],
    "Specialty": ["lcm", "deis", "restart"],
    "Anima": ["er_sde"]
};

const A1111_SCHEDULERS = ["Automatic", "Uniform", "Karras", "Exponential", "Polyexponential", "SGM Uniform", "Simple", "Normal", "DDIM", "Beta"];

const COMFY_SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta", "kl_optimal"];

const logs = [];
function log(msg) {
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (logs.length > 100) logs.shift();
    console.log("[QIG]", msg);
}

function parseFloatOr(value, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseIntOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeAutoGenerateEveryMessages(value) {
    return Math.trunc(clampNumber(value, AUTO_GENERATE_EVERY_MIN, AUTO_GENERATE_EVERY_MAX, AUTO_GENERATE_EVERY_DEFAULT));
}

function normalizeAutoGenerateDelayMs(value) {
    return Math.trunc(clampNumber(value, AUTO_GENERATE_DELAY_MIN, AUTO_GENERATE_DELAY_MAX, AUTO_GENERATE_DELAY_DEFAULT));
}

function normalizeAutoGenerateSettings(settings) {
    if (!settings || typeof settings !== "object") return settings;
    settings.autoGenerateEveryMessages = normalizeAutoGenerateEveryMessages(settings.autoGenerateEveryMessages);
    settings.autoGenerateDelayMs = normalizeAutoGenerateDelayMs(settings.autoGenerateDelayMs);
    return settings;
}

function normalizeBackgroundMode(value) {
    return value === "locked" ? "locked" : "temporary";
}

function isComfyFluxMode(s) {
    return !!s?.comfySkipNegativePrompt && !!(s?.comfyFluxClipModel1 || "").trim();
}

const QIG_RELAY_BASE = "/api/plugins/quick-image-gen-relay";
const CORS_PROXY_BASIC_AUTH_MESSAGE = "SillyTavern basicAuthMode is blocking the CORS proxy for requests that need their own Authorization header. Install the optional Quick Image Gen server plugin (see README), or disable basicAuthMode to use CivitAI/Replicate.";

class CorsProxyBasicAuthError extends Error {
    constructor(url) {
        super(CORS_PROXY_BASIC_AUTH_MESSAGE);
        this.name = "CorsProxyBasicAuthError";
        this.url = url;
    }
}

function isBasicAuthChallenge(header) {
    return /(^|\s|,)Basic\b/i.test(header || "");
}

function hasAuthorizationHeader(headers) {
    if (!headers) return false;
    if (headers instanceof Headers) return headers.has("Authorization");
    if (Array.isArray(headers)) return headers.some(([key]) => String(key).toLowerCase() === "authorization");
    return Object.keys(headers).some(key => key.toLowerCase() === "authorization");
}

function getSameOriginHeaders() {
    const headers = typeof getRequestHeaders === 'function' ? { ...getRequestHeaders() } : {};
    delete headers.Authorization;
    delete headers.authorization;
    return headers;
}

function getSameOriginJsonHeaders() {
    return { ...getSameOriginHeaders(), "Content-Type": "application/json" };
}

let _qigRelayState = 0; // 0=unknown, 1=available, -1=unavailable
async function qigRelayAvailable(signal) {
    if (_qigRelayState !== 0) return _qigRelayState === 1;
    try {
        const res = await fetch(`${QIG_RELAY_BASE}/healthz`, {
            method: "GET",
            headers: getSameOriginHeaders(),
            credentials: "same-origin",
            signal,
        });
        _qigRelayState = res.ok ? 1 : -1;
        return res.ok;
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        _qigRelayState = -1;
        return false;
    }
}

async function qigRelayFetch(provider, payload, signal) {
    return fetch(`${QIG_RELAY_BASE}/${provider}`, {
        method: "POST",
        headers: getSameOriginJsonHeaders(),
        body: JSON.stringify(payload),
        credentials: "same-origin",
        signal,
    });
}

async function civitaiFetch(action, payload, signal) {
    if (await qigRelayAvailable(signal)) {
        return qigRelayFetch("civitai", { action, ...payload }, signal);
    }
    if (action === "createJob") {
        return corsFetch("https://civitai.com/api/v1/consumer/jobs", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${payload.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload.body),
            signal,
        });
    }
    if (action === "getJobs") {
        const url = new URL("https://civitai.com/api/v1/consumer/jobs");
        url.searchParams.set("token", payload.token);
        return corsFetch(url.toString(), {
            headers: { "Authorization": `Bearer ${payload.apiKey}` },
            signal,
        });
    }
    throw new Error(`Unknown CivitAI relay action: ${action}`);
}

async function replicateFetch(action, payload, signal) {
    if (await qigRelayAvailable(signal)) {
        return qigRelayFetch("replicate", { action, ...payload }, signal);
    }
    if (action === "createPrediction") {
        return corsFetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Token ${payload.apiKey}`,
            },
            body: JSON.stringify(payload.body),
            signal,
        });
    }
    if (action === "getPrediction") {
        return corsFetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(payload.id)}`, {
            headers: { "Authorization": `Token ${payload.apiKey}` },
            signal,
        });
    }
    throw new Error(`Unknown Replicate relay action: ${action}`);
}

// CORS-aware fetch: tries direct, falls back to ST's /proxy/ endpoint
let _corsProxyState = 0; // 0=unknown, 1=direct works, 2=proxy works, -1=proxy disabled, -2=blocked by basicAuth
async function corsFetch(url, opts = {}) {
    const crossOrigin = (() => {
        try { return new URL(url).origin !== location.origin; } catch { return true; }
    })();
    const requestHasOwnAuthorization = hasAuthorizationHeader(opts.headers);
    // Prefer direct fetch; only skip direct cross-origin when proxy has already been proven required.
    if (!crossOrigin || _corsProxyState !== 2) {
        try {
            const res = await fetch(url, opts);
            if (crossOrigin && _corsProxyState !== -2) _corsProxyState = 1;
            return res;
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (!(e instanceof TypeError)) throw e;
            if (!crossOrigin) throw e;
            // TypeError on cross-origin usually means CORS/network failure, try proxy.
        }
    }
    if (_corsProxyState === -2 && requestHasOwnAuthorization) {
        throw new CorsProxyBasicAuthError(url);
    }
    if (_corsProxyState === -1) {
        throw new TypeError(`Cannot reach ${url} (CORS). Enable enableCorsProxy in SillyTavern config.yaml or launch A1111 with --cors-allow-origins=*`);
    }
    const proxyUrl = `/proxy/${url}`;
    // Merge ST request headers (CSRF token) into proxy requests
    const stHeaders = typeof getRequestHeaders === 'function' ? getRequestHeaders() : {};
    const mergedHeaders = { ...stHeaders, ...opts.headers };
    const res = await fetch(proxyUrl, { ...opts, headers: mergedHeaders });
    if (requestHasOwnAuthorization && res.status === 401 && isBasicAuthChallenge(res.headers.get("www-authenticate"))) {
        _corsProxyState = -2;
        await res.text().catch(() => {});
        throw new CorsProxyBasicAuthError(url);
    }
    if (res.status === 404) {
        const text = await res.text();
        if (text.includes('CORS proxy is disabled')) {
            _corsProxyState = -1;
            throw new TypeError(`Cannot reach ${url} (CORS). Enable enableCorsProxy in SillyTavern config.yaml or launch A1111 with --cors-allow-origins=*`);
        }
    }
    if (res.status !== 403) _corsProxyState = 2;
    return res;
}

// A1111 Model API helpers
let a1111ModelsCache = [];
let a1111ControlNetScriptKey = "ControlNet";
async function fetchA1111Models(url) {
    try {
        const baseUrl = url.replace(/\/$/, "");
        const res = await corsFetch(`${baseUrl}/sdapi/v1/sd-models`);
        if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
        const models = await res.json();
        a1111ModelsCache = models.map(m => ({ title: m.title, name: m.model_name }));
        log(`A1111: Found ${a1111ModelsCache.length} models`);
        return a1111ModelsCache;
    } catch (e) {
        log(`A1111: Error fetching models: ${e.message}`);
        return [];
    }
}

async function fetchControlNetModels(url) {
    const baseUrl = url.replace(/\/$/, "");
    const endpoints = [
        `${baseUrl}/controlnet/model_list`,
        `${baseUrl}/api/proxy/controlnet/model_list`
    ];
    for (const endpoint of endpoints) {
        try {
            const res = await corsFetch(endpoint);
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data?.model_list)) return data.model_list;
        } catch {}
    }
    return [];
}

async function switchA1111Model(url, modelTitle) {
    try {
        const baseUrl = url.replace(/\/$/, "");
        log(`A1111: Switching to model: ${modelTitle}`);
        const res = await corsFetch(`${baseUrl}/sdapi/v1/options`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sd_model_checkpoint: modelTitle })
        });
        if (!res.ok) throw new Error(`Failed to switch model: ${res.status}`);
        log(`A1111: Model switched successfully`);
        return true;
    } catch (e) {
        log(`A1111: Error switching model: ${e.message}`);
        return false;
    }
}

async function getCurrentA1111Model(url) {
    try {
        const baseUrl = url.replace(/\/$/, "");
        const res = await corsFetch(`${baseUrl}/sdapi/v1/options`);
        if (!res.ok) return null;
        const opts = await res.json();
        return opts.sd_model_checkpoint || null;
    } catch {
        return null;
    }
}

async function fetchA1111Upscalers(url) {
    try {
        const res = await corsFetch(`${url.replace(/\/$/, "")}/sdapi/v1/upscalers`);
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()).map(u => u.name);
    } catch (e) {
        return ["Latent", "Latent (antialiased)", "Latent (bicubic)",
                "Latent (bicubic antialiased)", "Latent (nearest)",
                "Latent (nearest-exact)", "None"];
    }
}

async function fetchA1111VAEs(url) {
    try {
        const res = await corsFetch(`${url.replace(/\/$/, "")}/sdapi/v1/sd-vae`);
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()).map(v => v.model_name);
    } catch (e) {
        log("Failed to fetch VAE list: " + e.message);
        return [];
    }
}

async function fetchComfyNodeModelList(baseUrl, nodeClass, inputKey) {
    const res = await corsFetch(`${baseUrl}/object_info/${nodeClass}`);
    if (!res.ok) {
        if (res.status === 403) {
            throw new Error("ComfyUI returned 403 Forbidden. This is usually caused by ComfyUI-Manager's security check. Fix: in ComfyUI-Manager settings, set Security Level to 'normal', then restart ComfyUI. Also ensure ComfyUI is launched with --enable-cors-header.");
        }
        return [];
    }
    const data = await res.json();
    const values = data?.[nodeClass]?.input?.required?.[inputKey]?.[0];
    return Array.isArray(values) ? values : [];
}

async function fetchComfyUIModels(url, preferUnet = false) {
    const rethrow403 = (e) => { if (e.message?.includes("403 Forbidden")) throw e; return []; };
    try {
        const baseUrl = url.replace(/\/$/, "");
        const [ckpts, unets] = await Promise.all([
            fetchComfyNodeModelList(baseUrl, "CheckpointLoaderSimple", "ckpt_name").catch(rethrow403),
            fetchComfyNodeModelList(baseUrl, "UNETLoader", "unet_name").catch(rethrow403)
        ]);

        if (preferUnet) {
            if (unets.length > 0) return unets;
            if (ckpts.length > 0) {
                log("ComfyUI: UNET list unavailable, falling back to checkpoints");
                return ckpts;
            }
        } else {
            if (ckpts.length > 0) return ckpts;
            if (unets.length > 0) {
                log("ComfyUI: Checkpoint list unavailable, falling back to UNET models");
                return unets;
            }
        }
        return [];
    } catch (e) {
        log("Failed to fetch ComfyUI models: " + e.message);
        if (e.message?.includes("403 Forbidden")) throw e;
        return [];
    }
}

const cachedElements = {};

function getOrCacheElement(id) {
    if (cachedElements[id]) return cachedElements[id];
    const el = document.getElementById(id);
    if (el) cachedElements[id] = el;
    return el;
}

function clearCache() {
    for (const key in cachedElements) {
        delete cachedElements[key];
    }
}

function showStatus(msg) {
    let status = cachedElements["qig-status"];
    if (!status) {
        status = document.createElement("div");
        status.id = "qig-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.setAttribute("aria-atomic", "true");
        document.body.appendChild(status);
        cachedElements["qig-status"] = status;
    }
    if (msg) {
        status.textContent = msg;
        status.style.display = "block";
    } else {
        status.style.display = "none";
    }
}

const hideStatus = () => showStatus();

function setGenerationActiveUI(active, { disableGenerateButton = false } = {}) {
    const paletteBtn = getOrCacheElement("qig-input-btn");
    if (paletteBtn) {
        if (active) {
            paletteBtn.classList.remove("fa-palette");
            paletteBtn.classList.add("fa-spinner", "fa-spin");
            paletteBtn.title = "Cancel Generation";
            paletteBtn.style.opacity = "0.7";
        } else {
            paletteBtn.classList.remove("fa-spinner", "fa-spin");
            paletteBtn.classList.add("fa-palette");
            paletteBtn.title = "Generate Image (right-click for presets)";
            paletteBtn.style.opacity = "0.7";
        }
    }

    if (!disableGenerateButton) return;
    const btn = getOrCacheElement("qig-generate-btn");
    if (!btn) return;
    if (active) {
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        btn.innerHTML = '<span class="fa-solid fa-spinner fa-spin" aria-hidden="true"></span><span>Generating...</span>';
    } else {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.innerHTML = '<span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span><span>Generate</span><span class="qig-shortcut-hint">Ctrl+Enter</span>';
    }
}

function beginGeneration({ disableGenerateButton = false, clearPendingAuto = false } = {}) {
    closePalettePresetMenu();
    if (clearPendingAuto) {
        resetAutoGenerateCadence({ clearTimer: true });
    }
    cancelRequested = false;
    isGenerating = true;
    currentAbortController = new AbortController();
    setGenerationActiveUI(true, { disableGenerateButton });
}

function endGeneration({ disableGenerateButton = false } = {}) {
    currentAbortController = null;
    isGenerating = false;
    cancelRequested = false;
    paletteCancelLockUntil = 0;
    showStatus(null);
    setGenerationActiveUI(false, { disableGenerateButton });
}

function requestGenerationCancel() {
    if (!isGenerating) return false;
    const now = Date.now();
    if (now < paletteCancelLockUntil) {
        log("Palette: Ignored rapid duplicate cancel click");
        return false;
    }
    if (currentAbortController?.signal?.aborted) {
        log("Cancel already requested, ignoring duplicate click");
        return false;
    }

    paletteCancelLockUntil = now + PALETTE_CANCEL_LOCK_MS;
    cancelRequested = true;
    cancelRequestSerial += 1;
    if (currentAbortController) {
        currentAbortController.abort();
    }
    resetAutoGenerateCadence({ clearTimer: true });

    // Send server-side interrupt (fire-and-forget) so the GPU actually stops
    try {
        const s = extension_settings?.[extensionName];
        if (s?.provider === "local" && s.localUrl) {
            const baseUrl = s.localUrl.replace(/\/$/, "");
            if (s.localType === "comfyui") {
                corsFetch(`${baseUrl}/interrupt`, { method: "POST" }).catch(() => {});
            } else {
                corsFetch(`${baseUrl}/sdapi/v1/interrupt`, { method: "POST" }).catch(() => {});
            }
        }
    } catch (e) { /* best-effort */ }

    // Cancellation watchdog: keep the UI busy until the active async chain actually settles.
    const thisCancelSerial = cancelRequestSerial;
    setTimeout(() => {
        if (isGenerating && cancelRequestSerial === thisCancelSerial && currentAbortController?.signal?.aborted) {
            log("Cancel watchdog: generation is still settling after 5 seconds");
        }
    }, 5000);

    const paletteBtn = getOrCacheElement("qig-input-btn");
    if (paletteBtn) {
        paletteBtn.title = "Cancelling...";
        paletteBtn.style.opacity = "0.4";
    }
    return true;
}

function cleanupLegacyTemplateStores(settings = getSettings()) {
    const s = settings || getSettings();
    if (!s || s._legacyTemplatesIgnored) return false;

    let changed = false;
    if (localStorage.getItem("qig_templates") != null) {
        localStorage.removeItem("qig_templates");
        changed = true;
    }
    if (s._backupTemplates != null) {
        s._backupTemplates = null;
        changed = true;
    }
    s._legacyTemplatesIgnored = true;
    return changed;
}

function buildMigratedReplacementFilter(rule) {
    if (!rule || typeof rule !== "object") return null;

    const trigger = String(rule.trigger || "").trim();
    const replacement = String(rule.replacement || "").trim();
    if (!trigger || !replacement) return null;

    const scopeInfo = getNormalizedScopedRecord(rule.scope, {
        charId: rule.charId,
        cardKey: rule.cardKey,
        cardLabel: rule.cardLabel,
    });
    const priority = Number(rule.priority);
    const target = rule.target === "positive" || rule.target === "negative" || rule.target === "both"
        ? rule.target
        : "both";
    const migrated = {
        id: generateUUID(),
        name: `Migrated: ${String(rule.name || "Replacement map").trim() || "Replacement map"}`,
        enabled: rule.enabled !== false,
        keywords: trigger,
        matchMode: "OR",
        description: "",
        positive: target === "negative" ? "" : replacement,
        negative: target === "positive" ? "" : replacement,
        removePositive: target === "negative" ? "" : trigger,
        removeNegative: target === "positive" ? "" : trigger,
        removeMode: "remove",
        priority: Number.isFinite(priority) ? Math.trunc(priority) : 0,
        scope: scopeInfo.scope,
        charId: scopeInfo.charId,
        cardKey: scopeInfo.cardKey,
        cardLabel: scopeInfo.cardLabel,
        poolIds: [DEFAULT_FILTER_POOL_ID],
        seedOverride: null,
        sortOrder: null,
        createdAt: rule.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return migrated;
}

function migratePromptReplacementsToFilters(rules, {
    settings = getSettings(),
    persist = false,
    sourceLabel = "saved settings",
} = {}) {
    const incoming = Array.isArray(rules) ? rules : [];
    if (!incoming.length) return { migratedCount: 0, addedCount: 0 };

    const migrated = incoming
        .map(buildMigratedReplacementFilter)
        .filter(Boolean);
    if (!migrated.length) {
        if (settings && sourceLabel === "saved settings") {
            settings._replacementMapsMigrated = true;
        }
        return { migratedCount: 0, addedCount: 0 };
    }

    contextualFilters.push(...migrated);
    normalizeContextualFilterOrder(contextualFilters);
    ensureFilterPoolsState({ persist });

    if (settings && sourceLabel === "saved settings") {
        settings._replacementMapsMigrated = true;
    }

    log(`Migrated ${migrated.length} prompt replacement map(s) from ${sourceLabel} into contextual filters`);
    return {
        migratedCount: incoming.length,
        addedCount: migrated.length,
    };
}

function migrateLegacyReplacementStores(settings = getSettings()) {
    const s = settings || getSettings();
    if (!s || s._replacementMapsMigrated) return false;

    const storedRules = [];
    const seenKeys = new Set();
    const appendRules = (value) => {
        if (!Array.isArray(value)) return;
        for (const rule of value) {
            if (!rule || typeof rule !== "object") continue;
            const key = JSON.stringify([
                rule.name || "",
                rule.scope || "",
                rule.charId || "",
                rule.target || "",
                rule.trigger || "",
                rule.replacement || "",
                rule.priority || 0,
            ]);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            storedRules.push(rule);
        }
    };

    appendRules(safeParse("qig_prompt_replacements", []));
    appendRules(s._backupPromptReplacements);

    if (storedRules.length) {
        migratePromptReplacementsToFilters(storedRules, {
            settings: s,
            persist: true,
            sourceLabel: "saved settings",
        });
    } else {
        s._replacementMapsMigrated = true;
    }

    localStorage.removeItem("qig_prompt_replacements");
    localStorage.removeItem("qig_active_prompt_replacement_ids_global");
    localStorage.removeItem("qig_active_prompt_replacement_ids_by_char");
    s._backupPromptReplacements = null;
    s._backupActivePromptReplacementIdsGlobal = null;
    s._backupActivePromptReplacementIdsByChar = null;
    return storedRules.length > 0;
}

async function loadSettings() {
    const saved = extension_settings[extensionName];
    extension_settings[extensionName] = { ...defaultSettings, ...saved };
    const s = extension_settings[extensionName];
    s.paletteMode = normalizePaletteMode(s.paletteMode);
    const savedTagName = getInjectTagName(saved);
    s.injectTagName = savedTagName;
    // Migrate old messageIndex to messageRange
    if (saved && "messageIndex" in saved && !("messageRange" in saved)) {
        s.messageRange = String(saved.messageIndex);
    }
    delete s.messageIndex;
    normalizeAutoGenerateSettings(s);
    s.backgroundMode = normalizeBackgroundMode(s.backgroundMode);
    if (typeof s.twoStepInstruction !== "string") s.twoStepInstruction = "";
    // Migrate generated inject defaults to the current tag-aware defaults while preserving custom overrides.
    if (saved && isGeneratedInjectRegex(saved.injectRegex, savedTagName)) {
        s.injectRegex = buildDefaultInjectRegex(savedTagName);
    }
    if (saved && isGeneratedInjectPrompt(saved.injectPrompt, savedTagName)) {
        s.injectPrompt = buildDefaultInjectPrompt(savedTagName);
    }
    if (!s.injectRegex) s.injectRegex = buildDefaultInjectRegex(savedTagName);
    if (!s.injectPrompt) s.injectPrompt = buildDefaultInjectPrompt(savedTagName);
    normalizeProxyChatImageSettings(s, saved);
    s.proxyEndpointMode = normalizeProxyEndpointSetting(s.proxyEndpointMode);
    normalizeProxyChatImageSettings(s, s);
    s.proxyPayloadMode = normalizeProxyPayloadSetting(s.proxyPayloadMode);
    s.proxyRefImageMode = normalizeProxyRefImageSetting(s.proxyRefImageMode);
    s.proxySse = normalizeProxySseSetting(s.proxySse);
    s.outputMode = normalizeOutputMode(s.outputMode);
    s.manualInsertTarget = normalizeManualInsertTarget(s.manualInsertTarget);
    cleanupLegacyTemplateStores(s);
    // Restore localStorage stores from extensionSettings backup if localStorage was wiped
    const restoreTargets = [
        { localKey: "qig_char_settings", backupKey: "_backupCharSettings", setter: v => { charSettings = v; } },
        { localKey: "qig_profiles", backupKey: "_backupProfiles", setter: v => { connectionProfiles = v; } },
        { localKey: "qig_char_ref_images", backupKey: "_backupCharRefImages", setter: v => { charRefImages = v; } },
        { localKey: "qig_gen_presets", backupKey: "_backupGenPresets", setter: v => { generationPresets = v; } },
        { localKey: "qig_comfy_workflows", backupKey: "_backupComfyWorkflows", setter: v => { comfyWorkflows = v; } },
        { localKey: "qig_contextual_filters", backupKey: "_backupContextualFilters", setter: v => { contextualFilters = v; } },
        { localKey: "qig_filter_pools", backupKey: "_backupFilterPools", setter: v => { filterPools = v; } },
        { localKey: "qig_active_pool_ids_global", backupKey: "_backupActiveFilterPoolIdsGlobal", setter: v => { activeFilterPoolIdsGlobal = v; } },
        { localKey: "qig_active_pool_ids_by_card", backupKey: "_backupActiveFilterPoolIdsByCard", setter: v => { activeFilterPoolIdsByCard = v; } },
        { localKey: "qig_active_pool_ids_by_char", backupKey: "_backupActiveFilterPoolIdsByChar", setter: v => { activeFilterPoolIdsByChar = v; } },
    ];
    let restoredCount = 0;
    for (const { localKey, backupKey, setter } of restoreTargets) {
        const localVal = localStorage.getItem(localKey);
        const backupVal = s[backupKey];
        if (backupVal == null) continue;

        let parsedLocal;
        let hasParsableLocal = false;
        if (localVal != null) {
            try {
                parsedLocal = JSON.parse(localVal);
                hasParsableLocal = true;
            } catch {
                hasParsableLocal = false;
            }
        }

        const expectsArray = Array.isArray(backupVal);
        const expectsObject = !expectsArray && typeof backupVal === "object" && backupVal !== null;
        const typeMismatch = hasParsableLocal && (
            (expectsArray && !Array.isArray(parsedLocal)) ||
            (expectsObject && (typeof parsedLocal !== "object" || parsedLocal === null || Array.isArray(parsedLocal)))
        );

        if (localVal == null || !hasParsableLocal || typeMismatch) {
            setter(backupVal);
            safeSetStorage(localKey, JSON.stringify(backupVal));
            restoredCount++;
        }
    }
    if (restoredCount > 0) {
        log(`Restored ${restoredCount} preset store(s) from server backup`);
        toastr?.info?.(`Restored ${restoredCount} setting(s) from server backup (localStorage was empty)`);
    }
    const normalizedPresets = normalizeGenerationPresetStore(generationPresets);
    ensureGenerationPresetIds({ persist: true });
    if (normalizedPresets) {
        saveGenerationPresetStore("Failed to migrate chat-image preset settings. Browser storage may be full.");
    }
    if (normalizeProxyProfileStore(connectionProfiles)) {
        safeSetStorage("qig_profiles", JSON.stringify(connectionProfiles), "Failed to migrate chat-image profiles. Browser storage may be full.");
        backupToSettings("qig_profiles", connectionProfiles);
    }
    syncActiveGenerationPresetSetting({ persist: true });
    ensureFilterPoolsState({ persist: true });
    migrateLegacyReplacementStores(s);
    saveSettingsDebounced?.();
}

function normalizePoolIdList(poolIds) {
    if (!Array.isArray(poolIds)) return [];
    const out = [];
    const seen = new Set();
    for (const id of poolIds) {
        const val = String(id || "").trim();
        if (!val || seen.has(val)) continue;
        seen.add(val);
        out.push(val);
    }
    return out;
}

function getDefaultFilterPool() {
    return {
        id: DEFAULT_FILTER_POOL_ID,
        name: DEFAULT_FILTER_POOL_NAME,
        scope: FILTER_SCOPE_GLOBAL,
        charId: null,
        cardKey: null,
        cardLabel: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function isDefaultFilterPoolName(name) {
    return String(name || "").trim().toLowerCase() === DEFAULT_FILTER_POOL_NAME.toLowerCase();
}

function saveFilterPools() {
    const ok = safeSetStorage("qig_filter_pools", JSON.stringify(filterPools), "Failed to save filter pools. Browser storage may be full.");
    if (ok) backupToSettings("qig_filter_pools", filterPools);
    return ok;
}

function saveActiveFilterPools() {
    const okGlobal = safeSetStorage("qig_active_pool_ids_global", JSON.stringify(activeFilterPoolIdsGlobal), "Failed to save active global pools. Browser storage may be full.");
    const okByCard = safeSetStorage("qig_active_pool_ids_by_card", JSON.stringify(activeFilterPoolIdsByCard), "Failed to save active card pools. Browser storage may be full.");
    const okByChar = safeSetStorage("qig_active_pool_ids_by_char", JSON.stringify(activeFilterPoolIdsByChar), "Failed to save active character pools. Browser storage may be full.");
    if (okGlobal) backupToSettings("qig_active_pool_ids_global", activeFilterPoolIdsGlobal);
    if (okByCard) backupToSettings("qig_active_pool_ids_by_card", activeFilterPoolIdsByCard);
    if (okByChar) backupToSettings("qig_active_pool_ids_by_char", activeFilterPoolIdsByChar);
    return okGlobal && okByCard && okByChar;
}

function persistFilterPoolState() {
    saveContextualFilters();
    saveFilterPools();
    saveActiveFilterPools();
}

function getActiveCardScopeKeys(ctx = getContext()) {
    const cardKey = getCurrentCardScopeInfo(ctx).cardKey;
    return cardKey ? [cardKey] : [];
}

function getEnabledPoolIdsForScope(scopeRef = getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL)) {
    const scopeInfo = getScopedRecordFromEntity(scopeRef);
    const enabled = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
    if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
        for (const id of normalizePoolIdList(activeFilterPoolIdsByCard?.[scopeInfo.cardKey])) {
            enabled.add(id);
        }
    }
    if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
        for (const id of normalizePoolIdList(activeFilterPoolIdsByChar?.[scopeInfo.charId])) {
            enabled.add(id);
        }
    }
    return enabled;
}

function getEnabledPoolIdsForCurrentContext() {
    const enabled = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
    for (const cardKey of getActiveCardScopeKeys()) {
        const cardPoolIds = normalizePoolIdList(activeFilterPoolIdsByCard?.[cardKey]);
        for (const id of cardPoolIds) enabled.add(id);
    }
    const activeCharIds = getActiveCharacterScopeIds();
    for (const charId of activeCharIds) {
        const charPoolIds = normalizePoolIdList(activeFilterPoolIdsByChar?.[String(charId)]);
        for (const id of charPoolIds) enabled.add(id);
    }
    return enabled;
}

function getSelectablePoolsForFilterScope(scopeRef) {
    const scopeInfo = getScopedRecordFromEntity(scopeRef);
    return filterPools.filter(pool => {
        const poolScope = getScopedRecordFromEntity(pool);
        if (poolScope.scope === FILTER_SCOPE_GLOBAL) return true;
        if (scopeInfo.scope === FILTER_SCOPE_CARD) {
            return poolScope.scope === FILTER_SCOPE_CARD && poolScope.cardKey === scopeInfo.cardKey;
        }
        if (scopeInfo.scope === FILTER_SCOPE_CHAR) {
            return poolScope.scope === FILTER_SCOPE_CHAR && poolScope.charId === scopeInfo.charId;
        }
        return false;
    });
}

function getVisibleFilterPools(scopeRef = getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL)) {
    const scopeInfo = getScopedRecordFromEntity(scopeRef);
    const globalPools = filterPools
        .filter(pool => getScopedRecordFromEntity(pool).scope === FILTER_SCOPE_GLOBAL)
        .sort((a, b) => a.name.localeCompare(b.name));
    const scopedPools = filterPools
        .filter(pool => {
            const poolScope = getScopedRecordFromEntity(pool);
            if (scopeInfo.scope === FILTER_SCOPE_CARD) {
                return poolScope.scope === FILTER_SCOPE_CARD && poolScope.cardKey === scopeInfo.cardKey;
            }
            if (scopeInfo.scope === FILTER_SCOPE_CHAR) {
                return poolScope.scope === FILTER_SCOPE_CHAR && poolScope.charId === scopeInfo.charId;
            }
            return false;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    return { globalPools, scopedPools, scopeInfo };
}

function ensureFilterPoolsState({ persist = false } = {}) {
    let changed = false;

    const incomingPools = Array.isArray(filterPools) ? filterPools : [];
    if (!Array.isArray(filterPools)) changed = true;
    const normalizedPools = [];
    const seenPoolIds = new Set();
    for (const rawPool of incomingPools) {
        if (!rawPool || typeof rawPool !== "object") { changed = true; continue; }
        const id = String(rawPool.id || "").trim();
        if (!id || seenPoolIds.has(id)) { changed = true; continue; }
        const name = String(rawPool.name || "").trim() || (id === DEFAULT_FILTER_POOL_ID ? DEFAULT_FILTER_POOL_NAME : "Untitled Pool");
        const scopeInfo = id === DEFAULT_FILTER_POOL_ID
            ? getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL)
            : getNormalizedScopedRecord(rawPool.scope, {
                charId: rawPool.charId,
                cardKey: rawPool.cardKey,
                cardLabel: rawPool.cardLabel,
            });
        if (rawPool.scope === FILTER_SCOPE_CARD && !scopeInfo.cardKey) { changed = true; continue; }
        if (rawPool.scope === FILTER_SCOPE_CHAR && !scopeInfo.charId) { changed = true; continue; }
        normalizedPools.push({
            id,
            name,
            scope: scopeInfo.scope,
            charId: scopeInfo.scope === FILTER_SCOPE_CHAR ? scopeInfo.charId : null,
            cardKey: scopeInfo.scope === FILTER_SCOPE_CARD ? scopeInfo.cardKey : null,
            cardLabel: scopeInfo.scope === FILTER_SCOPE_CARD ? scopeInfo.cardLabel : "",
            createdAt: rawPool.createdAt || new Date().toISOString(),
            updatedAt: rawPool.updatedAt || new Date().toISOString(),
        });
        seenPoolIds.add(id);
    }
    if (!seenPoolIds.has(DEFAULT_FILTER_POOL_ID)) {
        normalizedPools.unshift(getDefaultFilterPool());
        seenPoolIds.add(DEFAULT_FILTER_POOL_ID);
        changed = true;
    }
    filterPools = normalizedPools;

    const globalPoolIds = new Set(filterPools.filter(p => getScopedRecordFromEntity(p).scope === FILTER_SCOPE_GLOBAL).map(p => p.id));
    const cardPoolsByCard = new Map();
    const charPoolsByChar = new Map();
    for (const pool of filterPools) {
        const scopeInfo = getScopedRecordFromEntity(pool);
        if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
            const key = scopeInfo.cardKey;
            if (!cardPoolsByCard.has(key)) cardPoolsByCard.set(key, new Set());
            cardPoolsByCard.get(key).add(pool.id);
            continue;
        }
        if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
            const key = String(scopeInfo.charId);
            if (!charPoolsByChar.has(key)) charPoolsByChar.set(key, new Set());
            charPoolsByChar.get(key).add(pool.id);
        }
    }

    const hadStoredGlobalPoolState =
        localStorage.getItem("qig_active_pool_ids_global") != null ||
        extension_settings?.[extensionName]?._backupActiveFilterPoolIdsGlobal != null;
    const hadStoredCardPoolState =
        localStorage.getItem("qig_active_pool_ids_by_card") != null ||
        extension_settings?.[extensionName]?._backupActiveFilterPoolIdsByCard != null;
    const originalGlobalIds = normalizePoolIdList(activeFilterPoolIdsGlobal);
    let nextGlobalIds = originalGlobalIds.filter(id => globalPoolIds.has(id));
    if (!hadStoredGlobalPoolState && nextGlobalIds.length === 0 && globalPoolIds.has(DEFAULT_FILTER_POOL_ID)) {
        nextGlobalIds.push(DEFAULT_FILTER_POOL_ID);
    }
    if (JSON.stringify(originalGlobalIds) !== JSON.stringify(nextGlobalIds)) changed = true;
    activeFilterPoolIdsGlobal = nextGlobalIds;

    const incomingByCard = activeFilterPoolIdsByCard && typeof activeFilterPoolIdsByCard === "object" && !Array.isArray(activeFilterPoolIdsByCard)
        ? activeFilterPoolIdsByCard
        : {};
    if (incomingByCard !== activeFilterPoolIdsByCard) changed = true;
    const nextByCard = {};
    for (const [cardKeyRaw, ids] of Object.entries(incomingByCard)) {
        const cardKey = normalizeCardScopeKey(cardKeyRaw);
        const allowed = cardPoolsByCard.get(cardKey);
        if (!allowed?.size) {
            if (Array.isArray(ids) && ids.length) changed = true;
            continue;
        }
        const normalizedIds = normalizePoolIdList(ids).filter(id => allowed.has(id));
        if (normalizedIds.length > 0) nextByCard[cardKey] = normalizedIds;
        if (JSON.stringify(normalizePoolIdList(ids)) !== JSON.stringify(normalizedIds)) changed = true;
    }
    if (!hadStoredCardPoolState) {
        for (const [cardKey, ids] of cardPoolsByCard.entries()) {
            if (nextByCard[cardKey]?.length) continue;
            const defaultPool = filterPools.find(pool => {
                const poolScope = getScopedRecordFromEntity(pool);
                return poolScope.scope === FILTER_SCOPE_CARD &&
                    poolScope.cardKey === cardKey &&
                    isDefaultFilterPoolName(pool.name);
            });
            if (defaultPool?.id) {
                nextByCard[cardKey] = [defaultPool.id];
                changed = true;
            }
        }
    }
    if (JSON.stringify(incomingByCard) !== JSON.stringify(nextByCard)) changed = true;
    activeFilterPoolIdsByCard = nextByCard;

    const incomingByChar = activeFilterPoolIdsByChar && typeof activeFilterPoolIdsByChar === "object" && !Array.isArray(activeFilterPoolIdsByChar)
        ? activeFilterPoolIdsByChar
        : {};
    if (incomingByChar !== activeFilterPoolIdsByChar) changed = true;
    const nextByChar = {};
    for (const [charIdRaw, ids] of Object.entries(incomingByChar)) {
        const charId = String(charIdRaw);
        const allowed = charPoolsByChar.get(charId);
        if (!allowed?.size) {
            if (Array.isArray(ids) && ids.length) changed = true;
            continue;
        }
        const normalizedIds = normalizePoolIdList(ids).filter(id => allowed.has(id));
        if (normalizedIds.length > 0) nextByChar[charId] = normalizedIds;
        if (JSON.stringify(normalizePoolIdList(ids)) !== JSON.stringify(normalizedIds)) changed = true;
    }
    if (JSON.stringify(incomingByChar) !== JSON.stringify(nextByChar)) changed = true;
    activeFilterPoolIdsByChar = nextByChar;

    if (!Array.isArray(contextualFilters)) {
        contextualFilters = [];
        changed = true;
    }
    for (const filter of contextualFilters) {
        if (!filter || typeof filter !== "object") continue;
        const filterScope = getScopedRecordFromEntity(filter);
        if (filterScope.scope === FILTER_SCOPE_CARD && filterScope.cardKey) {
            const defaultPool = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
                scope: FILTER_SCOPE_CARD,
                cardKey: filterScope.cardKey,
                cardLabel: filterScope.cardLabel,
                enable: true,
            });
            if (defaultPool?.id && !cardPoolsByCard.has(filterScope.cardKey)) {
                if (!cardPoolsByCard.has(filterScope.cardKey)) cardPoolsByCard.set(filterScope.cardKey, new Set());
                cardPoolsByCard.get(filterScope.cardKey).add(defaultPool.id);
                changed = true;
            }
        }
    }
    const validPoolIds = new Set(filterPools.map(p => p.id));
    for (const filter of contextualFilters) {
        if (!filter || typeof filter !== "object") { changed = true; continue; }
        const scopeInfo = getScopedRecordFromEntity(filter);
        if (filter.scope !== scopeInfo.scope) changed = true;
        if ((filter.charId ?? null) !== (scopeInfo.charId ?? null)) changed = true;
        if ((normalizeCardScopeKey(filter.cardKey) || null) !== (scopeInfo.cardKey ?? null)) changed = true;
        if (normalizeScopeLabel(filter.cardLabel) !== normalizeScopeLabel(scopeInfo.cardLabel)) changed = true;
        filter.scope = scopeInfo.scope;
        filter.charId = scopeInfo.charId;
        filter.cardKey = scopeInfo.cardKey;
        filter.cardLabel = scopeInfo.cardLabel;
        const before = normalizePoolIdList(filter.poolIds);
        let after = before.filter(id => validPoolIds.has(id));
        if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
            const hasCardPool = after.some(id => {
                const pool = filterPools.find(entry => entry.id === id);
                const poolScope = getScopedRecordFromEntity(pool);
                return poolScope.scope === FILTER_SCOPE_CARD && poolScope.cardKey === scopeInfo.cardKey;
            });
            if (!hasCardPool) {
                const defaultCardPool = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
                    scope: FILTER_SCOPE_CARD,
                    cardKey: scopeInfo.cardKey,
                    cardLabel: scopeInfo.cardLabel,
                    enable: true,
                });
                if (defaultCardPool?.id) {
                    after = after.filter(id => id !== DEFAULT_FILTER_POOL_ID);
                    after.unshift(defaultCardPool.id);
                }
            }
        }
        if (!after.length) after.push(DEFAULT_FILTER_POOL_ID);
        if (JSON.stringify(before) !== JSON.stringify(after)) changed = true;
        filter.poolIds = after;
        const nextSeedOverride = normalizeSeedOverride(filter.seedOverride);
        if (filter.seedOverride !== nextSeedOverride) changed = true;
        filter.seedOverride = nextSeedOverride;
        const nextPriority = getContextualFilterPriorityValue(filter);
        if (filter.priority !== nextPriority) changed = true;
        filter.priority = nextPriority;
    }
    if (normalizeContextualFilterOrder(contextualFilters)) changed = true;

    if (persist) {
        persistFilterPoolState();
    }
    return changed;
}

function getContextualFilterPriorityValue(filter) {
    const priority = Number(filter?.priority);
    return Number.isFinite(priority) ? Math.trunc(priority) : 0;
}

function getContextualFilterScopeRank(filter) {
    const scope = getScopedRecordFromEntity(filter).scope;
    if (scope === FILTER_SCOPE_CARD) return 2;
    if (scope === FILTER_SCOPE_CHAR) return 1;
    return 0;
}

function normalizeContextualFilterSortOrder(value, fallback = null) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.trunc(numeric));
}

function getContextualFilterScopeKey(filterOrScope) {
    const scopeInfo = filterOrScope && typeof filterOrScope === "object"
        ? getScopedRecordFromEntity(filterOrScope)
        : (filterOrScope != null && filterOrScope !== ""
            ? getNormalizedScopedRecord(FILTER_SCOPE_CHAR, { charId: filterOrScope })
            : getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL));
    if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) return `card:${scopeInfo.cardKey}`;
    if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) return `char:${scopeInfo.charId}`;
    return FILTER_SCOPE_GLOBAL;
}

function compareContextualFilters(a, b) {
    const byPriority = getContextualFilterPriorityValue(b) - getContextualFilterPriorityValue(a);
    if (byPriority !== 0) return byPriority;

    const byScope = getContextualFilterScopeRank(b) - getContextualFilterScopeRank(a);
    if (byScope !== 0) return byScope;

    const aSort = normalizeContextualFilterSortOrder(a?.sortOrder, Number.MAX_SAFE_INTEGER);
    const bSort = normalizeContextualFilterSortOrder(b?.sortOrder, Number.MAX_SAFE_INTEGER);
    if (aSort !== bSort) return aSort - bSort;

    return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function normalizeContextualFilterOrder(filterList = contextualFilters) {
    if (!Array.isArray(filterList)) return false;
    const byScope = new Map();

    filterList.forEach((filter, index) => {
        if (!filter || typeof filter !== "object") return;
        const scopeKey = getContextualFilterScopeKey(filter);
        if (!byScope.has(scopeKey)) byScope.set(scopeKey, []);
        byScope.get(scopeKey).push({
            filter,
            index,
            existingSortOrder: normalizeContextualFilterSortOrder(filter.sortOrder, null),
        });
    });

    let changed = false;
    for (const entries of byScope.values()) {
        entries.sort((a, b) => {
            const aHasSort = a.existingSortOrder != null;
            const bHasSort = b.existingSortOrder != null;
            if (aHasSort && bHasSort && a.existingSortOrder !== b.existingSortOrder) {
                return a.existingSortOrder - b.existingSortOrder;
            }
            if (aHasSort !== bHasSort) return aHasSort ? -1 : 1;
            return a.index - b.index;
        });

        entries.forEach((entry, nextIndex) => {
            if (entry.filter.sortOrder !== nextIndex) changed = true;
            entry.filter.sortOrder = nextIndex;
        });
    }

    return changed;
}

function normalizeContextLookupValue(value) {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeCardScopeKey(value) {
    return normalizeContextLookupValue(value);
}

function normalizeScopeLabel(value) {
    return String(value || "").trim();
}

function formatCardScopeFallbackLabel(cardKey) {
    const raw = String(cardKey || "").trim();
    if (!raw) return "Card";
    const tail = raw.split(/[\\/]/).filter(Boolean).pop();
    return tail || raw;
}

function getNormalizedScopedRecord(scope, { charId = null, cardKey = null, cardLabel = null } = {}) {
    if (scope === FILTER_SCOPE_CARD || (cardKey != null && cardKey !== "")) {
        const normalizedCardKey = normalizeCardScopeKey(cardKey);
        if (!normalizedCardKey) {
            return {
                scope: FILTER_SCOPE_GLOBAL,
                charId: null,
                cardKey: null,
                cardLabel: "",
            };
        }
        const normalizedCardLabel = normalizeScopeLabel(cardLabel) || formatCardScopeFallbackLabel(cardKey);
        return {
            scope: FILTER_SCOPE_CARD,
            charId: null,
            cardKey: normalizedCardKey,
            cardLabel: normalizedCardLabel,
        };
    }

    if (scope === FILTER_SCOPE_CHAR || (charId != null && charId !== "")) {
        const normalizedCharId = charId != null && charId !== "" ? String(charId) : null;
        if (!normalizedCharId) {
            return {
                scope: FILTER_SCOPE_GLOBAL,
                charId: null,
                cardKey: null,
                cardLabel: "",
            };
        }
        return {
            scope: FILTER_SCOPE_CHAR,
            charId: normalizedCharId,
            cardKey: null,
            cardLabel: "",
        };
    }

    return {
        scope: FILTER_SCOPE_GLOBAL,
        charId: null,
        cardKey: null,
        cardLabel: "",
    };
}

function getScopedRecordFromEntity(entity) {
    if (!entity || typeof entity !== "object") {
        return getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL);
    }
    return getNormalizedScopedRecord(entity.scope, {
        charId: entity.charId,
        cardKey: entity.cardKey,
        cardLabel: entity.cardLabel,
    });
}

function uniqueStringList(values) {
    const seen = new Set();
    const result = [];
    for (const value of (values || [])) {
        const str = String(value ?? "").trim();
        if (!str || seen.has(str)) continue;
        seen.add(str);
        result.push(str);
    }
    return result;
}

function truncateForContext(text, maxLen = 1200) {
    const str = String(text || "").trim();
    if (!str) return "";
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen - 3)}...`;
}

const GENERIC_CHARACTER_LABEL_PATTERN = /\b(roleplay|scenario|slice\s+of\s+life|sandbox|simulation|simulator|story|chat|setting|world|universe|template|preset|adventure)\b/i;
const CHARACTER_NAME_STOPWORDS = new Set([
    "a", "an", "and", "answer", "based", "character", "characters", "close", "current", "description",
    "explicit", "filter", "filters", "image", "include", "life", "maybe", "no", "none", "output", "prompt",
    "reply", "respond", "roleplay", "scene", "scenes", "setting", "slice", "source", "story", "suburban",
    "tag", "tags", "template", "the", "this", "use", "user", "when", "world", "write", "yes",
]);

function isLikelyGenericCharacterLabel(name) {
    const str = normalizeScopeLabel(name);
    if (!str) return true;
    if (GENERIC_CHARACTER_LABEL_PATTERN.test(str)) return true;
    const words = str.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return true;
    return words.length >= 3 && words.every(word => word === word.toLowerCase());
}

function sanitizeExtractedCharacterName(name) {
    const str = normalizeScopeLabel(name).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!str || str.length < 2 || str.length > 48) return "";
    if (/^\d+$/.test(str)) return "";
    if (CHARACTER_NAME_STOPWORDS.has(str.toLowerCase())) return "";
    if (isLikelyGenericCharacterLabel(str)) return "";
    return str;
}

function extractLikelyCharacterNames(text) {
    const source = String(text || "");
    if (!source.trim()) return [];

    const weights = new Map();
    const add = (candidate, weight = 1) => {
        const name = sanitizeExtractedCharacterName(candidate);
        if (!name) return;
        weights.set(name, (weights.get(name) || 0) + weight);
    };

    const patterns = [
        { regex: /(?:^|\n)\s*([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\s*:/gm, weight: 3 },
        { regex: /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b(?=\s*,\s*(?:an?|the)\b)/g, weight: 3 },
        { regex: /\bnamed\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g, weight: 3 },
        { regex: /\(([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\)/g, weight: 2 },
        { regex: /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b(?=\s+(?:is|wears|has|stands|sits|runs|walks|leans|looks|smiles|frowns|grimaces|massages|props|stops|turns|glances|thinks|said|says)\b)/g, weight: 2 },
    ];

    for (const { regex, weight } of patterns) {
        for (const match of source.matchAll(regex)) {
            add(match[1], weight);
        }
    }

    return [...weights.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
}

function getCharacterCardTags(charData) {
    if (!charData) return [];
    if (Array.isArray(charData.tags)) {
        return charData.tags.map(tag => String(tag || "").trim()).filter(Boolean);
    }
    if (typeof charData.tags === "string") {
        return charData.tags.split(",").map(tag => tag.trim()).filter(Boolean);
    }
    return [];
}

function getContextCharactersList(ctx) {
    const chars = ctx?.characters;
    if (!chars) return [];
    const entries = [];
    if (Array.isArray(chars)) {
        chars.forEach((charData, index) => {
            if (!charData || typeof charData !== "object") return;
            const id = String(index);
            entries.push({
                id,
                name: String(charData.name || charData.avatar || `Character ${id}`).trim(),
                avatar: String(charData.avatar || "").trim(),
                data: charData,
            });
        });
        return entries;
    }
    if (typeof chars === "object") {
        for (const [key, charData] of Object.entries(chars)) {
            if (!charData || typeof charData !== "object") continue;
            const id = String(key);
            entries.push({
                id,
                name: String(charData.name || charData.avatar || `Character ${id}`).trim(),
                avatar: String(charData.avatar || "").trim(),
                data: charData,
            });
        }
    }
    return entries;
}

function getCharacterEntryById(charId, ctx = getContext()) {
    if (charId == null) return null;
    const key = normalizeContextLookupValue(charId);
    if (!key) return null;
    return getContextCharactersList(ctx).find(entry =>
        normalizeContextLookupValue(entry.id) === key ||
        normalizeContextLookupValue(entry.data?.id) === key
    ) || null;
}

function getCurrentCharacterEntry(ctx = getContext()) {
    if (ctx?.characterId != null) {
        const match = getCharacterEntryById(ctx.characterId, ctx);
        if (match) return match;
    }
    const characters = getContextCharactersList(ctx);
    return characters.length === 1 ? characters[0] : null;
}

function getCurrentCardScopeInfo(ctx = getContext()) {
    const entry = getCurrentCharacterEntry(ctx);
    const rawCardKey = String(entry?.avatar || entry?.data?.avatar || "").trim();
    const normalizedCardKey = normalizeCardScopeKey(rawCardKey);
    return {
        entry,
        cardKey: normalizedCardKey || null,
        cardLabel: normalizedCardKey
            ? (normalizeScopeLabel(entry?.name || entry?.avatar || entry?.data?.name) || formatCardScopeFallbackLabel(rawCardKey))
            : null,
    };
}

function getGroupObjectFromContext(ctx) {
    const groupId = ctx?.groupId;
    if (groupId == null) return null;
    const normalizedGroupId = String(groupId);
    if (ctx?.group && (ctx.group.id == null || String(ctx.group.id) === normalizedGroupId)) {
        return ctx.group;
    }
    const groups = ctx?.groups;
    if (Array.isArray(groups)) {
        return groups.find(group => String(group?.id ?? group?.group_id ?? "") === normalizedGroupId) || null;
    }
    if (groups && typeof groups === "object") {
        if (groups[groupId]) return groups[groupId];
        for (const [key, group] of Object.entries(groups)) {
            if (!group) continue;
            if (String(group.id ?? key) === normalizedGroupId || String(key) === normalizedGroupId) {
                return group;
            }
        }
    }
    return null;
}

function getRecentSpeakerNames(ctx, maxItems = 8) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const names = [];
    for (let i = chat.length - 1; i >= 0 && names.length < maxItems; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const name = String(msg.name || "").trim();
        if (!name) continue;
        names.push(name);
    }
    return uniqueStringList(names);
}

function resolveGroupCharacterEntries(ctx, characters) {
    const byId = new Map();
    const byAvatar = new Map();
    const byName = new Map();

    for (const entry of characters) {
        const idKey = normalizeContextLookupValue(entry.id);
        if (idKey) byId.set(idKey, entry);

        const modelId = normalizeContextLookupValue(entry.data?.id);
        if (modelId) byId.set(modelId, entry);

        const avatarKey = normalizeContextLookupValue(entry.avatar || entry.data?.avatar);
        if (avatarKey) byAvatar.set(avatarKey, entry);

        const nameKey = normalizeContextLookupValue(entry.name);
        if (nameKey) byName.set(nameKey, entry);
    }

    const group = getGroupObjectFromContext(ctx);
    const rawMembers = Array.isArray(group?.members)
        ? group.members
        : Array.isArray(group?.characters)
            ? group.characters
            : Array.isArray(group?.member_ids)
                ? group.member_ids
                : [];

    const resolved = [];
    const seenIds = new Set();
    const addEntry = (entry) => {
        if (!entry) return;
        if (seenIds.has(entry.id)) return;
        seenIds.add(entry.id);
        resolved.push(entry);
    };

    const resolveToken = (token) => {
        const normalized = normalizeContextLookupValue(token);
        if (!normalized) return null;
        return byId.get(normalized) || byAvatar.get(normalized) || byName.get(normalized) || null;
    };

    for (const member of rawMembers) {
        const candidates = [];
        if (member && typeof member === "object") {
            candidates.push(member.characterId, member.character_id, member.id, member.avatar, member.name);
        } else {
            candidates.push(member);
        }
        for (const token of candidates) {
            const match = resolveToken(token);
            if (match) {
                addEntry(match);
                break;
            }
        }
    }

    for (const speakerName of getRecentSpeakerNames(ctx)) {
        const match = byName.get(normalizeContextLookupValue(speakerName));
        if (match) addEntry(match);
    }

    if (!resolved.length && ctx?.characterId != null) {
        const fallback = resolveToken(ctx.characterId);
        if (fallback) addEntry(fallback);
    }
    if (!resolved.length && characters.length === 1) {
        addEntry(characters[0]);
    }

    return resolved;
}

function resolveChatProfileContext(ctx = getContext()) {
    if (!ctx) {
        return {
            isGroup: false,
            userName: "user",
            userDesc: "",
            charIds: [],
            charNames: [],
            charNameJoined: "character",
            primaryCharId: null,
            primaryCharName: "character",
            charDescCombined: "",
            charScenarioCombined: "",
            charTagsCombined: "",
            charCards: [],
        };
    }

    const isGroup = !!ctx.groupId;
    const characters = getContextCharactersList(ctx);
    let activeEntries = [];
    if (isGroup) {
        activeEntries = resolveGroupCharacterEntries(ctx, characters);
    } else if (ctx.characterId != null) {
        const key = normalizeContextLookupValue(ctx.characterId);
        activeEntries = characters.filter(entry =>
            normalizeContextLookupValue(entry.id) === key ||
            normalizeContextLookupValue(entry.data?.id) === key
        );
    } else if (characters.length === 1) {
        activeEntries = [characters[0]];
    }

    const charIds = uniqueStringList(activeEntries.map(entry => entry.id));
    if (!charIds.length && ctx.characterId != null) {
        charIds.push(String(ctx.characterId));
    }

    const charNames = uniqueStringList(activeEntries.map(entry => entry.name));
    const fallbackName = String(ctx.name2 || "").trim();
    if (!charNames.length && fallbackName) {
        charNames.push(fallbackName);
    }

    const charDescLines = [];
    const charScenarioLines = [];
    const tagSet = new Set();
    const charCards = [];
    for (const entry of activeEntries) {
        const data = entry.data || {};
        charCards.push(data);
        const desc = truncateForContext(data.description, 1500);
        if (desc) charDescLines.push(`${entry.name}: ${desc}`);

        const scenario = truncateForContext(data.scenario, 600);
        if (scenario) charScenarioLines.push(`${entry.name}: ${scenario}`);

        const creatorNotes = truncateForContext(data.creator_notes || data.creatorcomment, 600);
        if (creatorNotes) charScenarioLines.push(`${entry.name} notes: ${creatorNotes}`);

        for (const tag of getCharacterCardTags(data)) {
            tagSet.add(tag);
        }
    }

    return {
        isGroup,
        userName: String(ctx.name1 || "").trim() || "user",
        userDesc: String(ctx.persona || ctx.powerUserSettings?.persona_description || "").trim(),
        charIds,
        charNames,
        charNameJoined: charNames.length ? charNames.join(", ") : "character",
        primaryCharId: charIds[0] || null,
        primaryCharName: charNames[0] || "character",
        charDescCombined: charDescLines.join("\n"),
        charScenarioCombined: charScenarioLines.join("\n"),
        charTagsCombined: [...tagSet].join(", "),
        charCards,
    };
}

function getActiveCharacterScopeIds(ctx = getContext()) {
    const profile = resolveChatProfileContext(ctx);
    return uniqueStringList(profile.charIds);
}

function resolveContextualFilterText(value) {
    const profile = getPromptAwareProfileContext(resolveChatProfileContext());
    return resolvePrompt(value, {
        charName: profile.charNameJoined,
        userName: profile.userName,
    }).trim();
}

function buildProxyChatImagePersonalityContext(ctx = getContext()) {
    const profile = resolveLLMPromptProfileContext(ctx);
    const lines = [];
    if (profile.charNameJoined) {
        lines.push(`Active character(s): ${profile.charNameJoined}`);
    }
    if (profile.charDescResolved) {
        lines.push(`Character description:\n${truncateForContext(profile.charDescResolved, 2200)}`);
    }
    if (profile.charScenarioResolved) {
        lines.push(`Scenario:\n${truncateForContext(profile.charScenarioResolved, 900)}`);
    }
    if (profile.charTagsResolved) {
        lines.push(`Character tags: ${truncateForContext(profile.charTagsResolved, 600)}`);
    }
    if (profile.userDescResolved) {
        lines.push(`${profile.userName || "User"} persona:\n${truncateForContext(profile.userDescResolved, 700)}`);
    }
    return lines.join("\n\n").trim();
}

function buildProxyChatImageSystemPrompt(settings = getSettings(), ctx = getContext()) {
    const base = String(settings?.proxyChatImageSystemPrompt || DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT).trim();
    if (!settings?.proxyChatImageIncludePersonality) return base;
    const personality = buildProxyChatImagePersonalityContext(ctx || getContext());
    if (!personality) return base;
    return [base, "Use this chat personality context when it helps preserve identity, tone, outfit, and scene continuity:", personality]
        .filter(Boolean)
        .join("\n\n");
}

function getProxyChatMaxTokens(settings = getSettings()) {
    if (!settings?.proxyChatImageMode) return DEFAULT_PROXY_STANDARD_CHAT_MAX_TOKENS;
    return normalizeProxyChatImageMaxTokens(settings?.proxyChatImageMaxTokens);
}

function shouldAutoInsertChatImageAsAssistant(settings = getSettings()) {
    return settings?.provider === "proxy" && !!settings.proxyChatImageMode && !!settings.autoInsert;
}

function applyProxyChatImageSimpleMode({ persist = true, notify = true } = {}) {
    const s = getSettings();
    Object.assign(s, {
        provider: "proxy",
        proxyChatImageMode: true,
        proxyChatImageAllowImagesEndpoint: false,
        proxyEndpointMode: "chat_completions",
        proxyPayloadMode: "openai_strict",
        proxyRefImageMode: "inline_or_url",
        proxySse: "off",
        proxyTimeout: Math.max(600, parseIntOr(s.proxyTimeout, 600)),
        proxyComfyMode: false,
        useLastMessage: true,
        messageRange: "-1",
        useLLMPrompt: false,
        appendQuality: false,
        style: "none",
        batchCount: 1,
        sequentialSeeds: false,
        autoInsert: true,
        outputMode: "inline",
        manualInsertTarget: "assistant",
    });
    if (!String(s.proxyChatImageSystemPrompt || "").trim()) {
        s.proxyChatImageSystemPrompt = DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT;
    }
    s.proxyChatImageMaxTokens = DEFAULT_PROXY_CHAT_IMAGE_MAX_TOKENS;
    s.proxyChatImageMaxTokens = getProxyChatMaxTokens(s);
    if (persist) saveSettingsDebounced?.();
    if (notify) toastr?.success?.("Configured New-API Chat Image mode");
    refreshAllUI?.(s);
    return s;
}

function setProxyChatImageCheckboxMode(enabled) {
    const s = getSettings();
    s.proxyChatImageMode = !!enabled;
    if (s.proxyChatImageMode) {
        if (!String(s.proxyChatImageSystemPrompt || "").trim()) {
            s.proxyChatImageSystemPrompt = DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT;
        }
        s.proxyChatImageMaxTokens = normalizeProxyChatImageMaxTokens(s.proxyChatImageMaxTokens);
        s.proxyChatImageAllowImagesEndpoint = false;
        s.proxyEndpointMode = "chat_completions";
    }
    normalizeProxyChatImageSettings(s, s);
    saveSettingsDebounced?.();
    refreshAllUI?.(s);
    updateProxyCompatibilityUI?.();
    return s;
}

function resolveContextualFilter(filter) {
    if (!filter || typeof filter !== "object") return filter;
    return {
        ...filter,
        name: resolveContextualFilterText(filter.name || ""),
        description: resolveContextualFilterText(filter.description || ""),
        keywords: resolveContextualFilterText(filter.keywords || ""),
        positive: resolveContextualFilterText(filter.positive || ""),
        negative: resolveContextualFilterText(filter.negative || ""),
        removePositive: resolveContextualFilterText(filter.removePositive || ""),
        removeNegative: resolveContextualFilterText(filter.removeNegative || ""),
    };
}

function enrichSceneTextForFilters(sceneText, label = "Contextual filters") {
    const base = String(sceneText || "").trim();
    const profile = getPromptAwareProfileContext(resolveChatProfileContext(), base);
    const extraLines = [];
    if (profile.charNames.length) {
        extraLines.push(`Characters: ${profile.charNames.join(", ")}`);
    }
    if (profile.charDescResolved) {
        extraLines.push(`Character profiles:\n${truncateForContext(profile.charDescResolved, 1800)}`);
    }
    if (profile.userDescResolved) {
        extraLines.push(`${profile.userName} profile: ${truncateForContext(profile.userDescResolved, 600)}`);
    }
    if (!extraLines.length) return base;
    const missingLines = extraLines.filter(line => !base.includes(line));
    if (!missingLines.length) return base;
    const enriched = [base, ...missingLines].filter(Boolean).join("\n\n");
    const addedChars = Math.max(0, enriched.length - base.length);
    if (addedChars > 0) {
        log(`${label}: enriched matching context (+${addedChars} chars)`);
    }
    return enriched;
}

function getSettings() {
    return extension_settings[extensionName];
}

function getGenerationSettingsForRun() {
    const baseSettings = getSettings();
    if (!transientGenerationSettingsOverride || typeof transientGenerationSettingsOverride !== "object") {
        return baseSettings;
    }
    return { ...baseSettings, ...transientGenerationSettingsOverride };
}

async function withTransientGenerationSettings(overrides, task) {
    const previousOverride = transientGenerationSettingsOverride;
    transientGenerationSettingsOverride = {
        ...(previousOverride || {}),
        ...(overrides || {}),
    };
    try {
        return await task();
    } finally {
        transientGenerationSettingsOverride = previousOverride;
    }
}

function clampChatMessageIndex(index, chatLength) {
    if (!Number.isFinite(chatLength) || chatLength <= 0) return null;
    const numeric = Number(index);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(Math.trunc(numeric), chatLength - 1));
}

function setTransientGenerationTarget(messageIndex, { forceMessagePrompt = true } = {}) {
    transientGenerationTarget = {
        messageIndex: Number(messageIndex),
        forceMessagePrompt: forceMessagePrompt !== false,
        createdAt: Date.now(),
    };
    return transientGenerationTarget;
}

function clearTransientGenerationTarget() {
    transientGenerationTarget = null;
}

function getTransientGenerationTarget(ctx = getContext?.()) {
    if (!transientGenerationTarget || typeof transientGenerationTarget !== "object") return null;
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const resolvedIndex = clampChatMessageIndex(transientGenerationTarget.messageIndex, chat.length);
    if (!Number.isInteger(resolvedIndex)) {
        return { ...transientGenerationTarget, messageIndex: null, message: null };
    }
    const message = chat[resolvedIndex];
    if (!message || typeof message !== "object") return null;
    return {
        ...transientGenerationTarget,
        messageIndex: resolvedIndex,
        message,
    };
}

function shouldUseChatMessageScene(settings = getSettings(), ctx = getContext?.()) {
    const target = getTransientGenerationTarget(ctx);
    return !!target?.message || !!settings?.useLastMessage;
}

function resolvePrompt(template, overrides = null) {
    if (template == null) return "";
    const text = typeof template === "string" ? template : String(template);
    const profile = resolveChatProfileContext();
    const resolvedOverrides = overrides && typeof overrides === "object" ? overrides : {};
    const charName = String(resolvedOverrides.charName || profile.charNameJoined || "character");
    const userName = String(resolvedOverrides.userName || profile.userName || "user");
    return text
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName);
}

function getPromptAwareProfileContext(profile, sceneText = "") {
    const sourceProfile = profile || resolveChatProfileContext();
    const userName = String(sourceProfile.userName || "").trim() || "user";
    const baseNames = uniqueStringList(sourceProfile.charNames || []);
    const discoveredNames = uniqueStringList([
        ...extractLikelyCharacterNames(sourceProfile.charDescCombined || ""),
        ...extractLikelyCharacterNames(sourceProfile.charScenarioCombined || ""),
        ...extractLikelyCharacterNames(sourceProfile.charTagsCombined || ""),
        ...extractLikelyCharacterNames(sceneText || ""),
    ])
        .filter(name => normalizeContextLookupValue(name) !== normalizeContextLookupValue(userName))
        .slice(0, 4);
    const nonGenericBaseNames = baseNames.filter(name => !isLikelyGenericCharacterLabel(name));
    const charNames = nonGenericBaseNames.length
        ? uniqueStringList([...nonGenericBaseNames, ...discoveredNames])
        : (discoveredNames.length ? discoveredNames : baseNames);
    const charNameJoined = charNames.length ? charNames.join(", ") : (sourceProfile.charNameJoined || "character");

    return {
        ...sourceProfile,
        userName,
        charNames,
        charNameJoined,
        charDescResolved: resolvePrompt(sourceProfile.charDescCombined || "", { charName: charNameJoined, userName }),
        charScenarioResolved: resolvePrompt(sourceProfile.charScenarioCombined || "", { charName: charNameJoined, userName }),
        charTagsResolved: resolvePrompt(sourceProfile.charTagsCombined || "", { charName: charNameJoined, userName }),
        userDescResolved: resolvePrompt(sourceProfile.userDesc || "", { charName: charNameJoined, userName }),
    };
}

function resolveLLMPromptProfileContext(ctx = getContext(), sceneText = "") {
    const baseProfile = resolveChatProfileContext(ctx);
    const promptAwareProfile = getPromptAwareProfileContext(baseProfile, sceneText);

    if (promptAwareProfile.isGroup || promptAwareProfile.charNames.length > 1) {
        return {
            ...promptAwareProfile,
            usesCurrentCardContext: false,
            useExactNameRequirements: promptAwareProfile.charNames.length > 1,
        };
    }

    const currentEntry = getCurrentCharacterEntry(ctx);
    const currentData = currentEntry?.data || {};
    const userName = String(promptAwareProfile.userName || "").trim() || "user";
    const currentCardName = normalizeScopeLabel(currentEntry?.name || currentEntry?.avatar || ctx?.name2 || "");
    const directCardDesc = truncateForContext(currentData.description, 1500);
    const directCardScenario = truncateForContext(currentData.scenario, 600);
    const directCardTags = getCharacterCardTags(currentData).join(", ");
    const discoveredNames = uniqueStringList([
        ...extractLikelyCharacterNames(directCardDesc),
        ...extractLikelyCharacterNames(directCardScenario),
        ...extractLikelyCharacterNames(directCardTags),
        ...extractLikelyCharacterNames(sceneText || ""),
    ]).filter(name => normalizeContextLookupValue(name) !== normalizeContextLookupValue(userName));
    const preferredCharName = !isLikelyGenericCharacterLabel(currentCardName) && currentCardName
        ? currentCardName
        : (discoveredNames[0] || promptAwareProfile.primaryCharName || currentCardName || "character");
    const charNames = preferredCharName ? [preferredCharName] : [];
    const charNameJoined = preferredCharName || "character";
    const promptOverrides = { charName: charNameJoined, userName };

    return {
        ...promptAwareProfile,
        userName,
        charIds: currentEntry?.id != null ? [String(currentEntry.id)] : promptAwareProfile.charIds,
        charNames,
        charNameJoined,
        primaryCharId: currentEntry?.id != null ? String(currentEntry.id) : promptAwareProfile.primaryCharId,
        primaryCharName: preferredCharName || promptAwareProfile.primaryCharName || "character",
        charDescCombined: directCardDesc,
        charScenarioCombined: directCardScenario,
        charTagsCombined: directCardTags,
        charCards: currentEntry?.data ? [currentEntry.data] : promptAwareProfile.charCards,
        charDescResolved: resolvePrompt(directCardDesc || "", promptOverrides),
        charScenarioResolved: resolvePrompt(directCardScenario || "", promptOverrides),
        charTagsResolved: resolvePrompt(directCardTags || "", promptOverrides),
        userDescResolved: resolvePrompt(promptAwareProfile.userDesc || "", promptOverrides),
        usesCurrentCardContext: true,
        useExactNameRequirements: false,
    };
}

function expandWildcards(text) {
    return text.replace(/\{([^{}]+)\}/g, (match, inner) => {
        const options = inner.split('|').map(s => s.trim()).filter(Boolean);
        if (options.length === 0) return match;
        return options[Math.floor(Math.random() * options.length)];
    });
}

let _stStyleLogged = false;
function getSTStyleSettings() {
    const result = { prefix: "", negative: "", charPositive: "", charNegative: "" };
    try {
        const sd = extension_settings?.sd || extension_settings?.["stable-diffusion"];
        if (!sd) return result;
        if (!_stStyleLogged) {
            log("ST Style: Found SD extension settings, keys: " + Object.keys(sd).filter(k => typeof sd[k] === "string" && sd[k]).join(", "));
            _stStyleLogged = true;
        }
        // Common prefix/negative from ST's style settings
        if (sd.prompt_prefix) result.prefix = sd.prompt_prefix.trim();
        if (sd.negative_prompt) result.negative = sd.negative_prompt.trim();
        // Character-specific overrides
        const ctx = getContext();
        const charName = ctx?.name2;
        if (charName && sd.character_prompts) {
            const charPrompt = sd.character_prompts[charName];
            if (typeof charPrompt === "string" && charPrompt) {
                result.charPositive = charPrompt.trim();
            } else if (charPrompt && typeof charPrompt === "object") {
                if (charPrompt.positive) result.charPositive = charPrompt.positive.trim();
                if (charPrompt.negative) result.charNegative = charPrompt.negative.trim();
            }
        }
        if (charName && sd.character_negative_prompts) {
            const charNeg = sd.character_negative_prompts[charName];
            if (typeof charNeg === "string" && charNeg) {
                result.charNegative = charNeg.trim();
            }
        }
    } catch (e) {
        log("ST Style: Error reading settings: " + e.message);
    }
    return result;
}

function parseMessageRange(rangeStr, chatLength) {
    if (!chatLength || chatLength === 0) return [];
    const str = String(rangeStr || "-1").trim().toLowerCase();
    const indices = new Set();
    const clamp = (n) => Math.max(0, Math.min(n, chatLength - 1));

    // Handle "lastN" format
    const lastMatch = str.match(/^last(\d+)$/);
    if (lastMatch) {
        const n = parseInt(lastMatch[1]);
        if (!isNaN(n) && n > 0) {
            const start = Math.max(0, chatLength - n);
            for (let i = start; i < chatLength; i++) indices.add(i);
        }
        return [...indices].sort((a, b) => a - b);
    }

    // Split by comma and process each part
    const parts = str.split(",");
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === "") continue;

        // Check for range (e.g. "3-7")
        const rangeMatch = trimmed.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
        if (rangeMatch) {
            let a = parseInt(rangeMatch[1]);
            let b = parseInt(rangeMatch[2]);
            if (isNaN(a) || isNaN(b)) continue;
            // Resolve -1 as last
            if (a === -1) a = chatLength - 1;
            if (b === -1) b = chatLength - 1;
            // Swap if reversed
            if (a > b) { const tmp = a; a = b; b = tmp; }
            a = clamp(a);
            b = clamp(b);
            for (let i = a; i <= b; i++) indices.add(i);
        } else {
            // Single number
            let n = parseInt(trimmed);
            if (isNaN(n)) continue;
            if (n === -1) n = chatLength - 1;
            indices.add(clamp(n));
        }
    }

    return [...indices].sort((a, b) => a - b);
}

function getSceneMessageEntries(settings = getSettings(), ctx = getContext?.()) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return [];

    const target = getTransientGenerationTarget(ctx);
    if (target?.message) {
        return [{ index: target.messageIndex, message: target.message, targeted: true }];
    }

    const indices = parseMessageRange(settings?.messageRange, chat.length);
    return indices
        .map(index => ({ index, message: chat[index], targeted: false }))
        .filter(entry => entry.message && typeof entry.message === "object");
}

function getMessages(settings = getSettings(), ctx = getContext?.(), options = {}) {
    const entries = getSceneMessageEntries(settings, ctx);
    if (!entries.length) return "";
    return buildSceneMessageContext(entries, ctx, options).text;
}

function getSelectedSceneMessages(settings = getSettings(), ctx = getContext()) {
    return getSceneMessageEntries(settings, ctx);
}

function resolveManualInsertFallbackIndex(chat, settings = getSettings()) {
    if (!Array.isArray(chat) || !chat.length) return null;

    const fallbackCandidates = chat.map((_, index) => index);
    if (!fallbackCandidates.length) return null;

    const findLastCandidate = (predicate) => {
        for (let i = fallbackCandidates.length - 1; i >= 0; i--) {
            const index = fallbackCandidates[i];
            if (predicate(chat[index], index)) return index;
        }
        return null;
    };

    const targetMode = normalizeManualInsertTarget(settings?.manualInsertTarget);
    if (targetMode === "user") {
        const lastUserIdx = findLastCandidate((message) => !!message?.is_user);
        if (Number.isInteger(lastUserIdx)) return lastUserIdx;
    } else if (targetMode === "latest") {
        return fallbackCandidates[fallbackCandidates.length - 1];
    } else {
        const lastAssistantIdx = findLastCandidate((message) => !message?.is_user);
        if (Number.isInteger(lastAssistantIdx)) return lastAssistantIdx;
    }

    return fallbackCandidates[fallbackCandidates.length - 1];
}

function extractMessageAttachedImageRefs(message) {
    const refs = [];
    const seen = new Set();
    const addRef = (value, label) => {
        const url = String(value || "").trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        refs.push({ url, label });
    };

    const mediaItems = Array.isArray(message?.extra?.media) ? message.extra.media : [];
    mediaItems.forEach((item, index) => {
        const mediaType = String(item?.type || item?.media_type || "").trim().toLowerCase();
        if (mediaType && !mediaType.startsWith("image")) return;
        addRef(item?.url ?? item?.image ?? item?.src ?? item?.path ?? item?.sourceUrl, `extra.media[${index}]`);
    });

    addRef(message?.extra?.image, "extra.image");
    return refs;
}

async function collectChatContextProxyRefImages(settings = getSettings(), ctx = getContext()) {
    if (settings?.provider !== "proxy" || !shouldUseChatMessageScene(settings, ctx)) return [];

    const selectedMessages = getSelectedSceneMessages(settings, ctx);
    if (!selectedMessages.length) return [];

    const refImages = [];
    const seen = new Set();
    let sourceMessageCount = 0;
    let discoveredImageCount = 0;

    for (const entry of selectedMessages) {
        const imageRefs = extractMessageAttachedImageRefs(entry.message);
        if (!imageRefs.length) continue;
        sourceMessageCount++;
        discoveredImageCount += imageRefs.length;

        for (const imageRef of imageRefs) {
            const normalized = await normalizeAutoProxyRefUrl(imageRef.url, {
                messageIndex: entry.index,
                sourceLabel: imageRef.label,
            });
            const value = String(normalized || "").trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            refImages.push(value);
        }
    }

    if (refImages.length > 0) {
        log(`Auto chat refs: Using ${refImages.length} image(s) from ${sourceMessageCount} selected message(s)`);
    } else if (discoveredImageCount > 0) {
        log("Auto chat refs: Found attached message images, but none could be normalized for proxy use");
    }

    return refImages;
}

const styleCache = new Map();

function applyStyle(prompt, s) {
    if (!s.style || s.style === "none") return prompt;

    const cacheKey = `${s.style}|${prompt}`;
    if (styleCache.has(cacheKey)) return styleCache.get(cacheKey);

    const style = STYLES[s.style];
    if (!style) return prompt;

    const result = style.prefix + prompt + style.suffix;

    styleCache.set(cacheKey, result);
    if (styleCache.size > 100) styleCache.delete(styleCache.keys().next().value);

    return result;
}

function clearStyleCache() {
    styleCache.clear();
    log("Style cache cleared");
}

function isContextualFilterInCurrentContext(filter, { activeCardKeys = new Set(getActiveCardScopeKeys()), activeCharIds = new Set(getActiveCharacterScopeIds()) } = {}) {
    const scopeInfo = getScopedRecordFromEntity(filter);
    if (scopeInfo.scope === FILTER_SCOPE_CARD) {
        return !!scopeInfo.cardKey && activeCardKeys.has(scopeInfo.cardKey);
    }
    if (scopeInfo.scope === FILTER_SCOPE_CHAR) {
        return !!scopeInfo.charId && activeCharIds.has(String(scopeInfo.charId));
    }
    return true;
}

function getActiveFilters() {
    ensureFilterPoolsState();
    const activeCardKeys = new Set(getActiveCardScopeKeys());
    const activeCharIds = new Set(getActiveCharacterScopeIds());
    const enabledPoolIds = getEnabledPoolIdsForCurrentContext();
    return contextualFilters.filter(f => {
        if (!f || typeof f !== "object") return false;
        if (!isContextualFilterInCurrentContext(f, { activeCardKeys, activeCharIds })) return false;
        const poolIds = normalizePoolIdList(f.poolIds);
        if (!poolIds.length) return enabledPoolIds.has(DEFAULT_FILTER_POOL_ID);
        return poolIds.some(id => enabledPoolIds.has(id));
    }).sort(compareContextualFilters);
}

function splitPromptTokens(text) {
    return String(text || "")
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
}

function previewTextForLog(text, maxLen = 90) {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    if (compact.length <= maxLen) return compact;
    return `${compact.slice(0, Math.max(0, maxLen - 3))}...`;
}

function previewTokenListForLog(tokens, maxItems = 3) {
    const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    if (!list.length) return "";
    const shown = list.slice(0, maxItems).map(t => previewTextForLog(t, 36));
    if (list.length > maxItems) shown.push(`+${list.length - maxItems} more`);
    return shown.join(" | ");
}

function getPromptTokenIdentity(token) {
    const normalized = String(token || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) return "";
    // Match LoRA tags by name only so <lora:foo:0.6> removes <lora:foo:1.0>.
    const loraMatch = normalized.match(/^<\s*lora\s*:\s*([^:>]+?)\s*(?::\s*[^>]+)?\s*>$/i);
    if (loraMatch) return `lora:${loraMatch[1].trim()}`;
    return `text:${normalized}`;
}

function appendPromptText(base, addition) {
    const add = String(addition || "").trim();
    if (!add) return String(base || "");
    return base ? `${base}, ${add}` : add;
}

function removeTokensFromPromptText(text, removalList) {
    const removals = new Set(
        splitPromptTokens(removalList)
            .map(getPromptTokenIdentity)
            .filter(Boolean)
    );
    const sourceTokens = splitPromptTokens(text);
    if (!removals.size || !sourceTokens.length) {
        return { text: String(text || ""), removedTokens: [] };
    }
    const kept = [];
    const removed = [];
    for (const token of sourceTokens) {
        const identity = getPromptTokenIdentity(token);
        if (identity && removals.has(identity)) {
            removed.push(token);
        } else {
            kept.push(token);
        }
    }
    return { text: kept.join(", "), removedTokens: removed };
}

function applyFilterRemovals(prompt, negative, filter) {
    const mode = filter?.removeMode || "remove";
    const removedFromPrompt = removeTokensFromPromptText(prompt, filter?.removePositive);
    const removedFromNegative = removeTokensFromPromptText(negative, filter?.removeNegative);
    let nextNegative = removedFromNegative.text;
    if (mode === "moveToNegative" && removedFromPrompt.removedTokens.length) {
        nextNegative = appendPromptText(nextNegative, removedFromPrompt.removedTokens.join(", "));
    }
    return {
        prompt: removedFromPrompt.text,
        negative: nextNegative,
        removedPositiveTokens: removedFromPrompt.removedTokens,
        removedNegativeTokens: removedFromNegative.removedTokens,
        removedCount: removedFromPrompt.removedTokens.length + removedFromNegative.removedTokens.length,
    };
}

function applyMatchedFiltersWithDebug(prompt, negative, filters, labelPrefix = "Contextual filter") {
    let p = prompt;
    let n = negative;
    let removedCount = 0;
    for (const f of (filters || [])) {
        const beforeP = p;
        const beforeN = n;
        const removed = applyFilterRemovals(p, n, f);
        p = removed.prompt;
        n = removed.negative;
        removedCount += removed.removedCount;
        if (f.positive) p = appendPromptText(p, f.positive);
        if (f.negative) n = appendPromptText(n, f.negative);
        const deltas = [];
        const removedPositivePreview = previewTokenListForLog(removed.removedPositiveTokens);
        const removedNegativePreview = previewTokenListForLog(removed.removedNegativeTokens);
        if (removedPositivePreview) deltas.push(`-P[${removedPositivePreview}]`);
        if (removedNegativePreview) deltas.push(`-N[${removedNegativePreview}]`);
        if (f.positive) deltas.push(`+P[${previewTextForLog(f.positive, 60)}]`);
        if (f.negative) deltas.push(`+N[${previewTextForLog(f.negative, 60)}]`);
        const changed = beforeP !== p || beforeN !== n;
        log(`${labelPrefix} "${f.name || "(unnamed)"}" p${f.priority || 0}: ${deltas.join(" ") || "no-op"}${changed ? ` => P:${previewTextForLog(p)} | N:${previewTextForLog(n)}` : ""}`);
    }
    return { prompt: p, negative: n, removedCount };
}

function selectContextualSeedOverride(filters = []) {
    let selected = null;
    for (const filter of (filters || [])) {
        const seedOverride = normalizeSeedOverride(filter?.seedOverride);
        if (seedOverride == null) continue;
        const priority = Number.isFinite(Number(filter?.priority)) ? Number(filter.priority) : 0;
        if (!selected || priority > selected.priority) {
            selected = {
                seedOverride,
                priority,
                name: filter?.name || "(unnamed)",
            };
        }
    }
    if (selected) {
        log(`Contextual seed override: ${selected.seedOverride} from "${selected.name}" p${selected.priority}`);
    }
    return selected;
}

function applyContextualFilters(prompt, negative, sceneText) {
    const activeFilters = getActiveFilters();
    if (!activeFilters.length || !sceneText) return { prompt, negative, matchedFilters: [] };
    const activeCardKeys = new Set(getActiveCardScopeKeys());
    const activeCharIds = new Set(getActiveCharacterScopeIds());
    const scopedFilterCount = contextualFilters.filter(f => isContextualFilterInCurrentContext(f, { activeCardKeys, activeCharIds })).length;
    if (scopedFilterCount > activeFilters.length) {
        log(`Contextual pools: ${activeFilters.length}/${scopedFilterCount} scoped filter(s) enabled by active pools`);
    }
    const sceneForMatching = enrichSceneTextForFilters(sceneText, "Contextual filters");
    const scene = sceneForMatching.toLowerCase();
    const matched = [];
    for (const f of activeFilters) {
        if (!f.enabled) continue;
        if (f.matchMode === "LLM") continue;
        const resolvedFilter = resolveContextualFilter(f);
        const keywords = resolvedFilter.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
        if (!keywords.length) continue;
        const hit = resolvedFilter.matchMode === "AND"
            ? keywords.every(kw => scene.includes(kw))
            : keywords.some(kw => scene.includes(kw));
        if (hit) matched.push({ ...resolvedFilter, _keywords: new Set(keywords) });
    }
    if (!matched.length) return { prompt, negative, matchedFilters: [] };
    matched.sort(compareContextualFilters);
    // Suppress OR filters whose keywords are a subset of a higher-priority AND filter
    const andFilters = matched.filter(f => f.matchMode === "AND");
    const surviving = matched.filter(f => {
        if (f.matchMode === "AND") return true;
        return !andFilters.some(af =>
            (af.priority || 0) >= (f.priority || 0) &&
            [...f._keywords].every(kw => af._keywords.has(kw))
        );
    });
    const applied = applyMatchedFiltersWithDebug(prompt, negative, surviving, "Contextual filter");
    log(`Contextual filters: ${surviving.length} applied (${matched.length - surviving.length} suppressed, ${applied.removedCount} token(s) removed)`);
    return { prompt: applied.prompt, negative: applied.negative, matchedFilters: surviving };
}

async function applyResolvedContextualFilters(prompt, negative, {
    matchText,
    llmSceneText,
    signal = null,
} = {}) {
    const applied = applyContextualFilters(prompt, negative, matchText);
    let nextPrompt = applied.prompt;
    let nextNegative = applied.negative;
    const matchedFilters = [...(applied.matchedFilters || [])];

    const llmMatched = await matchLLMFilters(llmSceneText || matchText, signal);
    if (llmMatched.length) {
        const llmApplied = applyMatchedFiltersWithDebug(nextPrompt, nextNegative, llmMatched, "LLM contextual filter");
        nextPrompt = llmApplied.prompt;
        nextNegative = llmApplied.negative;
        matchedFilters.push(...llmMatched);
        log(`LLM contextual filters: ${llmMatched.length} applied (${llmApplied.removedCount} token(s) removed)`);
    }

    const selectedSeed = selectContextualSeedOverride(matchedFilters);
    return {
        prompt: nextPrompt,
        negative: nextNegative,
        matchedFilters,
        seedOverride: selectedSeed?.seedOverride ?? null,
    };
}

function getBatchBaseSeed(settings, batchCount, seedOverride = null) {
    let baseSeed = seedOverride != null ? seedOverride : getGenerationSeedValue(settings);
    if (settings?.sequentialSeeds && batchCount > 1 && baseSeed === -1) {
        baseSeed = generateRandomSeed();
    }
    return baseSeed;
}

async function matchLLMFilters(sceneText, signal = null) {
    const llmFilters = getActiveFilters()
        .filter(f => f.enabled && f.matchMode === "LLM" && f.description)
        .map(resolveContextualFilter)
        .filter(f => f.description);
    if (!llmFilters.length || !sceneText) return [];
    const sceneForMatching = enrichSceneTextForFilters(sceneText, "LLM filters");

    const conceptList = llmFilters.map((f, i) => `${i + 1}. "${f.name || "(unnamed)"}": ${f.description}`).join('\n');
    log(`LLM filter matching concepts: ${previewTextForLog(conceptList, 180)}`);

    const instruction = `Given the following scene, identify which concepts are present.
Reply ONLY with the numbers of matching concepts, comma-separated. If none match, reply "none".

Scene:
${sceneForMatching.substring(0, 2000)}

Concepts:
${conceptList}`;

    const s = getSettings();
    let response;
    try {
        if (s.llmOverrideEnabled && s.llmOverrideProfileId) {
            response = await callOverrideLLM(instruction, "You are a scene analyst. Reply only with numbers.", signal);
        } else {
            response = await callInternalQuietPrompt(instruction, {
                signal,
                quietName: `FilterMatch_${Date.now()}`,
                label: "LLM filter matching request",
            });
        }
        checkAborted();
    } catch (e) {
        if (e.name === "AbortError") throw e; // Let cancellation propagate
        log(`LLM filter matching failed: ${e.message}`);
        return [];
    }

    const nums = (response || "").match(/\d+/g)?.map(Number) || [];
    const matched = llmFilters.filter((_, i) => nums.includes(i + 1)).sort(compareContextualFilters);
    log(`LLM filter matching: ${matched.length}/${llmFilters.length} concepts matched`);
    return matched;
}

const skinPattern = /\b(dark[- ]?skin(?:ned)?|brown[- ]?skin(?:ned)?|black[- ]?skin(?:ned)?|tan(?:ned)?[- ]?skin|ebony|melanin|mocha|chocolate[- ]?skin|caramel[- ]?skin)\b/gi;

function summarizeLLMValueShape(value, depth = 0) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return "string";
    if (typeof value !== "object") return typeof value;
    if (Array.isArray(value)) {
        if (depth >= 1) return `array(${value.length})`;
        const parts = value.slice(0, 3).map(item => summarizeLLMValueShape(item, depth + 1));
        return `array(${value.length})[${parts.join(", ")}${value.length > 3 ? ", ..." : ""}]`;
    }

    const keys = Object.keys(value);
    if (depth >= 1) {
        return `object{${keys.slice(0, 4).join(",")}${keys.length > 4 ? ",..." : ""}}`;
    }

    const summary = keys.slice(0, 4)
        .map(key => `${key}:${summarizeLLMValueShape(value[key], depth + 1)}`)
        .join(", ");
    return `object{${summary}${keys.length > 4 ? ", ..." : ""}}`;
}

function appendLLMTextSegments(value, segments, visited = new WeakSet()) {
    if (typeof value === "string") {
        segments.push(value);
        return true;
    }
    if (value == null || typeof value !== "object") return false;
    if (visited.has(value)) return false;
    visited.add(value);

    if (Array.isArray(value)) {
        let found = false;
        for (const item of value) {
            found = appendLLMTextSegments(item, segments, visited) || found;
        }
        return found;
    }

    let found = false;
    const pushString = (candidate) => {
        if (typeof candidate !== "string") return false;
        segments.push(candidate);
        found = true;
        return true;
    };

    if (pushString(value.output_text)) return true;
    if (pushString(value.text)) return true;
    if (/text/i.test(String(value.type || "")) && pushString(value.value)) return true;
    if (pushString(value.content)) return true;

    const nestedCandidates = [value.text, value.content, value.parts, value.output, value.data, value.message, value.value];
    for (const candidate of nestedCandidates) {
        if (candidate == null || candidate === value) continue;
        found = appendLLMTextSegments(candidate, segments, visited) || found;
    }

    return found;
}

function extractLLMResponseDetails(response) {
    if (typeof response === "string") {
        return {
            text: response,
            sourcePath: "response",
            extractionStatus: response ? "text" : "empty_string",
            finishReason: null,
            responseShape: "string",
            contentShape: "string",
        };
    }

    const finishReason = response?.choices?.[0]?.finish_reason ?? response?.finish_reason ?? response?.response?.finish_reason ?? null;
    const responseShape = summarizeLLMValueShape(response);
    if (!response || typeof response !== "object") {
        return {
            text: "",
            sourcePath: "",
            extractionStatus: response == null ? "null_content" : "unsupported_shape",
            finishReason,
            responseShape,
            contentShape: "",
        };
    }

    const candidates = [
        { label: "content", value: response.content },
        { label: "choices[0].message.content", value: response.choices?.[0]?.message?.content },
        { label: "choices[0].message.tool_plan", value: response.choices?.[0]?.message?.tool_plan },
        { label: "choices[0].text", value: response.choices?.[0]?.text },
        { label: "message.content", value: response.message?.content },
        { label: "message.tool_plan", value: response.message?.tool_plan },
        { label: "responseContent.parts", value: response.responseContent?.parts },
        { label: "candidates[0].content.parts", value: response.candidates?.[0]?.content?.parts },
        { label: "candidates[0].content", value: response.candidates?.[0]?.content },
        { label: "text", value: response.text },
        { label: "response", value: response.response },
        { label: "[0].content", value: response?.[0]?.content },
        { label: "output_text", value: response.output_text },
        { label: "output[0].content", value: response.output?.[0]?.content },
        { label: "output", value: response.output },
    ];

    let sawNullContent = false;
    let sawStructuredContent = false;
    let sawCandidate = false;
    let firstCandidateLabel = "";
    let firstCandidateShape = "";

    for (const candidate of candidates) {
        if (candidate.value === undefined) continue;
        sawCandidate = true;
        if (!firstCandidateLabel) firstCandidateLabel = candidate.label;
        if (!firstCandidateShape) firstCandidateShape = summarizeLLMValueShape(candidate.value);

        if (candidate.value === null) {
            sawNullContent = true;
            continue;
        }

        if (Array.isArray(candidate.value) || (candidate.value && typeof candidate.value === "object")) {
            sawStructuredContent = true;
        }

        const segments = [];
        const foundText = appendLLMTextSegments(candidate.value, segments);
        const extractedText = segments.join("");
        if (foundText && extractedText.trim()) {
            return {
                text: extractedText,
                sourcePath: candidate.label,
                extractionStatus: Array.isArray(candidate.value) || typeof candidate.value === "object" ? "structured_text" : "text",
                finishReason,
                responseShape,
                contentShape: summarizeLLMValueShape(candidate.value),
            };
        }
    }

    return {
        text: "",
        sourcePath: firstCandidateLabel,
        extractionStatus: sawNullContent
            ? "null_content"
            : (sawStructuredContent ? "no_text_parts" : (sawCandidate ? "empty_string" : "unsupported_shape")),
        finishReason,
        responseShape,
        contentShape: firstCandidateShape,
    };
}

function getLLMHelperRouteDescription(route) {
    switch (route) {
        case "llm_override":
            return "LLM Override";
        case "override_unavailable_main_chat":
            return "main chat AI fallback (override unavailable)";
        case "override_failed_main_chat":
            return "main chat AI fallback (override failed)";
        case "main_chat_ai":
        default:
            return "main chat AI";
    }
}

function logLLMHelperResponseMeta(meta, label = "LLM helper") {
    if (!meta || typeof meta !== "object") return;
    const parts = [`route=${getLLMHelperRouteDescription(meta.route)}`];
    if (meta.sourcePath) parts.push(`source=${meta.sourcePath}`);
    if (meta.requestMethod) parts.push(`method=${meta.requestMethod}`);
    if (meta.extractionStatus) parts.push(`extraction=${meta.extractionStatus}`);
    if (meta.finishReason) parts.push(`finish_reason=${meta.finishReason}`);
    if (Number.isFinite(meta.requestedMaxTokens)) parts.push(`max_tokens=${meta.requestedMaxTokens}`);
    if (meta.responseShape) parts.push(`shape=${meta.responseShape}`);
    log(`${label}: ${parts.join(", ")}`);
}

function buildLLMEmptyPromptWarning(meta, rawText, cleanedText) {
    const routeLabel = getLLMHelperRouteDescription(meta?.route);
    if (meta?.finishReason === "length") {
        return `${routeLabel} hit finish_reason=length — using raw prompt. Consider raising max tokens.`;
    }

    switch (meta?.extractionStatus) {
        case "null_content":
            return `${routeLabel} returned empty/null content — using raw prompt.`;
        case "no_text_parts":
            return `${routeLabel} returned structured content with no text parts — using raw prompt.`;
        case "unsupported_shape":
            return `${routeLabel} returned an unsupported response shape — using raw prompt.`;
        default:
            if (rawText && !String(cleanedText || "").trim()) {
                return `${routeLabel} returned no usable text after cleanup — using raw prompt.`;
            }
            return `${routeLabel} returned no text — using raw prompt.`;
    }
}

function extractLLMResponse(response) {
    return extractLLMResponseDetails(response).text;
}

function findSecretKeyForId(secretId) {
    if (!secret_state) return null;
    for (const [key, secrets] of Object.entries(secret_state)) {
        if (Array.isArray(secrets) && secrets.some(s => s.id === secretId)) {
            return key;
        }
    }
    return null;
}

async function callOverrideLLM(instruction, systemPrompt = "", signal = null, { assistantPrefill = "", returnMeta = false } = {}) {
    const s = getSettings();
    const requestedMaxTokens = s.llmOverrideMaxTokens || 500;
    let CMRS = null;
    try {
        const ctx = getContext();
        CMRS = ctx.ConnectionManagerRequestService;
    } catch { /* pre-1.15.0 */ }

    if (!CMRS || !s.llmOverrideProfileId) {
        // Fallback: use main chat AI via generateQuietPrompt
        log("LLM Override: No Connection Manager or profile, falling back to main AI");
        const fallbackOptions = {
            signal,
            quietName: `ImageGen_${Date.now()}`,
            label: "LLM override fallback request",
            prefill: assistantPrefill,
        };
        const fallbackText = assistantPrefill
            ? await callInternalStandaloneLLM(instruction, fallbackOptions)
            : await callInternalQuietPrompt(instruction, fallbackOptions);
        const fallbackMeta = {
            text: fallbackText,
            route: "override_unavailable_main_chat",
            sourcePath: "response",
            extractionStatus: fallbackText ? "text" : "empty_string",
            finishReason: null,
            requestedMaxTokens,
            responseShape: summarizeLLMValueShape(fallbackText),
            contentShape: summarizeLLMValueShape(fallbackText),
        };
        return returnMeta ? fallbackMeta : fallbackText;
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: instruction });
    if (assistantPrefill) messages.push({ role: "assistant", content: assistantPrefill });

    const requestedPreset = s.llmOverridePreset || "";
    log(`LLM Override: Using connection profile '${s.llmOverrideProfileId}' (preset: ${requestedPreset || "profile default"})`);

    // Rotate to the profile's secret if it has one
    let previousSecretId = null;
    let secretKey = null;
    let profile = null;
    let originalProfilePreset;
    let presetOverridden = false;
    try {
        profile = CMRS.getProfile(s.llmOverrideProfileId);

        // Apply selected preset for this request only, then restore it.
        if (profile && requestedPreset && profile.preset !== requestedPreset) {
            originalProfilePreset = profile.preset;
            profile.preset = requestedPreset;
            presetOverridden = true;
        }

        const profileSecretId = profile?.['secret-id'];
        if (profileSecretId && rotateSecret && secret_state) {
            secretKey = findSecretKeyForId(profileSecretId);
            if (secretKey) {
                previousSecretId = secret_state[secretKey]?.find(sec => sec.active)?.id;
                if (previousSecretId !== profileSecretId) {
                    log(`LLM Override: Rotating secret for '${secretKey}' to profile's key`);
                    await rotateSecret(secretKey, profileSecretId);
                } else {
                    previousSecretId = null; // already correct, no restore needed
                }
            }
        }
    } catch (e) {
        log(`LLM Override: Could not prepare profile override: ${e.message}`);
    }

    try {
        const response = await runWithInternalLLMRequest("LLM override profile request", async () => await runAbortableTask(() => CMRS.sendRequest(
            s.llmOverrideProfileId,
            messages,
            requestedMaxTokens,
            { extractData: true, includePreset: true, stream: false }
        ), signal));
        const details = extractLLMResponseDetails(response);
        const meta = {
            ...details,
            route: "llm_override",
            requestedMaxTokens,
            profileId: s.llmOverrideProfileId,
        };
        if (!details.text) {
            logLLMHelperResponseMeta(meta, "LLM Override response");
        }
        return returnMeta ? meta : details.text;
    } catch (e) {
        if (e.name === "AbortError") throw e;
        log(`LLM Override failed (profile: ${s.llmOverrideProfileId}): ${e.message}`);
        log("Falling back to main chat AI. Check your Connection Manager profile's API type, endpoint, and API key.");
        const recoveryOptions = {
            signal,
            quietName: `ImageGen_${Date.now()}`,
            label: "LLM override recovery request",
            prefill: assistantPrefill,
        };
        const fallbackText = assistantPrefill
            ? await callInternalStandaloneLLM(instruction, recoveryOptions)
            : await callInternalQuietPrompt(instruction, recoveryOptions);
        const fallbackMeta = {
            text: fallbackText,
            route: "override_failed_main_chat",
            sourcePath: "response",
            extractionStatus: fallbackText ? "text" : "empty_string",
            finishReason: null,
            requestedMaxTokens,
            responseShape: summarizeLLMValueShape(fallbackText),
            contentShape: summarizeLLMValueShape(fallbackText),
            error: e.message,
            profileId: s.llmOverrideProfileId,
        };
        return returnMeta ? fallbackMeta : fallbackText;
    } finally {
        // Restore original secret
        if (previousSecretId && secretKey && rotateSecret) {
            try {
                log(`LLM Override: Restoring original secret for '${secretKey}'`);
                await rotateSecret(secretKey, previousSecretId);
            } catch (e) {
                log(`LLM Override: Could not restore secret: ${e.message}`);
            }
        }

        // Restore profile preset if we overrode it for this call.
        if (presetOverridden && profile) {
            profile.preset = originalProfilePreset;
        }
    }
}

function populateConnectionProfiles(selectId, selectedId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="">-- Use main chat AI --</option>';
    try {
        const ctx = getContext();
        const CMRS = ctx.ConnectionManagerRequestService;
        if (!CMRS) {
            select.innerHTML += '<option value="" disabled>Requires SillyTavern 1.15.0+</option>';
            return;
        }
        const profiles = CMRS.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name || p.id;
            if (p.id === selectedId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch (e) {
        log(`Failed to load connection profiles: ${e.message}`);
        select.innerHTML += '<option value="" disabled>Error loading profiles</option>';
    }
}

async function populatePresetList(selectId, selectedPreset) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="">-- Default (from profile) --</option>';
    try {
        const ctx = getContext();
        const presetManager = ctx.getPresetManager?.();
        if (!presetManager) return;
        const presets = presetManager.getAllPresets?.() || [];
        for (const name of presets) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            if (name === selectedPreset) opt.selected = true;
            select.appendChild(opt);
        }
    } catch (e) {
        log(`Failed to load presets: ${e.message}`);
    }
}

function getResolvedLLMPrefill(settings = getSettings()) {
    const profile = resolveLLMPromptProfileContext(getContext());
    return resolvePrompt(settings?.llmPrefill ?? "", {
        charName: profile.charNameJoined,
        userName: profile.userName,
    });
}

function promptIncludesName(text, name) {
    const haystack = String(text || "").toLowerCase();
    const needle = String(name || "").trim().toLowerCase();
    return !!needle && haystack.includes(needle);
}

function shouldStripPrefillFromLLMResult(prefill, profile) {
    const trimmedPrefill = String(prefill || "").trim();
    if (!trimmedPrefill) return false;
    const protectedNames = uniqueStringList([...(profile?.charNames || []), profile?.userName].filter(Boolean));
    if (protectedNames.some(name => promptIncludesName(trimmedPrefill, name))) {
        return false;
    }
    return /(^|\b)(image prompt|prompt|tags?|description|answer)\b/i.test(trimmedPrefill) || /[:>\-\]]\s*$/.test(trimmedPrefill);
}

function mergeMeaningfulPrefillIntoLLMResult(result, prefill, profile) {
    const baseResult = String(result || "").trim();
    const rawPrefill = String(prefill || "");
    const trimmedPrefill = rawPrefill.trim();
    if (!baseResult || !trimmedPrefill) return baseResult;
    if (shouldStripPrefillFromLLMResult(rawPrefill, profile)) return baseResult;
    const activeNames = uniqueStringList(profile?.charNames || []);
    if (!activeNames.length) return baseResult;
    if (activeNames.some(name => promptIncludesName(baseResult, name))) return baseResult;
    if (!activeNames.some(name => promptIncludesName(trimmedPrefill, name))) return baseResult;
    const joiner = /[\s(,:-]$/.test(rawPrefill) ? "" : ", ";
    return `${rawPrefill}${joiner}${baseResult}`.trim();
}

function cleanSceneDescriptionText(text) {
    let cleaned = String(text || "").trim();
    cleaned = cleaned.replace(/\[\d+\]\s*/g, "");
    cleaned = cleaned.replace(/\{\{\d+_[a-z0-9]+\}\}/gi, "");
    cleaned = cleaned.replace(/\[ref:[a-z0-9]+\]/gi, "");
    cleaned = cleaned.replace(/^\s*(?:plain\s+)?(?:visual\s+)?(?:description|summary)\s*:\s*/i, "");
    cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, "").trim();
    return cleaned;
}

async function generateSceneDescription(s, sceneText, signal, options = {}) {
    const selectedScene = String(sceneText || "").trim();
    if (!selectedScene) return "";

    checkAborted();
    log("Generating plain scene description via SillyTavern LLM...");
    showStatus("🤖 Summarizing scene for image prompt...");

    try {
        const ctx = getContext();
        const profile = resolveLLMPromptProfileContext(ctx, selectedScene);
        const charName = profile.charNameJoined || "character";
        const userName = profile.userName || "user";
        const charDesc = profile.charDescResolved || "";
        const userPersona = profile.userDescResolved || "";
        const scenario = profile.charScenarioResolved || "";
        const tags = profile.charTagsResolved || "";
        const activeCharacterNames = uniqueStringList(profile.charNames || []);
        const activeCharacterList = activeCharacterNames.join(", ");
        const forcedMultiMessage = options?.isMultiMessageScene;
        const isMultiMessage = forcedMultiMessage === true
            ? true
            : (forcedMultiMessage === false ? false : isSceneTranscriptPrompt(selectedScene));

        const referenceSections = [];
        if (charDesc) referenceSections.push(`${charName}'s appearance/profile: ${charDesc.substring(0, 1500)}`);
        if (userPersona) referenceSections.push(`${userName}'s persona/appearance: ${userPersona.substring(0, 800)}`);
        if (tags) referenceSections.push(`Source/Tags: ${tags}`);
        if (scenario) referenceSections.push(`Setting: ${scenario.substring(0, 400)}`);
        if (activeCharacterList) referenceSections.push(`Active character names to preserve when visible: ${activeCharacterList}`);
        const referenceBlock = referenceSections.length ? `\nREFERENCE CONTEXT:\n${referenceSections.join("\n")}` : "";

        const customInstruction = String(s.twoStepInstruction || "").trim();
        let instruction;
        if (customInstruction) {
            instruction = customInstruction
                .replace(/\{\{scene\}\}/gi, selectedScene)
                .replace(/\{\{charDesc\}\}/gi, charDesc.substring(0, 1500))
                .replace(/\{\{userDesc\}\}/gi, userPersona.substring(0, 800))
                .replace(/\{\{char\}\}/gi, charName)
                .replace(/\{\{user\}\}/gi, userName);
            if (!customInstructionHasMacro(customInstruction, "scene")) {
                instruction += `\n\nSELECTED SCENE${isMultiMessage ? " CONTEXT" : ""}:\n${selectedScene}`;
            }
        } else {
            instruction = `[STANDALONE VISUAL SCENE DESCRIPTION TASK]

Convert the selected chat scene into one concise plain-language visual description for an image generator.

Rules:
- Output ONLY the plain description. No commentary, no markdown, no speaker labels, no tags, no bullet list.
- Describe one coherent visible moment: subjects, identities, poses, expressions, clothing, setting, lighting, mood, and camera framing.
- Preserve explicit species, ages, body traits, names, and non-human details from the scene or reference context.
- Do not continue the roleplay and do not quote dialogue.
${isMultiMessage ? "- The selected scene is a multi-message transcript. Infer the best single visual moment from it." : ""}${referenceBlock}

SELECTED SCENE${isMultiMessage ? " CONTEXT" : ""}:
${selectedScene}

Plain visual description:`;
        }

        const timestamp = Date.now();
        const randomPart = Math.random().toString(36).substring(2, 11);
        const entropyInline = `{{${timestamp}_${randomPart}}}`;
        const instructionWithEntropy = `[${timestamp}]\n${instruction}\n\nRequest marker: ${entropyInline}`;

        log(`Sending scene description instruction to LLM (length: ${instructionWithEntropy.length} chars)`);

        let helperResponseMeta;
        let llmDescription;
        if (s.llmOverrideEnabled && s.llmOverrideProfileId) {
            log("Using LLM Override for scene description");
            helperResponseMeta = await callOverrideLLM(instructionWithEntropy, "", signal, { returnMeta: true });
            llmDescription = helperResponseMeta?.text || "";
        } else {
            helperResponseMeta = await callInternalStandaloneLLM(instructionWithEntropy, {
                signal,
                quietName: `ImageGenScene_${timestamp}`,
                label: "scene description request",
                returnMeta: true,
            });
            llmDescription = helperResponseMeta?.text || "";
        }

        checkAborted();
        logLLMHelperResponseMeta(helperResponseMeta, "Scene description helper response");

        const cleaned = cleanSceneDescriptionText(llmDescription);
        if (!cleaned) {
            const warningMessage = buildLLMEmptyPromptWarning(helperResponseMeta, llmDescription, cleaned);
            log(`WARNING: ${warningMessage}`);
            toastr?.warning?.(warningMessage, "Image Gen", { timeOut: 5000 });
            return "";
        }

        log(`Scene description: ${cleaned.substring(0, 200)}${cleaned.length > 200 ? "..." : ""}`);
        return cleaned;
    } catch (e) {
        if (e.name === "AbortError") throw e;
        log(`Scene description failed: ${e.message}`);
        toastr?.warning?.(`Scene description failed: ${e.message}`, "Image Gen", { timeOut: 5000 });
        return "";
    }
}

async function generateLLMPrompt(s, basePrompt, signal, options = {}) {
    if (!s.useLLMPrompt) return basePrompt;

    // Clear any cached styles before generating new prompt
    clearStyleCache();

    checkAborted(); // Bail early if already cancelled

    // Only show status message when actually generating
    log("Generating prompt via SillyTavern LLM...");
    showStatus("🤖 Creating image prompt...");

    try {
        const ctx = getContext();
        const profile = resolveLLMPromptProfileContext(ctx, basePrompt);
        const charName = profile.charNameJoined || "character";
        const userName = profile.userName || "user";
        const charDesc = profile.charDescResolved || "";
        const userPersona = profile.userDescResolved || "";
        const scenario = profile.charScenarioResolved || "";
        const tags = profile.charTagsResolved || "";
        const activeCharacterNames = uniqueStringList(profile.charNames || []);
        const activeCharacterList = activeCharacterNames.join(", ");
        const resolvedPrefill = getResolvedLLMPrefill(s);
        const sceneUsesFirstPersonUser = /\b(i|me|my|mine|myself)\b/i.test(basePrompt);
        const sceneMentionsUserByName = promptIncludesName(basePrompt, userName);
        const sceneMentionedCharacterNames = activeCharacterNames.filter(name => promptIncludesName(basePrompt, name));
        const sceneCentersUserAppearance = /\b(reflection|mirror|mirrored|view(?:ing)?\s+my\s+reflection|look(?:ing)?\s+at\s+myself|my\s+(?:face|body|figure|appearance|skin|eyes|reflection))\b/i.test(basePrompt);
        const sceneIncludesUserPersona = !!userPersona && (sceneUsesFirstPersonUser || sceneMentionsUserByName);
        const shouldDeprioritizeUnmentionedCharacters = sceneIncludesUserPersona && !sceneMentionedCharacterNames.length;
        const userLikelyPrimarySubject = sceneIncludesUserPersona && sceneCentersUserAppearance;

        const skinTones = [];
        const charSkin = charDesc.match(skinPattern);
        const userSkin = userPersona.match(skinPattern);
        if (charSkin) skinTones.push(`${charName}: ${charSkin[0]}`);
        if (userSkin) skinTones.push(`${userName}: ${userSkin[0]}`);

        let appearanceContext = "";
        if (profile.usesCurrentCardContext) {
            if (charDesc) appearanceContext += `${charName}'s appearance: ${charDesc.substring(0, 1500)}\n`;
            if (userPersona) appearanceContext += `${userName}'s appearance: ${userPersona.substring(0, 800)}\n`;
            if (tags) appearanceContext += `Source/Tags: ${tags}\n`;
            if (scenario) appearanceContext += `Setting: ${scenario.substring(0, 400)}\n`;
        } else {
            const appearanceSections = [];
            if (sceneIncludesUserPersona && userPersona) {
                appearanceSections.push(`User persona (${userName}; applies to first-person references like I/me/my): ${userPersona.substring(0, 800)}`);
            }
            if (charDesc) {
                const charProfileLabel = shouldDeprioritizeUnmentionedCharacters
                    ? "Secondary active character profiles (only use if the scene clearly includes them):"
                    : "Character profiles:";
                appearanceSections.push(`${charProfileLabel}\n${charDesc.substring(0, 1500)}`);
            }
            if (!sceneIncludesUserPersona && userPersona) {
                appearanceSections.push(`User persona (${userName}; applies to first-person references like I/me/my): ${userPersona.substring(0, 800)}`);
            }
            if (tags) appearanceSections.push(`Source/Tags: ${tags}`);
            if (scenario) appearanceSections.push(`Setting: ${scenario.substring(0, 400)}`);
            appearanceContext = appearanceSections.join("\n");
            if (appearanceContext) appearanceContext += "\n";
        }

        const skinEnforce = skinTones.length ? `\nCRITICAL - You MUST include these skin tones: ${skinTones.join(", ")}` : "";
        const shouldUseExactNameRequirements = !!profile.useExactNameRequirements && activeCharacterNames.length > 0;
        const exactNameRequirement = shouldUseExactNameRequirements
            ? `\n- Preserve and include these exact character name${activeCharacterNames.length === 1 ? "" : "s"} when the scene/card identifies them${shouldDeprioritizeUnmentionedCharacters ? "; otherwise do not force them into the prompt just because they are the active chat character" : ""}: ${activeCharacterList}`
            : "";
        const exactUserRequirement = userPersona
            ? `\n- If the scene refers to the user in first person or by name, preserve and include the exact user persona name when applicable: ${userName}`
            : "";
        const exactNameBlock = shouldUseExactNameRequirements
            ? `\n${shouldDeprioritizeUnmentionedCharacters ? "ACTIVE CHARACTER NAMES (only use if the scene explicitly includes them):" : "CHARACTER NAMES TO PRESERVE (use these exact spellings when applicable):"} ${activeCharacterList}`
            : "";
        const userNameBlock = userPersona
            ? `\nUSER PERSONA NAME (use when the scene refers to the user / I / me / my): ${userName}`
            : "";
        const identityRequirements = [
            "- Preserve any explicit age, age range, species, creature type, race, or persona/body traits from the scene or profile.",
            "- Do NOT flatten specific identities into generic labels like man, woman, person, human, teen, adult, boy, or girl when more specific information is available.",
            "- If a subject is non-human or from a known fantasy/franchise species, keep that identity in the prompt instead of humanizing it.",
        ];
        if (userPersona) {
            identityRequirements.push(`- If the scene uses first-person references like I/me/my or mentions ${userName}, that subject is the user persona described below. Use that persona's age, species, body type, and nonhuman traits.`);
        }
        const identityRequirementBlock = `\nIDENTITY REQUIREMENTS:\n${identityRequirements.join("\n")}`;
        const subjectPriorityRequirements = [];
        if (sceneIncludesUserPersona) {
            subjectPriorityRequirements.push(`- The user persona (${userName}) is visually involved in this scene whenever the scene uses first-person references or the user name.`);
            subjectPriorityRequirements.push("- Do NOT replace the user persona with a generic human label or with the active chat character's profile.");
            subjectPriorityRequirements.push("- If the user persona is acting in the scene, depict them as a full subject when relevant instead of reducing them to a hand, claw, limb, silhouette, or other partial-body placeholder unless the scene explicitly calls for an off-screen POV framing.");
        }
        if (userLikelyPrimarySubject) {
            subjectPriorityRequirements.push(`- Reflection/self-view scenes should treat the user persona (${userName}) as the primary visual subject and describe their full appearance.`);
        }
        if (shouldDeprioritizeUnmentionedCharacters) {
            subjectPriorityRequirements.push("- Do not center the active chat character or inject their full profile unless the scene clearly includes them.");
        }
        if (sceneIncludesUserPersona && sceneMentionedCharacterNames.length) {
            subjectPriorityRequirements.push(`- If both the user persona and another subject are present, preserve both identities accurately and do not let ${sceneMentionedCharacterNames.join(", ")} overshadow the user persona.`);
        }
        const subjectPriorityBlock = subjectPriorityRequirements.length
            ? `\nSCENE SUBJECT PRIORITY:\n${subjectPriorityRequirements.join("\n")}`
            : "";
        const userSceneRequirementBullet = userPersona
            ? `\n- If the scene refers to the user in first person or by name, use the user persona reference below for that subject (${userName})`
            : "";

        const isNatural = s.llmPromptStyle === "natural";
        const wantsCustom = s.llmPromptStyle === "custom";
        const isCustom = wantsCustom && !!s.llmCustomInstruction?.trim();
        const forcedMultiMessage = options?.isMultiMessageScene;
        const isMultiMessage = forcedMultiMessage === true
            ? true
            : (forcedMultiMessage === false ? false : isSceneTranscriptPrompt(basePrompt));
        const multiMessageContextBlock = isMultiMessage
            ? `\nMULTI-MESSAGE SCENE CONTEXT:\n- The selected scene below is speaker-tagged context from the chosen chat messages.\n- Use it to infer one coherent visual moment.\n- Do NOT copy speaker labels, quote dialogue, or echo transcript lines in the output.\n- Convert the exchange into visual details only: subjects, actions, expressions, setting, camera framing, lighting, and mood.`
            : "";

        log(`LLM scene mode: ${isMultiMessage ? "multi-message transcript" : "single-message scene"} (${basePrompt.length} chars)`);

        let instruction;
        if (isCustom) {
            log(`Custom macros: scene=${basePrompt.length}ch, char="${charName}", user="${userName}", charDesc=${charDesc.length}ch, userDesc=${userPersona.length}ch`);
            log(`Using custom instruction: ${s.llmCustomInstruction.substring(0, 100)}...`);
            instruction = s.llmCustomInstruction
                .replace(/\{\{scene\}\}/gi, basePrompt)
                .replace(/\{\{charDesc\}\}/gi, charDesc.substring(0, 1500))
                .replace(/\{\{userDesc\}\}/gi, userPersona.substring(0, 800))
                .replace(/\{\{char\}\}/gi, charName)
                .replace(/\{\{user\}\}/gi, userName);

            // Add enhancement options to custom instruction
            let customEnhancements = "";
            if (s.llmAddQuality) customEnhancements += "\n- Include quality tags (masterpiece, best quality, highly detailed, sharp focus, etc.)";
            if (s.llmAddLighting) customEnhancements += "\n- Include lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)";
            if (s.llmAddArtist) {
                const randomArtist = getRandomArtist(true);
                customEnhancements += `\n- Include artist tags (e.g., ${randomArtist}, etc.)`;
            }
            if (customEnhancements) {
                instruction += `\n\nADDITIONAL REQUIREMENTS:${customEnhancements}`;
            }
            if (skinEnforce) {
                instruction += skinEnforce;
            }
            instruction += `${identityRequirementBlock}${subjectPriorityBlock}`;
            if (exactNameRequirement || exactUserRequirement) {
                instruction += `\n\nNAME REQUIREMENTS:${exactNameRequirement}${exactUserRequirement}`;
            }
            if (!customInstructionHasMacro(s.llmCustomInstruction, "scene")) {
                log("Custom instruction missing {{scene}} placeholder; appending selected scene automatically");
                instruction += `\n\n${isMultiMessage ? "SELECTED SCENE CONTEXT" : "SELECTED SCENE"}:\n${basePrompt}`;
            }
        } else if (wantsCustom) {
            log("Custom instruction selected but empty, falling back to tags style");
            // Fall through to default tags style below
        }

        if (!instruction && isNatural) {
            let enhancements = "";
            let restrictions = "";
            if (s.llmAddQuality) enhancements += "\n- Enhanced quality descriptors (masterpiece, highly detailed, sharp focus, etc.)";
            if (s.llmAddLighting) enhancements += "\n- Professional lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)";
            if (s.llmAddArtist) {
                const randomArtist = getRandomArtist(false);
                enhancements += `\n- Art style references from well-known artists (e.g., ${randomArtist}, etc.)`;
            }
            else restrictions += "\n- DO NOT include artist names or art style references";

            instruction = `[STANDALONE IMAGE PROMPT GENERATION TASK]${skinEnforce}

CRITICAL INSTRUCTIONS:
- IGNORE any ambient chat history outside the selected scene below
- Generate ONLY a new image prompt based on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone task, not a continuation of chat
${multiMessageContextBlock}

[Output ONLY an image generation prompt. No commentary or explanation.]${skinEnforce}

CHARACTER REFERENCE:
${appearanceContext}${exactNameBlock}${userNameBlock}${identityRequirementBlock}${subjectPriorityBlock}
${isMultiMessage ? "SCENE CONTEXT (multiple messages):\n" : "CURRENT SCENE: "}${basePrompt}

Write a detailed image prompt describing:
- The characters involved with their defining visual traits (hair color, eye color, outfit, distinguishing features)
${shouldUseExactNameRequirements ? `- Use the exact active character names when the scene/card identifies them${activeCharacterNames.length ? ` (${activeCharacterList})` : ""}` : ""}
${userSceneRequirementBullet}
- Preserve explicit ages, species, creature types, and nonhuman identities from the scene/profile instead of replacing them with generic human labels
- If from known media/franchise, include the series name and character's canonical appearance
- Their poses, expressions, and body language
- The setting/background
- Lighting and atmosphere
- High quality visual details (sharp focus, detailed rendering, etc.)${enhancements ? `

YOU MUST ALSO INCLUDE:${enhancements}` : ""}${restrictions}

Prompt:`;
        }

        if (!instruction) {
            // Only generate default instruction if no custom instruction was set
            let enhancements = "";
            let restrictions = "";

            // Critical restrictions - ALWAYS apply these regardless of settings
            restrictions += "\nCRITICAL RESTRICTIONS (MUST FOLLOW):";
            restrictions += "\n- NEVER use realistic style tags (e.g., realistic, photorealistic, hyperrealistic, photography, etc.)";
            restrictions += "\n- NEVER use realistic artists (e.g., wlop, artgerm, rossdraws, etc.)";
            restrictions += "\n- NEVER use common/overused artists (e.g., sakimichan, greg rutkowski, alphonse mucha, etc.)";

            if (s.llmAddQuality) enhancements += "\n- Enhanced quality tags (masterpiece, best quality, highly detailed, sharp focus, etc.)";
            if (s.llmAddLighting) enhancements += "\n- Professional lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)";
            if (s.llmAddArtist) {
                const randomArtist = getRandomArtist(true); // Use tag format for Danbooru style
                enhancements += `\n- Include artist tags from anime/manga artists (e.g., ${randomArtist}, etc.)`;
            } else {
                restrictions += "\n- DO NOT include any artist names";
            }

            instruction = `### STANDALONE IMAGE GENERATION TASK ###${skinEnforce}

CRITICAL - THIS IS NOT A CONTINUATION OF CHAT:
- IGNORE any ambient chat history outside the selected scene below
- Generate a FRESH image prompt based ONLY on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone generation task
${multiMessageContextBlock}

### OUTPUT FORMAT (MANDATORY) ###
Output ONLY comma-separated Danbooru/Booru-style tags. No sentences. No descriptions. No paragraphs. No prose. No explanations.
If you write a sentence instead of tags, you have FAILED the task.

CORRECT example output:
1girl, hatsune_miku, vocaloid, long_hair, twintails, blue_hair, blue_eyes, detached_sleeves, thighhighs, sitting, smile, looking_at_viewer, classroom, window, sunlight, masterpiece, best_quality

WRONG (DO NOT do this):
"A girl with long blue twintails sits in a classroom by the window, smiling at the viewer."

### IMAGE GENERATION TASK ###

Create Danbooru/Booru-style tags for this ${isMultiMessage ? "scene context:\n" : "scene: "}${basePrompt}

Character info: ${appearanceContext}${exactNameBlock}${userNameBlock}${identityRequirementBlock}${subjectPriorityBlock}

Required tag categories:
- Character name + series name (CRITICAL: Use recognizable fictional media character tags whenever recognized${shouldUseExactNameRequirements ? `, and keep exact active names like ${activeCharacterList || "the named character"} when no canonical tag exists` : ""})
${userSceneRequirementBullet}
- Preserve explicit ages, species, creature types, and nonhuman identities from the scene/profile instead of replacing them with generic human tags
- Physical traits (hair, eyes, body, skin)
- Clothing and accessories
- Pose and expression
- Background/setting
- Quality tags (masterpiece, best quality, etc.)${enhancements ? `

MUST INCLUDE these additional elements:${enhancements}` : ""}
${restrictions}

Tags:`;
        }

        log(`Sending instruction to LLM (length: ${instruction.length} chars)`);

        // CRITICAL: Strong cache-busting by embedding random entropy INSIDE the instruction
        // SillyTavern caches based on instruction text, so we must make each request unique
        const timestamp = Date.now();
        const randomPart = Math.random().toString(36).substring(2, 11);
        const uniqueId = `${timestamp}_${randomPart}`;

        // Inject entropy directly into the scene/instruction at multiple points
        // This ensures cache invalidation even if prefix is stripped
        const entropyInline = `{{${uniqueId}}}`;
        let instructionWithEntropy = instruction
            .replace(/(CURRENT SCENE:|Scene:|scene:)/i, `$1 ${entropyInline}`)
            .replace(/(Tags:|Prompt:)\s*$/m, `$1 [ref:${randomPart}]`);

        // Also add at start as backup
        instructionWithEntropy = `[${timestamp}]\n${instructionWithEntropy}`;

        log(`Request ID: ${uniqueId}`);

        // Build the full instruction with optional prefill
        const prefillHint = resolvedPrefill ? `\n\nContinue the output from this exact prefix if your backend supports prefills:\n${resolvedPrefill}` : "";
        instructionWithEntropy += prefillHint;

        log(isCustom ? "Custom instruction mode" : "Built-in instruction mode");

        // Prefer a standalone request path so the helper prompt can use prefill and avoid ambient chat leakage.
        // Fallback to the quiet prompt path if standalone generation is unavailable.
        let llmPrompt;
        let helperResponseMeta;
        if (s.llmOverrideEnabled && s.llmOverrideProfileId) {
            log("Using LLM Override for prompt generation");
            helperResponseMeta = await callOverrideLLM(instructionWithEntropy, "", signal, {
                assistantPrefill: resolvedPrefill,
                returnMeta: true,
            });
            llmPrompt = helperResponseMeta?.text || "";
        } else {
            helperResponseMeta = await callInternalStandaloneLLM(instructionWithEntropy, {
                signal,
                quietName: `ImageGen_${timestamp}`,
                label: "image prompt generation request",
                prefill: resolvedPrefill,
                returnMeta: true,
            });
            llmPrompt = helperResponseMeta?.text || "";
        }

        checkAborted(); // Check immediately after LLM call returns
        logLLMHelperResponseMeta(helperResponseMeta, "LLM helper response");
        log(`LLM raw response: ${llmPrompt}`);
        log(`LLM response length: ${(llmPrompt || "").length} chars`);

        let cleaned = (llmPrompt || "").trim();

        // Remove all cache-busting tokens and entropy markers from response
        cleaned = cleaned.replace(/\[\d+\]\s*/g, '');              // [timestamp] at start
        cleaned = cleaned.replace(/\{\{\d+_[a-z0-9]+\}\}/gi, '');  // {{timestamp_random}} inline
        cleaned = cleaned.replace(/\[ref:[a-z0-9]+\]/gi, '');      // [ref:random] markers
        cleaned = cleaned.replace(/\[GEN:[^\]]+\]/g, '');          // legacy [GEN:...] format
        cleaned = cleaned.replace(/\[Request ID: [^\]]+\]/g, '');  // legacy Request ID
        cleaned = cleaned.replace(/\[Generation ID: \d+\]/g, '');  // legacy Generation ID
        cleaned = cleaned.trim();

        if (!cleaned) {
            const warningMessage = buildLLMEmptyPromptWarning(helperResponseMeta, llmPrompt, cleaned);
            log(`WARNING: ${warningMessage}`);
            logLLMHelperResponseMeta(helperResponseMeta, "LLM helper empty response");
            toastr.warning(warningMessage, "Image Gen", { timeOut: 5000 });
            return basePrompt;
        }

        // Strip only meta-label prefills; preserve character-name prefills so filters can still key off them.
        if (resolvedPrefill && shouldStripPrefillFromLLMResult(resolvedPrefill, profile) && cleaned.toLowerCase().startsWith(resolvedPrefill.toLowerCase())) {
            cleaned = cleaned.substring(resolvedPrefill.length).trim();
        }
        cleaned = mergeMeaningfulPrefillIntoLLMResult(cleaned, resolvedPrefill, profile);

        // CRITICAL: Check if response looks like roleplay dialogue (indicates LLM used chat context)
        // Roleplay dialogue typically has dialogue markers, quotation marks, or narrative text
        const looksLikeRoleplay = /["'"].*\s["']|said:|thought:|thought\s*:|^[A-Z][a-z]+\s+(?:nods|smiles|frowns|laughs|gasps)/i.test(cleaned);

        if (looksLikeRoleplay) {
            log("⚠️ WARNING: Response appears to be roleplay dialogue, not an image prompt!");
            log("This indicates LLM used chat context despite our instructions.");

            // Force a minimal, literal instruction as fallback
            log("Attempting literal fallback instruction...");
            cleaned = await generateLiteralFallback(basePrompt);
        }

        return cleaned || basePrompt;
    } catch (e) {
        if (e.name === "AbortError") throw e;
        log(`LLM prompt failed: ${e.message}`);
        toastr.warning(`LLM prompt failed: ${e.message}`, "Image Gen", { timeOut: 5000 });
        return basePrompt;
    }
}

async function generateLiteralFallback(originalInstruction) {
    try {
        // This is a last resort: we extract just the scene/action from the instruction
        // and return it as-is without LLM processing
        log("Using literal fallback to avoid chat context issues");

        // Extract scene/action part by looking for common patterns
        let extracted = originalInstruction;

        // Remove instruction headers if present
        extracted = extracted.replace(/^###.*?###\s*/g, '');
        extracted = extracted.replace(/CRITICAL.*?\n*/gi, '');
        extracted = extracted.replace(/Create.*?for\s+this\s+scene:/gi, '');
        extracted = extracted.replace(/Scene:\s*/gi, '');

        // Clean up but keep essence
        extracted = extracted.replace(/\n\n+/g, '\n').trim();

        log(`Literal fallback extracted: ${extracted.substring(0, 100)}...`);
        return extracted;
    } catch (e) {
        log(`Literal fallback failed: ${e.message}`);
        return originalInstruction;
    }
}

async function pollinationsFetchImageData(prompt, negative, s, signal) {
    const model = String(s.pollinationsModel || "").trim() || "flux";
    const seed = resolveRandomSeed(s.seed, s);
    const res = await fetch("https://gen.pollinations.ai/v1/images/generations", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.pollinationsKey}`,
        },
        body: JSON.stringify({
            model,
            prompt,
            negative_prompt: negative || undefined,
            size: `${s.width}x${s.height}`,
            seed,
            n: 1,
            response_format: "b64_json",
        }),
        signal,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => null);
        const message = err?.error?.message || err?.message || res.statusText || `HTTP ${res.status}`;
        throw new Error(`Pollinations error ${res.status}: ${message}`);
    }

    const data = await res.json();
    if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
    if (data.data?.[0]?.url) return data.data[0].url;
    throw new Error("No image in Pollinations response");
}

async function genPollinations(prompt, negative, s, signal) {
    if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const model = String(s.pollinationsModel || "").trim();
    const key = String(s.pollinationsKey || "").trim();

    if (key) {
        log(`Pollinations: using authenticated API${model ? ` with model '${model}'` : ""}`);
        return await pollinationsFetchImageData(prompt, negative, s, signal);
    }

    if (model && POLLINATIONS_PAID_MODEL_IDS.has(model)) {
        throw new Error(`Pollinations model '${model}' requires an API key`);
    }

    const seed = resolveRandomSeed(s.seed, s);
    let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${s.width}&height=${s.height}&seed=${seed}&nologo=true`;
    if (negative) url += `&negative=${encodeURIComponent(negative)}`;
    if (model && model !== "flux") url += `&model=${encodeURIComponent(model)}`;
    log(`Pollinations URL: ${url.substring(0, 100)}...`);
    return url;
}

async function genNovelAI(prompt, negative, s, signal) {
    normalizeSize(s);
    const isV4 = s.naiModel.includes("-4");
    // Map SillyTavern sampler names to NovelAI API format
    const samplerMap = {
        "euler_a": "k_euler_ancestral", "euler": "k_euler",
        "dpm++_2m": "k_dpmpp_2m", "dpm++_sde": "k_dpmpp_sde",
        "dpm++_2m_sde": "k_dpmpp_2m", "dpm++_3m_sde": "k_dpmpp_2m",
        "dpm++_2s_ancestral": "k_dpmpp_2s_ancestral",
        "dpm_2": "k_dpm_2", "dpm_2_ancestral": "k_dpm_2_ancestral",
        "dpm_fast": "k_dpm_fast", "dpm_adaptive": "k_dpm_adaptive",
        "ddim": "ddim", "ddpm": "k_euler", "lms": "k_lms",
        "heun": "k_heun", "heunpp2": "k_heun",
        "plms": "k_euler", "uni_pc": "k_euler", "uni_pc_bh2": "k_euler",
        "lcm": "k_euler", "deis": "k_euler", "restart": "k_euler"
    };
    const isV3OrNewer = s.naiModel.includes("diffusion-3") || s.naiModel.includes("diffusion-4");
    const sampler = (s.sampler === "ddim" && isV3OrNewer)
        ? "ddim_v3"
        : (samplerMap[s.sampler] || "k_euler_ancestral");
    const seed = resolveRandomSeed(s.seed, s);

    const params = {
        width: s.width,
        height: s.height,
        steps: s.steps,
        scale: s.cfgScale,
        sampler: sampler,
        seed: seed,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: false,
        negative_prompt: negative,
        params_version: 3,
        legacy: false,
        controlnet_strength: 1,
        dynamic_thresholding: false,
        cfg_rescale: 0,
        noise_schedule: "native"
    };

    if (isV4) {
        params.v4_prompt = { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true };
        params.v4_negative_prompt = { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false };
        params.characterPrompts = [];
        params.skip_cfg_above_sigma = null;
    }

    const payload = { input: prompt, model: s.naiModel, action: "generate", parameters: params };

    // OpenAI-compatible proxy (e.g. linkapi.cc/v1 → yousebaby → NAI)
    if (s.naiProxyUrl && s.naiProxyUrl.includes("/v1")) {
        const proxyKey = s.naiProxyKey || s.naiKey;
        const proxyUrl = String(s.naiProxyUrl || "").replace(/\/$/, "");

        if (proxyUrl.includes("/chat/completions")) {
            const exactGenerateUrl = getNovelAIProxyGenerateUrl(proxyUrl);
            if (exactGenerateUrl) {
                const exactPayload = {
                    input: prompt,
                    model: s.naiModel,
                    action: "generate",
                    parameters: { ...params, return_base64: true }
                };
                try {
                    log(`NAI v1 proxy exact-size attempt to ${exactGenerateUrl}: size=${s.width}x${s.height}`);
                    const exactRes = await fetch(exactGenerateUrl, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${proxyKey}`, "Content-Type": "application/json", "Accept": "*/*" },
                        body: JSON.stringify(exactPayload),
                        signal
                    });
                    if (exactRes.ok) {
                        const exactJson = await exactRes.json();
                        return extractNovelAIProxyImageUrl(exactJson, exactGenerateUrl);
                    }
                    const errText = await exactRes.text().catch(() => "");
                    log(`NAI v1 proxy exact-size fallback: ${exactRes.status} ${errText.substring(0, 180)}`);
                } catch (e) {
                    if (e.name === "AbortError") throw e;
                    log(`NAI v1 proxy exact-size fallback (error): ${e.message}`);
                }
            }
        }

        const v1SamplerMap = {
            "k_euler_ancestral": "Euler Ancestral", "k_euler": "Euler",
            "k_dpmpp_2m": "DPM++ 2M", "k_dpmpp_sde": "DPM++ SDE",
            "k_dpmpp_2m_sde": "DPM++ 2M SDE", "ddim": "DDIM", "ddim_v3": "DDIM"
        };
        const v1Url = proxyUrl.includes("/chat/completions")
            ? proxyUrl
            : proxyUrl + "/chat/completions";
        const v1Payload = {
            model: s.naiModel,
            messages: [{ role: "user", content: prompt }],
            size: s.width > s.height ? "1216:832" : s.width < s.height ? "832:1216" : "1024:1024",
            negative_prompt: negative,
            sampler: v1SamplerMap[sampler] || "Euler Ancestral",
            return_base64: true,
            stream: false
        };
        log(`NAI v1 proxy request to ${v1Url}: ${JSON.stringify(v1Payload).substring(0, 200)}...`);
        const res = await fetch(v1Url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${proxyKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(v1Payload),
            signal
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`NovelAI proxy error: ${res.status} ${errText}`);
        }
        const json = await res.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) throw new Error(`NovelAI proxy returned no image: ${JSON.stringify(json).substring(0, 300)}`);
        if (content.startsWith("data:")) return content;
        if (content.startsWith("http")) return content;
        const mdMatch = content.match(/!\[.*?\]\((.*?)\)/);
        if (mdMatch) return mdMatch[1];
        throw new Error(`NovelAI proxy returned unexpected content: ${content.substring(0, 200)}`);
    }

    const isProxy = !!s.naiProxyUrl;
    const apiUrl = isProxy
        ? getNovelAIProxyGenerateUrl(s.naiProxyUrl)
        : "https://image.novelai.net/ai/generate-image";
    if (isProxy && !apiUrl) throw new Error("NovelAI proxy URL is required");
    const apiKey = s.naiProxyKey || s.naiKey;

    if (isProxy) params.return_base64 = true;

    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "*/*" },
        body: JSON.stringify(payload),
        signal
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`NovelAI error: ${res.status} ${errText}`);
    }

    // Proxy returns JSON with a URL or base64 data URI
    if (isProxy) {
        const json = await res.json();
        return extractNovelAIProxyImageUrl(json, apiUrl);
    }

    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    log(`NAI response length: ${bytes.length}`);

    // Check if response is a ZIP file (starts with PK)
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
        log("Response is ZIP format, extracting PNG...");
        const pngData = await extractPngFromZip(bytes);
        if (!pngData) {
            throw new Error("No PNG found in ZIP response. Check your API key and model settings.");
        }

        // Verify PNG signature
        if (pngData[0] === 0x89 && pngData[1] === 0x50 && pngData[2] === 0x4E && pngData[3] === 0x47) {
            log(`Extracted valid PNG from ZIP: ${pngData.length} bytes`);
            { const u = URL.createObjectURL(new Blob([pngData], { type: "image/png" })); blobUrls.add(u); return u; }
        } else {
            log(`Invalid PNG signature after extraction: ${pngData[0]} ${pngData[1]} ${pngData[2]} ${pngData[3]}`);
            throw new Error("Extracted data is not a valid PNG file.");
        }
    }

    // V4+ returns msgpack events, V3 returns zip - both contain PNG data we can extract
    const pngStart = findPngStart(bytes);
    if (pngStart < 0) {
        const textResponse = new TextDecoder().decode(bytes.slice(0, Math.min(200, bytes.length)));
        log(`First 200 bytes as text: ${textResponse}`);
        throw new Error("No PNG found in response. Check your API key and model settings.");
    }

    // Find PNG end (IEND chunk + CRC)
    const pngEnd = findPngEnd(bytes, pngStart);
    log(`Extracted PNG: ${pngStart} to ${pngEnd} (${pngEnd - pngStart} bytes)`);
    const pngData = bytes.slice(pngStart, pngEnd);
    { const u = URL.createObjectURL(new Blob([pngData], { type: "image/png" })); blobUrls.add(u); return u; }
}

function getGptImageApiUrl(proxyUrl = "") {
    const trimmed = String(proxyUrl || "").trim().replace(/\/$/, "");
    if (!trimmed) return "https://api.openai.com/v1/images/generations";
    return resolveProxyRequestUrl(trimmed, "images_generations");
}

function getGptImageSize(settings = getSettings()) {
    const width = Number(settings?.width) || 1024;
    const height = Number(settings?.height) || 1024;
    if (width === height) return "1024x1024";
    return width > height ? "1536x1024" : "1024x1536";
}

function getConfiguredImageSize(settings = getSettings()) {
    const width = Number(settings?.width) || 1024;
    const height = Number(settings?.height) || 1024;
    return `${width}x${height}`;
}

function parseSupportedImageSizeOption(option, targetPixels) {
    const size = String(option || "").trim();
    const dimensionMatch = size.match(/^(\d+)x(\d+)$/i);
    if (dimensionMatch) {
        const width = Number(dimensionMatch[1]);
        const height = Number(dimensionMatch[2]);
        if (width > 0 && height > 0) return { size, ratio: width / height, pixels: width * height };
    }

    const ratioMatch = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (ratioMatch) {
        const width = Number(ratioMatch[1]);
        const height = Number(ratioMatch[2]);
        if (width > 0 && height > 0) return { size, ratio: width / height, pixels: targetPixels };
    }

    return null;
}

function getClosestSupportedImageSize(settings, supportedSizes) {
    const width = Number(settings?.width) || 1024;
    const height = Number(settings?.height) || 1024;
    const configuredSize = `${width}x${height}`;
    if (!Array.isArray(supportedSizes) || !supportedSizes.length) return configuredSize;

    const targetPixels = width * height;
    const targetRatio = width / height;
    const parsedSizes = supportedSizes
        .map(size => parseSupportedImageSizeOption(size, targetPixels))
        .filter(Boolean);
    if (!parsedSizes.length) return configuredSize;

    const exact = parsedSizes.find(size => size.size.toLowerCase() === configuredSize.toLowerCase());
    if (exact) return exact.size;

    let best = parsedSizes[0];
    let bestScore = Infinity;
    for (const size of parsedSizes) {
        const ratioScore = Math.abs(Math.log(size.ratio / targetRatio));
        const pixelScore = Math.abs(Math.log(size.pixels / targetPixels));
        const score = (ratioScore * 3) + pixelScore;
        if (score < bestScore) {
            best = size;
            bestScore = score;
        }
    }

    return best.size;
}

function getOpenAICompatibleImageSize(provider, model, settings = getSettings()) {
    const sizeMaps = {
        routeway: ROUTEWAY_MODEL_SIZES,
        navy: NAVY_MODEL_SIZES,
    };
    const configuredSize = getConfiguredImageSize(settings);
    const supportedSizes = sizeMaps[provider]?.[model];
    const resolvedSize = getClosestSupportedImageSize(settings, supportedSizes);
    if (resolvedSize !== configuredSize) {
        log(`${PROVIDERS[provider]?.name || provider}: mapped requested size ${configuredSize} to supported size ${resolvedSize} for ${model}`);
    }
    return resolvedSize;
}

function getGptImageMime(format = "png") {
    const normalized = String(format || "png").trim().toLowerCase();
    if (normalized === "jpeg" || normalized === "jpg") return "image/jpeg";
    if (normalized === "webp") return "image/webp";
    return "image/png";
}

function normalizeGptImageFormat(format = "png") {
    const normalized = String(format || "png").trim().toLowerCase();
    if (normalized === "jpg") return "jpeg";
    return ["png", "jpeg", "webp"].includes(normalized) ? normalized : "png";
}

function normalizeGptImageOption(value, allowed, fallback = "auto") {
    const normalized = String(value || fallback).trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

function extractGptImageDataUrl(value, format = "png") {
    if (typeof value !== "string" || !value.trim()) return null;
    const b64 = value.trim();
    return b64.startsWith("data:")
        ? b64
        : `data:${getGptImageMime(format)};base64,${b64}`;
}

function extractGptImageFromJson(data, format = "png") {
    const dataItem = data?.data?.[0];
    const b64Candidates = [
        dataItem?.b64_json,
        dataItem?.image_base64,
        dataItem?.imageBase64,
        dataItem?.base64,
        data?.b64_json,
        data?.image_base64,
        data?.imageBase64,
        data?.base64,
    ];
    for (const candidate of b64Candidates) {
        const image = extractGptImageDataUrl(candidate, format);
        if (image) return image;
    }

    const image = extractProxyImageFromJson(data);
    if (image) return image;

    throw new Error(`GPT Image returned no image: ${JSON.stringify(data || {}).substring(0, 300)}`);
}

async function genGptImage(prompt, negative, s, signal) {
    const apiKey = s.gptImageProxyKey || s.gptImageKey;
    if (!apiKey) throw new Error("GPT Image API key required");

    const apiUrl = getGptImageApiUrl(s.gptImageProxyUrl);
    if (!apiUrl) throw new Error("GPT Image API URL is required");

    const model = String(s.gptImageModel || "gpt-image-2").trim();
    const outputFormat = normalizeGptImageFormat(s.gptImageFormat);
    const quality = normalizeGptImageOption(s.gptImageQuality, ["auto", "low", "medium", "high"]);
    const background = normalizeGptImageOption(s.gptImageBackground, ["auto", "transparent", "opaque"]);
    const moderation = normalizeGptImageOption(s.gptImageModeration, ["auto", "low"]);
    const effectivePrompt = negative
        ? `${prompt}\n\nAvoid in the image: ${negative}`
        : prompt;
    const payload = {
        model,
        prompt: effectivePrompt,
        size: getGptImageSize(s),
        n: 1,
    };

    if (quality !== "auto") payload.quality = quality;
    if (outputFormat !== "png") payload.output_format = outputFormat;
    if (background !== "auto") {
        if (background === "transparent" && outputFormat === "jpeg") {
            log("GPT Image: transparent backgrounds require PNG or WebP output; omitting background for JPEG.");
        } else {
            payload.background = background;
        }
    }
    if (moderation !== "auto") payload.moderation = moderation;

    log(`GPT Image request to ${apiUrl}: model=${model}, size=${payload.size}, quality=${payload.quality || "auto"}, format=${payload.output_format || "png"}`);
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!res.ok) {
        const detail = await readProxyErrorResponse(res);
        throw new Error(`GPT Image error ${res.status}: ${detail || res.statusText}`);
    }

    const data = await res.json();
    return extractGptImageFromJson(data, outputFormat);
}

function findPngStart(bytes) {
    for (let i = 0; i < bytes.length - 8; i++) {
        if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x47) return i;
    }
    return -1;
}

function findPngEnd(bytes, start) {
    // Look for IEND chunk (49 45 4E 44) followed by CRC
    for (let i = start; i < bytes.length - 8; i++) {
        if (bytes[i] === 0x49 && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x44) {
            return i + 8; // IEND + 4 byte CRC
        }
    }
    return bytes.length;
}

async function extractPngFromZip(zipBytes) {
    try {
        const view = new DataView(zipBytes.buffer);

        // Find end of central directory record
        let eocdOffset = -1;
        for (let i = zipBytes.length - 22; i >= 0; i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                eocdOffset = i;
                break;
            }
        }

        if (eocdOffset === -1) {
            console.log("No EOCD found, trying direct PNG search...");
            return searchForPngInBytes(zipBytes);
        }

        // Get central directory info
        const cdOffset = view.getUint32(eocdOffset + 16, true);
        const cdEntries = view.getUint16(eocdOffset + 10, true);

        if (cdOffset >= zipBytes.length || cdOffset < 0) return searchForPngInBytes(zipBytes);

        // Parse central directory entries
        let offset = cdOffset;
        for (let i = 0; i < cdEntries; i++) {
            if (view.getUint32(offset, true) !== 0x02014b50) break;

            const compressionMethod = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize = view.getUint32(offset + 24, true);
            const filenameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localHeaderOffset = view.getUint32(offset + 42, true);

            // Get filename
            const filename = new TextDecoder().decode(zipBytes.slice(offset + 46, offset + 46 + filenameLength));

            if (filename.toLowerCase().endsWith('.png')) {
                console.log(`Found PNG file: ${filename}, compression: ${compressionMethod}`);

                if (localHeaderOffset + 30 >= zipBytes.length) break;

                // Get local file header
                const localFilenameLength = view.getUint16(localHeaderOffset + 26, true);
                const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
                const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;

                if (compressionMethod === 0) {
                    // No compression
                    return zipBytes.slice(dataOffset, dataOffset + compressedSize);
                } else if (compressionMethod === 8) {
                    // Deflate compression - try to decompress
                    const compressedData = zipBytes.slice(dataOffset, dataOffset + compressedSize);
                    return await decompressDeflate(compressedData);
                }
            }

            offset += 46 + filenameLength + extraLength + commentLength;
        }

        console.log("No PNG found in central directory, trying direct search...");
        return searchForPngInBytes(zipBytes);

    } catch (e) {
        console.error("ZIP parsing error:", e);
        return searchForPngInBytes(zipBytes);
    }
}

function searchForPngInBytes(bytes) {
    // Search for PNG signature in raw bytes
    for (let i = 0; i < bytes.length - 8; i++) {
        if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x47 &&
            bytes[i + 4] === 0x0D && bytes[i + 5] === 0x0A && bytes[i + 6] === 0x1A && bytes[i + 7] === 0x0A) {

            // Find IEND
            for (let j = i + 8; j < bytes.length - 8; j++) {
                if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4E && bytes[j + 3] === 0x44) {
                    const pngData = bytes.slice(i, j + 8);
                    console.log(`Found PNG via direct search: ${pngData.length} bytes`);
                    return pngData;
                }
            }
        }
    }
    return null;
}

async function decompressDeflate(compressedData) {
    try {
        // Use pako if available (common in many environments)
        if (typeof pako !== 'undefined') {
            return pako.inflate(compressedData);
        }

        // Try browser's DecompressionStream
        if (typeof DecompressionStream !== 'undefined') {
            const stream = new DecompressionStream('deflate-raw');
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();

            writer.write(compressedData);
            writer.close();

            const chunks = [];
            let done = false;
            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) chunks.push(value);
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            return result;
        }

        console.log("No decompression method available, returning null");
        return null;

    } catch (e) {
        console.error("Decompression failed:", e);
        return null;
    }
}

async function genArliAI(prompt, negative, s, signal) {
    const seed = resolveRandomSeed(s.seed, s);
    const res = await fetch("https://api.arliai.com/v1/txt2img", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${s.arliKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            sd_model_checkpoint: s.arliModel,
            prompt: prompt,
            negative_prompt: negative,
            width: s.width,
            height: s.height,
            steps: s.steps,
            cfg_scale: s.cfgScale,
            sampler_name: s.sampler,
            seed: seed
        }),
        signal
    });
    if (!res.ok) throw new Error(`ArliAI error: ${res.status}`);
    const data = await res.json();
    if (data.images?.[0]) return `data:image/png;base64,${data.images[0]}`;
    throw new Error("No image in response");
}

async function genNanoGPT(prompt, negative, s, signal) {
    const body = {
        model: s.nanogptModel,
        prompt: prompt,
        negative_prompt: negative,
        size: `${s.width}x${s.height}`,
        n: 1
    };
    const refs = s.nanogptRefImages || [];
    if (refs.length === 1) {
        body.imageDataUrl = refs[0];
        body.strength = s.nanogptStrength ?? 0.75;
    } else if (refs.length > 1) {
        body.imageDataUrls = refs;
        body.strength = s.nanogptStrength ?? 0.75;
    }
    const res = await fetch("https://nano-gpt.com/v1/images/generations", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${s.nanogptKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
    });
    if (!res.ok) throw new Error(`NanoGPT error: ${res.status}`);
    const data = await res.json();
    if (data.data?.[0]?.url) return data.data[0].url;
    if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
    throw new Error("No image in response");
}

async function genChutes(prompt, negative, s, signal) {
    const seed = resolveRandomSeed(s.seed, s);
    const res = await fetch("https://image.chutes.ai/generate", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${s.chutesKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: s.chutesModel,
            prompt: prompt,
            negative_prompt: negative,
            width: s.width,
            height: s.height,
            num_inference_steps: s.steps,
            guidance_scale: s.cfgScale,
            seed: seed
        }),
        signal
    });
    if (!res.ok) throw new Error(`Chutes error: ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("image/")) {
        const blob = await res.blob();
        const u = URL.createObjectURL(blob); blobUrls.add(u); return u;
    }
    const data = await res.json();
    if (data.images?.[0]) {
        const img = data.images[0];
        if (img.startsWith?.("data:") || img.startsWith?.("http")) return img;
        return `data:image/png;base64,${img}`;
    }
    if (data.image) {
        if (data.image.startsWith?.("data:") || data.image.startsWith?.("http")) return data.image;
        return `data:image/png;base64,${data.image}`;
    }
    throw new Error("No image in response");
}

async function genCivitAI(prompt, negative, s, signal) {
    const seed = resolveRandomSeed(s.seed, s);
    // Parse LoRAs into additionalNetworks map
    let additionalNetworks;
    if (s.civitaiLoras && s.civitaiLoras.trim()) {
        additionalNetworks = {};
        for (const entry of s.civitaiLoras.split(",")) {
            const trimmed = entry.trim();
            if (!trimmed) continue;
            const lastColon = trimmed.lastIndexOf(":");
            // URNs contain colons, so split on the last one for urn:weight
            const hasWeight = lastColon > 0 && !isNaN(parseFloat(trimmed.slice(lastColon + 1)));
            const urn = hasWeight ? trimmed.slice(0, lastColon).trim() : trimmed;
            const strength = hasWeight ? parseFloat(trimmed.slice(lastColon + 1)) : 1.0;
            additionalNetworks[urn] = { strength };
        }
        if (Object.keys(additionalNetworks).length > 0) {
            log(`CivitAI: Using ${Object.keys(additionalNetworks).length} LoRA(s): ${Object.keys(additionalNetworks).map(u => u.split(":").pop()).join(", ")}`);
        } else {
            additionalNetworks = undefined;
        }
    }

    const input = {
        model: s.civitaiModel,
        params: {
            prompt: prompt,
            negativePrompt: negative,
            scheduler: s.civitaiScheduler || "EulerA",
            steps: s.steps,
            cfgScale: s.cfgScale,
            width: s.width,
            height: s.height,
            seed: seed,
            clipSkip: parseInt(s.a1111ClipSkip) || 2
        },
        batchSize: 1
    };
    if (additionalNetworks) input.additionalNetworks = additionalNetworks;

    const res = await civitaiFetch("createJob", {
        apiKey: s.civitaiKey,
        body: { $type: "textToImage", input },
    }, signal);
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`CivitAI error: ${res.status} - ${errText}`);
    }
    const data = await res.json();

    // Poll for job completion using token
    const jobToken = data.token;
    if (!jobToken) throw new Error(`No job token returned: ${JSON.stringify(data)}`);

    let lastError = null;
    for (let i = 0; i < 60; i++) {
        if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
        await new Promise(r => setTimeout(r, 2000));
        const statusRes = await civitaiFetch("getJobs", {
            apiKey: s.civitaiKey,
            token: jobToken,
        }, signal);
        if (!statusRes.ok) {
            lastError = `Status error: ${statusRes.status}`;
            continue;
        }
        const jobs = await statusRes.json();
        const job = jobs?.[0];

        if (job?.result?.blobUrl) {
            return job.result.blobUrl;
        }
        if (job?.scheduled === false && !job?.result) {
            throw new Error(`CivitAI job failed: ${job.message || 'Unknown error'}`);
        }
    }
    throw new Error(`CivitAI job timeout. Last error: ${lastError || 'Still processing'}`);
}

async function genNanobanana(prompt, negative, s, signal) {
    // Build parts array with reference images and prompt
    const parts = [];
    if (s.nanobananaRefImages?.length) {
        log(`Adding ${s.nanobananaRefImages.length} reference images to Nanobanana request`);
        for (const img of s.nanobananaRefImages) {
            const match = img.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            } else if (img.startsWith('http')) {
                // URL-based reference image — fetch and convert to inline data
                try {
                    log(`Fetching reference image URL: ${img.substring(0, 80)}`);
                    const imgRes = await fetch(img, { signal });
                    const blob = await imgRes.blob();
                    const base64 = await new Promise(resolve => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                    });
                    const urlMatch = base64.match(/^data:([^;]+);base64,(.+)$/);
                    if (urlMatch) parts.push({ inlineData: { mimeType: urlMatch[1], data: urlMatch[2] } });
                } catch (e) {
                    log(`Failed to fetch reference image URL: ${e.message}`);
                }
            }
        }
    }

    let finalPrompt = `Generate an image: ${prompt}`;
    if (s.nanobananaRefImages?.length) {
        finalPrompt = `Look at the reference image(s) above. Match their style, composition, and visual characteristics. Now generate a new image with this description: ${prompt}`;
    }
    const nbpDirectorInstruction = buildNbpDirectorInstruction(s);
    if (nbpDirectorInstruction) finalPrompt += ` ${nbpDirectorInstruction}`;
    if (negative) finalPrompt += ` Avoid: ${negative}`;
    if (s.nanobananaExtraInstructions) finalPrompt += ` Additional user instructions: ${s.nanobananaExtraInstructions}`;

    parts.push({ text: finalPrompt });

    const generationConfig = {
        responseModalities: ["TEXT", "IMAGE"]
    };
    const imageSize = getNanobananaImageSize(s);
    generationConfig.imageConfig = {
        aspectRatio: getNanobananaAspectRatio(s),
    };
    if (imageSize) generationConfig.imageConfig.imageSize = imageSize;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${s.nanobananaModel}:generateContent?key=${s.nanobananaKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig
        }),
        signal
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Nanobanana error: ${res.status}${errText ? ` - ${errText.slice(0, 300)}` : ""}`);
    }
    const data = await res.json();

    for (const candidate of data.candidates || []) {
        for (const part of candidate.content?.parts || []) {
            if (part.inlineData?.data) {
                return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
            }
        }
    }
    throw new Error("No image in response");
}

async function genLocal(prompt, negative, s, signal) {
    const baseUrl = s.localUrl.replace(/\/$/, "");

    if (s.localType === "comfyui") {
        // Map sampler names to ComfyUI format
        const comfySamplerMap = {
            "euler_a": "euler_ancestral", "euler": "euler",
            "dpm++_2m": "dpmpp_2m", "dpm++_sde": "dpmpp_sde", "dpm++_2m_sde": "dpmpp_2m_sde",
            "dpm++_3m_sde": "dpmpp_3m_sde", "dpm++_2s_ancestral": "dpmpp_2s_ancestral",
            "dpmpp_2m": "dpmpp_2m", "dpmpp_sde": "dpmpp_sde",
            "dpm_2": "dpm_2", "dpm_2_ancestral": "dpm_2_ancestral",
            "dpm_fast": "dpm_fast", "dpm_adaptive": "dpm_adaptive",
            "ddim": "ddim", "ddpm": "ddpm", "lms": "lms",
            "heun": "heun", "heunpp2": "heunpp2", "plms": "euler",
            "uni_pc": "uni_pc", "uni_pc_bh2": "uni_pc_bh2",
            "lcm": "lcm", "deis": "deis", "restart": "restart"
        };

        const samplerName = comfySamplerMap[s.sampler] || s.sampler.replace(/\+\+/g, "pp");
        const schedulerName = s.comfyScheduler || "normal";
        const seed = resolveRandomSeed(s.seed, s);
        const denoise = parseFloatOr(s.comfyDenoise, 1.0);
        const clipSkip = parseIntOr(s.comfyClipSkip, 1);
        const comfyTimeoutSeconds = Math.max(10, parseIntOr(s.comfyTimeout, 300));

        async function waitForComfyImage(promptId) {
            for (let i = 0; i < comfyTimeoutSeconds; i++) {
                if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
                await new Promise(r => setTimeout(r, 1000));
                showStatus(`Generating... (waiting ${i + 1}s)`);
                let hist;
                try {
                    const histRes = await corsFetch(`${baseUrl}/history/${promptId}`, { signal });
                    if (!histRes.ok) continue;
                    hist = await histRes.json();
                } catch { continue; }
                const result = hist[promptId];
                checkComfyResult(result);
                if (result?.outputs) {
                    for (const nodeId in result.outputs) {
                        const output = result.outputs[nodeId];
                        if (output.images?.[0]) {
                            const img = output.images[0];
                            return `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type || "output"}`;
                        }
                    }
                }
            }
            throw new Error(`ComfyUI timed out after ${comfyTimeoutSeconds}s`);
        }

        // Check for custom workflow JSON
        if (s.comfyWorkflow && s.comfyWorkflow.trim()) {
            let customWorkflow = null;
            try {
                customWorkflow = JSON.parse(s.comfyWorkflow);
            } catch (e) {
                log(`ComfyUI: Invalid workflow JSON: ${e.message}, using default`);
            }

            if (customWorkflow && typeof customWorkflow === "object" && !Array.isArray(customWorkflow)) {

                // Upload reference image for %reference_image% placeholder
                let uploadedRefName = '';
                if (s.localRefImage) {
                    try {
                        const imgData = s.localRefImage.replace(/^data:image\/.+;base64,/, '');
                        const blob = await (await fetch(`data:image/png;base64,${imgData}`)).blob();
                        const formData = new FormData();
                        formData.append("image", blob, "qig_ref.png");
                        formData.append("overwrite", "true");
                        const uploadRes = await corsFetch(`${baseUrl}/upload/image`, {
                            method: "POST",
                            body: formData,
                            signal
                        });
                        if (uploadRes.ok) {
                            const uploadData = await uploadRes.json();
                            uploadedRefName = uploadData.name || "qig_ref.png";
                            log(`ComfyUI: Uploaded reference image as "${uploadedRefName}"`);
                        } else {
                            log(`ComfyUI: Failed to upload reference image (${uploadRes.status})`);
                        }
                    } catch (uploadErr) {
                        log(`ComfyUI: Reference image upload error: ${uploadErr.message}`);
                    }
                }

                // Replace placeholders like sd-proxy does
                const replacements = {
                    '%prompt%': prompt,
                    '%negative%': negative,
                    '%seed%': String(seed),
                    '%width%': String(s.width),
                    '%height%': String(s.height),
                    '%steps%': String(s.steps),
                    '%cfg%': String(s.cfgScale),
                    '%denoise%': String(denoise),
                    '%clip_skip%': String(clipSkip),
                    '%sampler%': samplerName,
                    '%scheduler%': schedulerName,
                    '%model%': s.localModel || 'model.safetensors',
                    '%reference_image%': uploadedRefName
                };
                const typedReplacements = {
                    '%prompt%': prompt,
                    '%negative%': negative,
                    '%seed%': seed,
                    '%width%': Number(s.width),
                    '%height%': Number(s.height),
                    '%steps%': Number(s.steps),
                    '%cfg%': Number(s.cfgScale),
                    '%denoise%': denoise,
                    '%clip_skip%': clipSkip,
                    '%sampler%': samplerName,
                    '%scheduler%': schedulerName,
                    '%model%': s.localModel || 'model.safetensors',
                    '%reference_image%': uploadedRefName
                };

                const replaceInObj = (obj) => {
                    for (const key in obj) {
                        if (typeof obj[key] === 'string') {
                            if (Object.prototype.hasOwnProperty.call(typedReplacements, obj[key])) {
                                obj[key] = typedReplacements[obj[key]];
                                continue;
                            }
                            for (const [placeholder, value] of Object.entries(replacements)) {
                                obj[key] = obj[key].split(placeholder).join(value);
                            }
                        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                            replaceInObj(obj[key]);
                        }
                    }
                };
                replaceInObj(customWorkflow);

                log(`ComfyUI: Using custom workflow with ${Object.keys(customWorkflow).length} nodes`);

                const res = await corsFetch(`${baseUrl}/prompt`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt: customWorkflow }),
                    signal
                });
                if (!res.ok) {
                    let detail = "";
                    try { const b = await res.json(); detail = b.error?.message || b.error || ""; } catch {}
                    throw new Error(`ComfyUI error ${res.status}${detail ? ": " + detail : ""}`);
                }
                const data = await res.json();

                const promptId = data.prompt_id;
                return await waitForComfyImage(promptId);
            }
            if (customWorkflow) log("ComfyUI: Workflow JSON must be an API-format object, using default");
        }

        function checkComfyResult(result) {
            if (result?.status?.status_str === "error") {
                const errorMsgs = result.status.messages || [];
                const executionError = errorMsgs.find(m => m[0] === "execution_error");
                const errMsg = executionError?.[1]?.exception_message || "Unknown execution error";
                let hint = "";
                if (/clip.*invalid|invalid.*clip|clip.*not.*found/i.test(errMsg)) {
                    hint = " (Hint: model may lack a built-in CLIP encoder. For UNET-only models, enable 'Skip Negative Prompt' and fill in the CLIP Model and VAE Model fields below it. Or use a custom workflow JSON exported from ComfyUI.)";
                } else if (/vae.*invalid|invalid.*vae|vae.*not.*found/i.test(errMsg)) {
                    hint = " (Hint: model may lack a built-in VAE. For UNET-only models, enable 'Skip Negative Prompt' and fill in the VAE Model field below it. Or use a custom workflow JSON exported from ComfyUI.)";
                } else if (/negative.*conditioning|conditioning.*negative/i.test(errMsg)) {
                    hint = " (Hint: this model may not support negative prompts. Try enabling 'Skip Negative Prompt' in ComfyUI settings.)";
                }
                throw new Error(`ComfyUI execution error: ${errMsg}${hint}`);
            }
        }

        // ComfyUI API - Default workflow
        const skipNeg = !!s.comfySkipNegativePrompt;
        const fluxMode = isComfyFluxMode(s);

        let workflowNodes;
        if (fluxMode) {
            // Flux/UNET-only workflow: separate UNETLoader + CLIP loader(s) + VAELoader
            const hasDualClip = !!(s.comfyFluxClipModel2 || "").trim();
            const clipType = (s.comfyFluxClipType || "flux").trim();
            const clipRef = clipSkip > 1 ? ["10", 0] : ["12", 0];
            workflowNodes = {
                "3": {
                    class_type: "KSampler",
                    inputs: {
                        seed: seed,
                        steps: s.steps,
                        cfg: s.cfgScale,
                        sampler_name: samplerName,
                        scheduler: schedulerName,
                        denoise: denoise,
                        model: ["11", 0],
                        positive: ["6", 0],
                        negative: ["6", 0],
                        latent_image: ["5", 0]
                    }
                },
                "5": { class_type: "EmptyLatentImage", inputs: { width: s.width, height: s.height, batch_size: 1 } },
                "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipRef } },
                "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["13", 0] } },
                "9": { class_type: "SaveImage", inputs: { filename_prefix: "qig", images: ["8", 0] } },
                "11": { class_type: "UNETLoader", inputs: { unet_name: s.localModel || "model.safetensors", weight_dtype: "default" } },
                "12": hasDualClip
                    ? { class_type: "DualCLIPLoader", inputs: { clip_name1: s.comfyFluxClipModel1, clip_name2: s.comfyFluxClipModel2, type: clipType } }
                    : { class_type: "CLIPLoader", inputs: { clip_name: s.comfyFluxClipModel1, type: clipType } },
                "13": { class_type: "VAELoader", inputs: { vae_name: s.comfyFluxVaeModel || "ae.safetensors" } }
            };
            if (clipSkip > 1) {
                workflowNodes["10"] = { class_type: "CLIPSetLastLayer", inputs: { stop_at_clip_layer: -clipSkip, clip: ["12", 0] } };
            }
            log(`ComfyUI: Using Flux/UNET workflow (UNETLoader + ${hasDualClip ? 'DualCLIPLoader' : 'CLIPLoader'} + VAELoader)`);
        } else {
            // Standard checkpoint workflow
            workflowNodes = {
                "3": {
                    class_type: "KSampler",
                    inputs: {
                        seed: seed,
                        steps: s.steps,
                        cfg: s.cfgScale,
                        sampler_name: samplerName,
                        scheduler: schedulerName,
                        denoise: denoise,
                        model: ["4", 0],
                        positive: ["6", 0],
                        negative: skipNeg ? ["6", 0] : ["7", 0],
                        latent_image: ["5", 0]
                    }
                },
                "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: s.localModel || "model.safetensors" } },
                "5": { class_type: "EmptyLatentImage", inputs: { width: s.width, height: s.height, batch_size: 1 } },
                "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipSkip > 1 ? ["10", 0] : ["4", 1] } },
                "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
                "9": { class_type: "SaveImage", inputs: { filename_prefix: "qig", images: ["8", 0] } }
            };
            if (!skipNeg) {
                workflowNodes["7"] = { class_type: "CLIPTextEncode", inputs: { text: negative, clip: clipSkip > 1 ? ["10", 0] : ["4", 1] } };
            }
            if (clipSkip > 1) {
                workflowNodes["10"] = { class_type: "CLIPSetLastLayer", inputs: { stop_at_clip_layer: -clipSkip, clip: ["4", 1] } };
            }
        }

        // LoRA injection for ComfyUI default workflow
        if (s.comfyLoras && s.comfyLoras.trim()) {
            let loraNodeStart = 20;
            let lastModelRef = fluxMode ? ["11", 0] : ["4", 0];
            let lastClipRef = fluxMode ? ["12", 0] : ["4", 1];
            const loras = s.comfyLoras.split(",").map(l => l.trim()).filter(l => l);
            let injectedCount = 0;
            loras.forEach((l, i) => {
                const lastColon = l.lastIndexOf(":");
                const hasWeight = lastColon > 0 && !isNaN(parseFloat(l.slice(lastColon + 1)));
                const name = (hasWeight ? l.slice(0, lastColon) : l).trim();
                const pw = hasWeight ? parseFloat(l.slice(lastColon + 1)) : NaN;
                const weight = isNaN(pw) ? 0.8 : pw;
                if (!name) return;
                injectedCount++;
                const nodeId = String(loraNodeStart + i);
                workflowNodes[nodeId] = {
                    class_type: "LoraLoader",
                    inputs: {
                        lora_name: name,
                        strength_model: weight,
                        strength_clip: weight,
                        model: lastModelRef,
                        clip: lastClipRef
                    }
                };
                lastModelRef = [nodeId, 0];
                lastClipRef = [nodeId, 1];
            });
            // Rewire KSampler model input
            workflowNodes["3"].inputs.model = lastModelRef;
            // Rewire CLIP inputs
            if (clipSkip > 1) {
                workflowNodes["10"].inputs.clip = lastClipRef;
            } else {
                workflowNodes["6"].inputs.clip = lastClipRef;
                if (workflowNodes["7"]) workflowNodes["7"].inputs.clip = lastClipRef;
            }
            log(`ComfyUI: Injected ${injectedCount} LoRA(s)`);
        }

        // img2img: swap EmptyLatentImage for LoadImage + VAEEncode when reference image present
        if (s.localRefImage && denoise < 1.0) {
            // Upload image to ComfyUI
            const imgData = s.localRefImage.replace(/^data:image\/.+;base64,/, '');
            const blob = await (await fetch(`data:image/png;base64,${imgData}`)).blob();
            const formData = new FormData();
            formData.append("image", blob, "qig_ref.png");
            formData.append("overwrite", "true");
            try {
                const uploadRes = await corsFetch(`${baseUrl}/upload/image`, {
                    method: "POST",
                    body: formData,
                    signal
                });
                if (uploadRes.ok) {
                    const uploadData = await uploadRes.json();
                    const uploadedName = uploadData.name || "qig_ref.png";

                    // Replace EmptyLatentImage (node 5) with LoadImage
                    workflowNodes["5"] = {
                        class_type: "LoadImage",
                        inputs: { image: uploadedName }
                    };
                    // Add VAEEncode node (node 15) to encode the loaded image to latent
                    const vaeRef = fluxMode ? ["13", 0] : ["4", 2];
                    workflowNodes["15"] = {
                        class_type: "VAEEncode",
                        inputs: { pixels: ["5", 0], vae: vaeRef }
                    };
                    // Rewire KSampler latent_image to VAEEncode output
                    workflowNodes["3"].inputs.latent_image = ["15", 0];
                    log(`ComfyUI: img2img mode — uploaded reference image as "${uploadedName}", denoise=${denoise}`);
                } else {
                    log(`ComfyUI: Failed to upload reference image (${uploadRes.status}), falling back to txt2img`);
                }
            } catch (uploadErr) {
                log(`ComfyUI: Image upload error: ${uploadErr.message}, falling back to txt2img`);
            }
        }

        // Upscale: inject UpscaleModelLoader + ImageUpscaleWithModel between VAEDecode and SaveImage
        if (s.comfyUpscale && s.comfyUpscaleModel) {
            workflowNodes["30"] = {
                class_type: "UpscaleModelLoader",
                inputs: { model_name: s.comfyUpscaleModel }
            };
            workflowNodes["31"] = {
                class_type: "ImageUpscaleWithModel",
                inputs: { upscale_model: ["30", 0], image: ["8", 0] }
            };
            // Rewire SaveImage to take upscaled output instead of VAEDecode
            workflowNodes["9"].inputs.images = ["31", 0];
            log(`ComfyUI: Upscale enabled with model=${s.comfyUpscaleModel}`);
        }

        log(`ComfyUI: sampler=${samplerName}, scheduler=${schedulerName}, steps=${s.steps}, cfg=${s.cfgScale}, seed=${seed}, denoise=${denoise}, clip_skip=${clipSkip}, size=${s.width}x${s.height}${s.localRefImage && denoise < 1.0 ? ', mode=img2img' : ''}${s.comfyUpscale ? ', upscale=' + s.comfyUpscaleModel : ''}`);

        const res = await corsFetch(`${baseUrl}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: workflowNodes }),
            signal
        });
        if (!res.ok) {
            let detail = "";
            try { const b = await res.json(); detail = b.error?.message || b.error || ""; } catch {}
            const hint403 = res.status === 403 ? " (Hint: ComfyUI-Manager's security check may be blocking this request. In ComfyUI-Manager settings, set Security Level to 'normal', then restart ComfyUI. Also ensure --enable-cors-header is set.)" : "";
            throw new Error(`ComfyUI error ${res.status}${detail ? ": " + detail : ""}${hint403}`);
        }
        const data = await res.json();
        // Poll for result - find any SaveImage output
        const promptId = data.prompt_id;
        return await waitForComfyImage(promptId);
    }

    // A1111 API
    const isImg2Img = s.localType === "a1111" && s.localRefImage && !s.a1111IpAdapter;
    const endpoint = isImg2Img ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";

    const payload = {
        prompt: prompt,
        negative_prompt: negative,
        width: s.width,
        height: s.height,
        steps: s.steps,
        cfg_scale: s.cfgScale,
        sampler_name: SAMPLER_DISPLAY_NAMES[s.sampler] || s.sampler,
        scheduler: s.a1111Scheduler || "Automatic",
        seed: s.seed
    };
    const controlNetUnits = [];

    // Restore Faces & Tiling
    if (s.a1111RestoreFaces) payload.restore_faces = true;
    if (s.a1111Tiling) payload.tiling = true;

    // Variation Seed / Subseed
    const subseedStrength = parseFloatOr(s.a1111SubseedStrength, 0);
    if (subseedStrength > 0) {
        payload.subseed = s.a1111Subseed ?? -1;
        payload.subseed_strength = subseedStrength;
    }

    // LoRA injection via A1111 prompt syntax
    if (s.a1111Loras && s.a1111Loras.trim()) {
        const loraTags = s.a1111Loras.split(",")
            .map(l => l.trim()).filter(l => l)
            .map(l => {
                const lastColon = l.lastIndexOf(":");
                const hasWeight = lastColon > 0 && !isNaN(parseFloat(l.slice(lastColon + 1)));
                const name = (hasWeight ? l.slice(0, lastColon) : l).trim();
                const pw = hasWeight ? parseFloat(l.slice(lastColon + 1)) : NaN;
                const weight = isNaN(pw) ? 0.8 : pw;
                if (!name) return null;
                return `<lora:${name}:${weight}>`;
            }).filter(Boolean).join(" ");
        if (loraTags) {
            payload.prompt = `${payload.prompt} ${loraTags}`;
            log(`A1111: Injected LoRAs: ${loraTags}`);
        }
    }

    // CLIP skip
    const clipSkip = parseIntOr(s.a1111ClipSkip, 1);
    if (clipSkip > 1) {
        payload.override_settings = payload.override_settings || {};
        payload.override_settings.CLIP_stop_at_last_layers = clipSkip;
    }

    // VAE override
    if (s.a1111Vae) {
        payload.override_settings = payload.override_settings || {};
        payload.override_settings.sd_vae = s.a1111Vae;
    }

    // Hires Fix (txt2img only)
    if (s.a1111HiresFix && !isImg2Img) {
        payload.enable_hr = true;
        payload.hr_upscaler = s.a1111HiresUpscaler || "Latent";
        payload.hr_scale = parseFloatOr(s.a1111HiresScale, 2);
        payload.hr_second_pass_steps = parseIntOr(s.a1111HiresSteps, 0);
        payload.denoising_strength = parseFloatOr(s.a1111HiresDenoise, 0.55);
        if (s.a1111HiresSampler) payload.hr_sampler_name = s.a1111HiresSampler;
        if (s.a1111HiresScheduler) payload.hr_scheduler = s.a1111HiresScheduler;
        if (s.a1111HiresPrompt) payload.hr_prompt = s.a1111HiresPrompt;
        if (s.a1111HiresNegative) payload.hr_negative_prompt = s.a1111HiresNegative;
        const hiresResizeX = parseIntOr(s.a1111HiresResizeX, 0);
        const hiresResizeY = parseIntOr(s.a1111HiresResizeY, 0);
        if (hiresResizeX > 0) payload.hr_resize_x = hiresResizeX;
        if (hiresResizeY > 0) payload.hr_resize_y = hiresResizeY;
        log(`A1111: Hires Fix: upscaler=${payload.hr_upscaler}, scale=${payload.hr_scale}, denoise=${payload.denoising_strength}${payload.hr_sampler_name ? ', sampler=' + payload.hr_sampler_name : ''}${payload.hr_scheduler ? ', scheduler=' + payload.hr_scheduler : ''}${hiresResizeX ? ', resize=' + hiresResizeX + 'x' + hiresResizeY : ''}`);
    }

    // ADetailer
    if (s.a1111Adetailer) {
        const buildADetailerUnit = (model, prompt, neg, denoise, confidence, maskBlur, dilateErode, inpaintOnly, inpaintPadding) => ({
            ad_model: model,
            ad_prompt: prompt || "",
            ad_negative_prompt: neg || "",
            ad_denoising_strength: parseFloat(denoise) ?? 0.4,
            ad_confidence: parseFloat(confidence) ?? 0.3,
            ad_mask_blur: parseInt(maskBlur) ?? 4,
            ad_dilate_erode: parseInt(dilateErode) ?? 4,
            ad_inpaint_only_masked: inpaintOnly ?? true,
            ad_inpaint_only_masked_padding: parseInt(inpaintPadding) ?? 32
        });

        payload.alwayson_scripts = payload.alwayson_scripts || {};
        const adUnit1 = buildADetailerUnit(
            s.a1111AdetailerModel || "face_yolov8n.pt",
            s.a1111AdetailerPrompt, s.a1111AdetailerNegative,
            s.a1111AdetailerDenoise, s.a1111AdetailerConfidence,
            s.a1111AdetailerMaskBlur, s.a1111AdetailerDilateErode,
            s.a1111AdetailerInpaintOnlyMasked, s.a1111AdetailerInpaintPadding
        );
        const adArgs = [true, adUnit1];

        if (s.a1111Adetailer2) {
            const adUnit2 = buildADetailerUnit(
                s.a1111Adetailer2Model || "hand_yolov8n.pt",
                s.a1111Adetailer2Prompt, s.a1111Adetailer2Negative,
                s.a1111Adetailer2Denoise, s.a1111Adetailer2Confidence,
                s.a1111Adetailer2MaskBlur, s.a1111Adetailer2DilateErode,
                s.a1111Adetailer2InpaintOnlyMasked, s.a1111Adetailer2InpaintPadding
            );
            adArgs.push(adUnit2);
        }

        payload.alwayson_scripts.ADetailer = { args: adArgs };
    }

    // Save to WebUI output folder
    if (s.a1111SaveToWebUI) {
        payload.save_images = true;
    }

    if (isImg2Img && !s.a1111IpAdapter) {
        // Standard img2img - use as init image
        payload.init_images = [s.localRefImage.replace(/^data:image\/.+;base64,/, '')];
        payload.denoising_strength = parseFloatOr(s.localDenoise, 0.75);
    }

    // IP-Adapter Face - use reference image for face only
    if (s.a1111IpAdapter && s.localRefImage) {
        // Determine correct preprocessor based on model type
        // Plus/Plus v2 variants need ip-adapter_face_id_plus, others use ip-adapter_face_id
        const ipAdapterModel = s.a1111IpAdapterMode || "ip-adapter-faceid-portrait_sd15";
        const ipAdapterPreprocessor = ipAdapterModel.toLowerCase().includes('plus')
            ? 'ip-adapter_face_id_plus'
            : 'ip-adapter_face_id';

        const imageData = s.localRefImage.replace(/^data:image\/.+;base64,/, '');

        // ControlNet unit configuration - use both 'image' and 'input_image' for compatibility
        // A1111 extension uses 'image', Forge Neo may use 'input_image'
        const controlNetUnit = {
            enabled: true,
            module: ipAdapterPreprocessor,
            model: ipAdapterModel,
            weight: parseFloatOr(s.a1111IpAdapterWeight, 0.7),
            image: imageData,
            input_image: imageData,  // Forge Neo compatibility
            resize_mode: s.a1111IpAdapterResizeMode || "Crop and Resize",
            control_mode: s.a1111IpAdapterControlMode || "Balanced",
            pixel_perfect: s.a1111IpAdapterPixelPerfect ?? true,
            guidance_start: parseFloatOr(s.a1111IpAdapterStartStep, 0),
            guidance_end: parseFloatOr(s.a1111IpAdapterEndStep, 1)
        };
        controlNetUnits.push(controlNetUnit);

        const logPayload = { ...controlNetUnit, image: "BASE64_TRUNCATED", input_image: "BASE64_TRUNCATED" };
        log(`A1111/Forge ControlNet Payload: ${JSON.stringify(logPayload)}`);
        log(`A1111/Forge: Using IP-Adapter Face with preprocessor=${ipAdapterPreprocessor}, model=${ipAdapterModel}, weight=${s.a1111IpAdapterWeight}`);
    }

    // Generic ControlNet
    if (s.a1111ControlNet && s.a1111ControlNetModel) {
        const cnUnit = {
            enabled: true,
            module: s.a1111ControlNetModule || "none",
            model: s.a1111ControlNetModel,
            weight: parseFloatOr(s.a1111ControlNetWeight, 1.0),
            resize_mode: s.a1111ControlNetResizeMode || "Crop and Resize",
            control_mode: s.a1111ControlNetControlMode || "Balanced",
            pixel_perfect: s.a1111ControlNetPixelPerfect ?? true,
            guidance_start: parseFloatOr(s.a1111ControlNetGuidanceStart, 0),
            guidance_end: parseFloatOr(s.a1111ControlNetGuidanceEnd, 1)
        };
        if (s.a1111ControlNetImage) {
            const cnImageData = s.a1111ControlNetImage.replace(/^data:image\/.+;base64,/, '');
            cnUnit.image = cnImageData;
            cnUnit.input_image = cnImageData;
        }
        controlNetUnits.push(cnUnit);
        log(`A1111: Generic ControlNet: model=${s.a1111ControlNetModel}, module=${cnUnit.module}, weight=${cnUnit.weight}, image=${s.a1111ControlNetImage ? 'yes' : 'no'}`);
    }
    if (controlNetUnits.length > 0) {
        payload.alwayson_scripts = payload.alwayson_scripts || {};
        payload.alwayson_scripts[a1111ControlNetScriptKey] = { args: controlNetUnits };
    }

    log(`A1111: steps=${s.steps}, cfg=${s.cfgScale}, clip_skip=${clipSkip}, loras=${s.a1111Loras || 'none'}, hires=${s.a1111HiresFix && !isImg2Img ? 'on' : 'off'}, adetailer=${s.a1111Adetailer ? 'on' : 'off'}, ip-adapter=${s.a1111IpAdapter && s.localRefImage ? 'on' : 'off'}, controlnet=${s.a1111ControlNet ? 'on' : 'off'}`);

    // Start progress polling
    let progressInterval = null;
    progressInterval = setInterval(async () => {
        try {
            const pr = await corsFetch(`${baseUrl}/sdapi/v1/progress`);
            if (pr.ok) {
                const p = await pr.json();
                if (p.progress > 0 && p.progress < 1) {
                    const pct = Math.round(p.progress * 100);
                    const step = p.state?.sampling_step !== undefined
                        ? ` | Step ${p.state.sampling_step}/${p.state.sampling_steps}` : "";
                    const eta = p.eta_relative ? ` | ~${Math.round(p.eta_relative)}s left` : "";
                    showStatus(`Generating... ${pct}%${step}${eta}`);
                }
            }
        } catch { /* ignore polling errors */ }
    }, 500);

    const getAlternateControlNetScriptKey = (key) => key === "ControlNet" ? "sd_forge_controlnet" : "ControlNet";
    const parseA1111ErrorDetail = async (res) => {
        try {
            const data = await res.json();
            if (typeof data?.detail === "string") return data.detail;
            if (typeof data?.error === "string") return data.error;
            return JSON.stringify(data);
        } catch {
            try { return await res.text(); } catch { return ""; }
        }
    };
    const postA1111 = async (requestPayload) => corsFetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal
    });

    try {
        let requestPayload = payload;
        let res = await postA1111(requestPayload);
        if (!res.ok && controlNetUnits.length > 0 && res.status === 422) {
            const detail = await parseA1111ErrorDetail(res);
            const missingCurrentScript = new RegExp(`always on script ${a1111ControlNetScriptKey} not found`, "i");
            if (missingCurrentScript.test(detail)) {
                const fallbackKey = getAlternateControlNetScriptKey(a1111ControlNetScriptKey);
                log(`A1111: Script "${a1111ControlNetScriptKey}" not found, retrying ControlNet payload as "${fallbackKey}"`);
                const retryPayload = JSON.parse(JSON.stringify(requestPayload));
                const scriptData = retryPayload?.alwayson_scripts?.[a1111ControlNetScriptKey];
                delete retryPayload?.alwayson_scripts?.[a1111ControlNetScriptKey];
                if (scriptData) {
                    retryPayload.alwayson_scripts[fallbackKey] = scriptData;
                    const retryRes = await postA1111(retryPayload);
                    if (retryRes.ok) {
                        a1111ControlNetScriptKey = fallbackKey;
                        res = retryRes;
                        requestPayload = retryPayload;
                    } else {
                        const retryDetail = await parseA1111ErrorDetail(retryRes);
                        throw new Error(`A1111 error: ${retryRes.status}${retryDetail ? `: ${retryDetail}` : ""}`);
                    }
                }
            }
        }
        if (!res.ok) {
            const detail = await parseA1111ErrorDetail(res);
            throw new Error(`A1111 error: ${res.status}${detail ? `: ${detail}` : ""}`);
        }
        const data = await res.json();
        if (data.images?.[0]) return `data:image/png;base64,${data.images[0]}`;
        throw new Error("No image in response");
    } finally {
        if (progressInterval) clearInterval(progressInterval);
    }
}

async function genProxy(prompt, negative, s, signal, options = {}) {
    // ComfyUI Proxy mode — simple GET /prompt/{text}?token=xxx → PNG
    if (s.proxyComfyMode) {
        const baseUrl = s.proxyUrl.replace(/\/$/, "");
        const params = new URLSearchParams();
        if (s.proxyKey) params.set("token", s.proxyKey);
        if (s.proxyComfyNodeId) params.set("node_id", s.proxyComfyNodeId);
        const qs = params.toString() ? `?${params.toString()}` : "";

        // If workflow JSON is provided, use POST with body
        const hasWorkflow = s.proxyComfyWorkflow && s.proxyComfyWorkflow.trim();
        const url = `${baseUrl}/prompt/${encodeURIComponent(prompt)}${qs}`;
        log(`ComfyUI Proxy: ${url.substring(0, 80)}...`);

        const controller = new AbortController();
        let timedOut = false;
        const timeout = (s.proxyComfyTimeout || 300) * 1000;
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
        if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

        const fetchOpts = { signal: controller.signal };
        if (hasWorkflow) {
            fetchOpts.method = "POST";
            fetchOpts.headers = { "Content-Type": "application/json" };
            fetchOpts.body = s.proxyComfyWorkflow.trim();
        }

        let res;
        try {
            res = await fetch(url, fetchOpts);
        } catch (e) {
            if (e.name === "AbortError" && timedOut && !signal?.aborted) {
                throw new Error(`ComfyUI Proxy timed out after ${s.proxyComfyTimeout}s`);
            }
            throw e;
        } finally {
            clearTimeout(timeoutId);
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`ComfyUI Proxy error ${res.status}: ${errText || res.statusText}`);
        }
        const blob = new Blob([await res.arrayBuffer()], { type: res.headers.get("content-type") || "image/png" });
        const blobUrl = URL.createObjectURL(blob);
        blobUrls.add(blobUrl);
        return blobUrl;
    }

    const headers = { "Content-Type": "application/json" };
    if (s.proxyKey) headers["Authorization"] = `Bearer ${s.proxyKey}`;

    const endpointMode = resolveProxyEndpointMode(s.proxyUrl, s);
    const payloadMode = normalizeProxyPayloadSetting(s.proxyPayloadMode);
    const refMode = normalizeProxyRefImageSetting(s.proxyRefImageMode);
    const requestUrl = resolveProxyRequestUrl(s.proxyUrl, endpointMode);
    const proxySeed = resolveRandomSeed(s.proxySeed, s);
    const manualRefImages = normalizeProxyRefImages(s.proxyRefImages || [], refMode);
    const runtimeRefImages = normalizeProxyRuntimeRefImages(options?.proxyRefImages || []);
    const refImages = mergeProxyRefImages(manualRefImages, runtimeRefImages);
    const sseEnabled = endpointMode === "images_generations" ? shouldUseProxySse(s, payloadMode) : false;

    if (!requestUrl) throw new Error("Proxy URL is required");
    log(`Proxy mode: endpoint=${endpointMode}, payload=${payloadMode}, refMode=${refMode}, sse=${sseEnabled}, refImages=${refImages.length}, runtimeRefs=${runtimeRefImages.length}, url=${requestUrl.substring(0, 80)}`);

    const controller = new AbortController();
    let timedOut = false;
    const proxyTimeoutSeconds = Math.max(30, Math.min(1800, parseIntOr(s.proxyTimeout, 600)));
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, proxyTimeoutSeconds * 1000);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

    let res;
    try {
        const payload = endpointMode === "chat_completions"
            ? buildProxyChatPayload(prompt, negative, s, refImages, payloadMode, proxySeed)
            : buildProxyImagesPayload(prompt, negative, s, refImages, payloadMode, proxySeed, sseEnabled);
        log(`${endpointMode === "chat_completions" ? "Chat" : "Images"} endpoint payload keys: ${Object.keys(payload).join(", ")}`);
        res = await fetch(requestUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (e) {
        if (e.name === "AbortError" && timedOut && !signal?.aborted) {
            throw new Error(`Proxy request timed out after ${proxyTimeoutSeconds} seconds`);
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        const detail = await readProxyErrorResponse(res);
        throw new Error(`Proxy error ${res.status}: ${detail || res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (endpointMode === "images_generations" && (contentType.includes("text/event-stream") || contentType.includes("text/plain"))) {
        log(`Parsing ${contentType.includes("text/event-stream") ? "SSE" : "text"} response`);
        const text = await res.text();
        const direct = extractProxyImageFromString(text);
        if (direct) return direct;
        const streamed = extractProxyImageFromSseText(text);
        if (streamed) return streamed;
        try {
            const parsed = JSON.parse(text);
            const parsedImage = extractProxyImageFromJson(parsed);
            if (parsedImage) return parsedImage;
        } catch {
            // Not JSON; continue to error below.
        }
        throw new Error(`No image in ${contentType.includes("text/event-stream") ? "SSE" : "text"} response`);
    }

    const data = await res.json();
    log(`Response keys: ${JSON.stringify(Object.keys(data || {}))}`);
    const imageUrl = extractProxyImageFromJson(data);
    if (imageUrl) return imageUrl;

    if (endpointMode === "chat_completions") {
        log(`Full message structure: ${JSON.stringify(data?.choices?.[0]?.message || {}).substring(0, 500)}`);
        const msgContent = data?.choices?.[0]?.message?.content;
        throw new Error(msgContent === null
            ? "Model returned empty response - image generation may not be supported via this proxy"
            : "No image in response");
    }

    throw new Error("No image in response");
}

let resizeAbortController = null;

function initResizeHandle(popup) {
    if (resizeAbortController) resizeAbortController.abort();
    resizeAbortController = new AbortController();
    const signal = resizeAbortController.signal;

    const handle = popup.querySelector('.qig-resize-handle');
    if (!handle) return;

    const content = popup.querySelector('.qig-popup-content');

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = content.offsetWidth;
        const startHeight = content.offsetHeight;

        popup.classList.add('qig-resizing');

        const onMouseMove = (e) => {
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            const newWidth = Math.max(300, startWidth + deltaX * 2);
            const newHeight = Math.max(200, startHeight + deltaY);
            content.style.maxWidth = newWidth + 'px';
            content.style.width = newWidth + 'px';
            content.style.maxHeight = newHeight + 'px';
        };

        const onMouseUp = () => {
            popup.classList.remove('qig-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }, { signal });
}

function bindPopupDismiss(popup, onClose, { closeOnBackdrop = true } = {}) {
    if (!popup) return;
    const contentEl = popup.querySelector(".qig-popup-content");
    const stopBubble = (e) => {
        e?.stopPropagation?.();
    };
    const stopClick = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
    };

    if (contentEl) {
        contentEl.onpointerdown = stopBubble;
        contentEl.onmousedown = stopBubble;
        contentEl.onclick = stopBubble;
    }

    popup.onpointerdown = (e) => {
        if (e.target === popup) stopBubble(e);
    };
    popup.onmousedown = (e) => {
        if (e.target === popup) stopBubble(e);
    };
    popup.onclick = (e) => {
        if (e.target !== popup) return;
        stopClick(e);
        if (closeOnBackdrop) onClose?.(e);
    };

    const popupCloseBtn = popup.querySelector(".qig-close-btn");
    if (popupCloseBtn) {
        popupCloseBtn.onclick = (e) => {
            stopClick(e);
            onClose?.(e);
        };
    }
}

function createPopup(id, title, content, onShow, options = {}) {
    let popup = document.getElementById(id);
    if (!popup) {
        popup = document.createElement("div");
        popup.id = id;
        popup.className = "qig-popup";
        popup.style.cssText = "display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.95);z-index:2147483647;justify-content:center;align-items:center;";
        document.body.appendChild(popup);
    }
    const popupClass = options.popupClass ? ` qig-popup--${options.popupClass}` : "";
    const contentClass = options.contentClass ? ` ${options.contentClass}` : "";
    const resizeHandleHtml = options.resizable === false ? "" : `<div class="qig-resize-handle"></div>`;
    popup.className = `qig-popup${popupClass}`;
    // ALWAYS update innerHTML to ensure fresh content each time
    popup.innerHTML = `
        <div class="qig-popup-content${contentClass}">
            <div class="qig-popup-header">
                <span>${title}</span>
                <button class="qig-close-btn">✕</button>
            </div>
            ${content}
            ${resizeHandleHtml}
        </div>`;
    const closePopup = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        setTimeout(() => { popup.style.display = "none"; }, 0);
    };
    bindPopupDismiss(popup, closePopup, { closeOnBackdrop: options.closeOnBackdrop !== false });
    if (onShow) onShow(popup);
    popup.style.display = "flex";
    return popup;
}

function showLogs() {
    createPopup("qig-logs-popup", "Generation Logs", `<pre id="qig-logs-content"></pre>`, (popup) => {
        document.getElementById("qig-logs-content").textContent = logs.join("\n") || "No logs yet";
    });
}

function showPromptHistory() {
    createPopup("qig-prompt-history-popup", "Prompt History", `<div id="qig-prompt-history-content"></div>`, (popup) => {
        const container = document.getElementById("qig-prompt-history-content");
        if (!promptHistory.length) {
            container.innerHTML = '<p style="color:#888;">No prompts yet</p>';
            return;
        }
        container.innerHTML = `<div style="text-align:right;margin-bottom:8px;"><button id="qig-clear-history" class="menu_button" style="padding:2px 8px;font-size:11px;">Clear History</button></div>` +
        promptHistory.map((entry, i) => `
            <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="color:#e94560;font-size:12px;">#${promptHistory.length - i} - ${entry.time}</span>
                    <button class="qig-copy-prompt" data-index="${i}" style="background:#333;border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Copy</button>
                </div>
                <pre style="white-space:pre-wrap;word-break:break-word;color:#ddd;margin:0;font-size:13px;">${escapeHtml(entry.prompt)}</pre>
                ${entry.negative ? `<pre style="white-space:pre-wrap;word-break:break-word;color:#888;margin:6px 0 0;font-size:12px;">Negative: ${escapeHtml(entry.negative)}</pre>` : ''}
            </div>
        `).join('');
        container.querySelectorAll(".qig-copy-prompt").forEach((btn) => {
            btn.onclick = async () => {
                const idx = parseInt(btn.dataset.index, 10);
                const entry = promptHistory[idx];
                if (!entry) return;
                try {
                    await navigator.clipboard.writeText(entry.prompt || "");
                    toastr?.success?.("Prompt copied");
                } catch (e) {
                    log(`Prompt copy failed: ${e.message}`);
                    toastr?.error?.("Failed to copy prompt");
                }
            };
        });

        document.getElementById("qig-clear-history").onclick = () => {
            if (confirm("Clear all prompt history?")) {
                promptHistory = [];
                localStorage.removeItem("qig_prompt_history");
                container.innerHTML = '<p style="color:#888;">No prompts yet</p>';
            }
        };
    });
}

async function blobUrlToDataUrl(blobUrl) {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function isUrlBasedImageSource(url) {
    const source = String(url || "").trim();
    return !!source && !source.startsWith("data:") && !source.startsWith("blob:");
}

function toAbsoluteImageUrl(url) {
    const source = String(url || "").trim();
    if (!source) return "";
    try {
        return new URL(source, window.location?.origin || window.location?.href || "http://localhost/").href;
    } catch {
        return source;
    }
}

async function resolveChatInsertImageUrl(entryOrUrl) {
    const entry = normalizeGenerationEntry(entryOrUrl);
    if (normalizeOutputMode(getSettings()?.outputMode) !== "image_url") {
        return entry.url;
    }

    const candidateUrl = entry.sourceUrl || entry.url;
    if (isUrlBasedImageSource(candidateUrl)) {
        return toAbsoluteImageUrl(candidateUrl);
    }
    if (isUrlBasedImageSource(entry.url)) {
        return toAbsoluteImageUrl(entry.url);
    }
    if (typeof saveBase64AsFile !== "function") {
        throw new Error("image_url output requires SillyTavern file saving support");
    }

    const savedUrl = await saveImageToServer(entry.url, entry.prompt, entry.negative, {
        ...cloneMetadataSettings(entry.metadataSettings || {}),
        saveToServer: true,
    });
    if (!isUrlBasedImageSource(savedUrl)) {
        throw new Error("Failed to create a server image URL");
    }
    entry.sourceUrl = savedUrl;
    return toAbsoluteImageUrl(savedUrl);
}

function toCssImageUrl(url) {
    const escaped = String(url || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[\r\n]/g, "");
    return `url("${escaped}")`;
}

function isSameOriginImageUrl(url) {
    const source = String(url || "").trim();
    if (!source || source.startsWith("data:") || source.startsWith("blob:")) return false;
    try {
        const parsed = new URL(source, window.location?.href || "http://localhost/");
        return parsed.origin === (window.location?.origin || parsed.origin);
    } catch {
        return !/^https?:/i.test(source);
    }
}

async function resolveBackgroundImageUrl(entryOrUrl, mode) {
    const entry = normalizeGenerationEntry(entryOrUrl);
    if (!entry.url && !entry.sourceUrl) throw new Error("No generated image URL available");

    if (normalizeBackgroundMode(mode) !== "locked") {
        let url = String(entry.url || entry.sourceUrl || "");
        if (url.startsWith("blob:")) url = await blobUrlToDataUrl(url);
        return { url: isUrlBasedImageSource(url) ? toAbsoluteImageUrl(url) : url, path: "" };
    }

    const stableCandidate = entry.url || entry.sourceUrl;
    if (isSameOriginImageUrl(stableCandidate)) {
        return { url: toAbsoluteImageUrl(stableCandidate), path: stableCandidate };
    }

    if (typeof saveBase64AsFile !== "function") {
        if (isUrlBasedImageSource(stableCandidate)) return { url: toAbsoluteImageUrl(stableCandidate), path: "" };
        throw new Error("Locked backgrounds require SillyTavern file saving support");
    }

    const saveCandidate = entry.url && !isUrlBasedImageSource(entry.url) ? entry.url : (entry.sourceUrl || entry.url);
    const savedUrl = await saveImageToServer(saveCandidate, entry.prompt, entry.negative, {
        ...cloneMetadataSettings(entry.metadataSettings || {}),
        saveToServer: true,
    });
    if (!isUrlBasedImageSource(savedUrl)) throw new Error("Failed to create a server image URL");

    if (entryOrUrl && typeof entryOrUrl === "object") {
        entryOrUrl.sourceUrl = savedUrl;
        if (!isUrlBasedImageSource(entryOrUrl.url)) entryOrUrl.url = savedUrl;
    }
    return { url: toAbsoluteImageUrl(savedUrl), path: savedUrl };
}

function applyBackgroundCss(cssUrl) {
    const bg = document.getElementById("bg1");
    if (bg) {
        bg.style.backgroundImage = cssUrl;
        return true;
    }
    if (typeof $ === "function") {
        const bgEl = $("#bg1");
        if (bgEl.length) {
            bgEl.css("background-image", cssUrl);
            return true;
        }
    }
    return false;
}

async function saveLockedBackgroundMetadata(cssUrl, path) {
    const ctx = getContext?.();
    if (!ctx?.chatMetadata) throw new Error("No active chat metadata available");

    ctx.chatMetadata.custom_background = cssUrl;
    if (path) {
        const list = Array.isArray(ctx.chatMetadata.chat_backgrounds) ? [...ctx.chatMetadata.chat_backgrounds] : [];
        if (!list.includes(path)) list.push(path);
        ctx.chatMetadata.chat_backgrounds = list;
    }

    if (typeof ctx.saveMetadataDebounced === "function") {
        ctx.saveMetadataDebounced();
    } else if (typeof ctx.saveMetadata === "function") {
        await ctx.saveMetadata();
    }
}

async function setImageAsBackground(entryOrUrl, mode = getSettings()?.backgroundMode, options = {}) {
    const normalizedMode = normalizeBackgroundMode(mode);
    const { url, path } = await resolveBackgroundImageUrl(entryOrUrl, normalizedMode);
    const cssUrl = toCssImageUrl(url);

    if (!applyBackgroundCss(cssUrl)) throw new Error("Could not find SillyTavern background element");
    if (normalizedMode === "locked") await saveLockedBackgroundMetadata(cssUrl, path);

    const modeLabel = normalizedMode === "locked" ? "locked chat" : "temporary";
    log(`Set generated image as ${modeLabel} background`);
    if (!options.silent) toastr?.success?.(`Image set as ${modeLabel} background`);
}

async function maybeAutoSetBackground(results, settings = getSettings()) {
    if (!settings?.autoSetBackground) return;
    const entry = Array.isArray(results) ? results[0] : results;
    if (!entry) return;
    try {
        await setImageAsBackground(entry, settings.backgroundMode, { silent: true });
    } catch (e) {
        log(`Auto background failed: ${e.message}`);
        toastr?.warning?.(`Auto background failed: ${e.message}`, "Image Gen", { timeOut: 5000 });
    }
}

async function insertImageIntoMessage(entryOrUrl, targetMessageIndex = null) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) throw new Error("No messages in chat");

    const entry = normalizeGenerationEntry(entryOrUrl);
    const s = getSettings();
    const fallbackIdx = resolveManualInsertFallbackIndex(chat, s);
    const preferredEntryIdx = clampChatMessageIndex(entry.sourceMessageIndex, chat.length);
    const resolvedTargetIdx = clampChatMessageIndex(targetMessageIndex, chat.length);
    const idx = Number.isInteger(resolvedTargetIdx)
        ? resolvedTargetIdx
        : (Number.isInteger(preferredEntryIdx) ? preferredEntryIdx : fallbackIdx);
    const message = chat[idx];
    if (!message) throw new Error("Could not find target message");

    let url = await resolveChatInsertImageUrl(entry);
    if (url.startsWith('blob:')) {
        url = await blobUrlToDataUrl(url);
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    const title = entry.prompt || lastPrompt || 'Generated Image';

    // Use modern media API if available
    if (typeof ctx.appendMediaToMessage === 'function') {
        if (!Array.isArray(message.extra.media)) {
            message.extra.media = [];
        }
        if (!message.extra.media.length && !message.extra.media_display) {
            message.extra.media_display = 'gallery';
        }

        message.extra.media.push({
            url: url,
            type: 'image',
            title: title,
            source: 'generated',
        });
        message.extra.inline_image = true;
        message.extra.media_index = message.extra.media.length - 1;

        const messageElement = $(`.mes[mesid="${idx}"]`);
        if (messageElement.length) {
            ctx.appendMediaToMessage(message, messageElement, 'replace');
        }
    } else {
        // Legacy fallback for older ST versions
        message.extra.image = url;
        message.extra.inline_image = true;
        message.extra.title = title;
    }

    await ctx.saveChat();
}

async function insertImageAsNewMessage(entryOrUrl) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat) throw new Error("No active chat");

    const entry = normalizeGenerationEntry(entryOrUrl);
    let url = await resolveChatInsertImageUrl(entry);
    if (url.startsWith('blob:')) {
        url = await blobUrlToDataUrl(url);
    }

    const title = entry.prompt || lastPrompt || 'Generated Image';
    const message = {
        name: ctx.name2 || "Assistant",
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: "",
        extra: {
            media: [{ url, type: 'image', title, source: 'generated' }],
            media_display: 'gallery',
            media_index: 0,
            inline_image: true,
        },
    };

    chat.push(message);
    if (typeof ctx.addOneMessage === 'function') {
        ctx.addOneMessage(message);
    }
    await ctx.saveChat();
}

async function insertImageAsHiddenReply(entryOrUrl) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat) throw new Error("No active chat");

    const entry = normalizeGenerationEntry(entryOrUrl);
    let url = await resolveChatInsertImageUrl(entry);
    if (url.startsWith('blob:')) {
        url = await blobUrlToDataUrl(url);
    }

    const title = entry.prompt || lastPrompt || 'Generated Image';
    const message = {
        name: ctx.name2 || "Assistant",
        is_user: false,
        is_system: true,
        send_date: new Date().toISOString(),
        mes: "",
        extra: {
            media: [{ url, type: 'image', title, source: 'generated' }],
            media_display: 'gallery',
            media_index: 0,
            inline_image: true,
        },
    };

    chat.push(message);
    if (typeof ctx.addOneMessage === 'function') {
        ctx.addOneMessage(message);
    }
    await ctx.saveChat();
}

async function autoInsertInjectImage(entryOrUrl, { messageIndex, insertMode } = {}) {
    const mode = insertMode || "replace";
    if (mode === "hidden") return await insertImageAsHiddenReply(entryOrUrl);
    if (mode === "new") {
        return await insertImageAsNewMessage(entryOrUrl);
    }
    if (mode === "replace" && Number.isInteger(messageIndex)) {
        return await insertImageIntoMessage(entryOrUrl, messageIndex);
    }
    return await insertImageIntoMessage(entryOrUrl);
}

function shouldPersistImageUrl(url) {
    const source = String(url || "");
    if (!source || source.startsWith("data:")) return false;
    if (source.startsWith("blob:")) return true;

    try {
        const parsed = new URL(source, window.location?.href || "http://localhost/");
        if (!/^https?:$/i.test(parsed.protocol)) return false;
        return parsed.origin !== (window.location?.origin || parsed.origin);
    } catch {
        return /^https?:/i.test(source);
    }
}

async function persistImageUrl(url) {
    if (!shouldPersistImageUrl(url)) return url;
    try {
        const { buffer, contentType } = await fetchImageBuffer(url);
        const formatInfo = detectImageFormat(buffer, contentType, url);
        return `data:${formatInfo.mime};base64,${arrayBufferToBase64(buffer)}`;
    } catch {
        return url;
    }
}

function createThumbnail(url, maxSize = 150) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.7));
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

function cloneMetadataSettings(settings) {
    try {
        return JSON.parse(JSON.stringify(settings || {}));
    } catch {
        return { ...(settings || {}) };
    }
}

function createGenerationEntry(url, prompt = lastPrompt, negative = lastNegative, metadataSettings = null, options = {}) {
    const snapshot = cloneMetadataSettings(metadataSettings || {});
    const provider = options.provider || snapshot.provider || getSettings()?.provider || "";
    if (provider && !snapshot.provider) snapshot.provider = provider;
    return {
        url,
        sourceUrl: options.sourceUrl ?? url,
        sourceMessageIndex: Number.isInteger(options.sourceMessageIndex) ? options.sourceMessageIndex : null,
        thumbnail: options.thumbnail ?? null,
        prompt: prompt || "",
        negative: negative || "",
        provider,
        metadataSettings: snapshot,
        promptWasLLM: options.promptWasLLM ?? lastPromptWasLLM,
        date: options.date ?? Date.now(),
    };
}

function normalizeGenerationEntry(entryOrUrl, fallback = {}) {
    if (typeof entryOrUrl === "string") {
        return createGenerationEntry(entryOrUrl, fallback.prompt, fallback.negative, fallback.metadataSettings, fallback);
    }
    if (!entryOrUrl || typeof entryOrUrl !== "object") {
        return createGenerationEntry("", fallback.prompt, fallback.negative, fallback.metadataSettings, fallback);
    }
    const snapshot = cloneMetadataSettings(entryOrUrl.metadataSettings || fallback.metadataSettings || {});
    const provider = entryOrUrl.provider || snapshot.provider || fallback.provider || getSettings()?.provider || "";
    if (provider && !snapshot.provider) snapshot.provider = provider;
    return {
        ...entryOrUrl,
        sourceUrl: entryOrUrl.sourceUrl ?? fallback.sourceUrl ?? entryOrUrl.url ?? fallback.url ?? "",
        sourceMessageIndex: Number.isInteger(entryOrUrl.sourceMessageIndex)
            ? entryOrUrl.sourceMessageIndex
            : (Number.isInteger(fallback.sourceMessageIndex) ? fallback.sourceMessageIndex : null),
        prompt: entryOrUrl.prompt ?? fallback.prompt ?? "",
        negative: entryOrUrl.negative ?? fallback.negative ?? "",
        provider,
        metadataSettings: snapshot,
        promptWasLLM: entryOrUrl.promptWasLLM ?? fallback.promptWasLLM ?? false,
        date: entryOrUrl.date ?? fallback.date ?? Date.now(),
    };
}

async function finalizeGeneratedEntry(rawUrl, prompt, negative, settings, options = {}) {
    const resolvedSeed = settings && Number.isFinite(settings.__qigResolvedSeed) ? settings.__qigResolvedSeed : undefined;
    if (settings && Object.prototype.hasOwnProperty.call(settings, "__qigResolvedSeed")) {
        delete settings.__qigResolvedSeed;
    }
    const metadataSettings = getMetadataSettings(settings, { resolvedSeed });
    const finalUrl = await maybeFinalizeUrl(rawUrl, prompt, negative, metadataSettings);
    if (!finalUrl) return null;
    const stableUrl = metadataSettings.saveToServer ? finalUrl : await persistImageUrl(finalUrl);
    return createGenerationEntry(stableUrl, prompt, negative, metadataSettings, { ...options, sourceUrl: finalUrl });
}

async function addToGallery(entryOrUrl) {
    const entry = normalizeGenerationEntry(entryOrUrl);
    if (!entry.url) return null;
    const persistentUrl = await persistImageUrl(entry.url);
    const thumbnail = await createThumbnail(persistentUrl);
    const savedEntry = { ...entry, url: persistentUrl, thumbnail, date: entry.date ?? Date.now() };
    sessionGallery.unshift(savedEntry);
    if (sessionGallery.length > 50) sessionGallery.pop();
    saveGallery();
    return savedEntry;
}

function normalizeGalleryImportUrl(rawUrl) {
    const source = String(rawUrl || "").trim();
    if (!source) return "";
    if (isDataImageUrl(source) || source.startsWith("blob:")) return source;

    const absoluteUrl = toAbsoluteImageUrl(source);
    return isHttpUrl(absoluteUrl) ? absoluteUrl : "";
}

function createImportedImageEntry(url) {
    return normalizeGenerationEntry({
        url,
        sourceUrl: "",
        prompt: "Imported Image",
        negative: "",
        provider: getSettings()?.provider || "",
        promptWasLLM: false,
        date: Date.now(),
    });
}

async function importImageUrlToGallery(rawUrl, { insert = false } = {}) {
    const normalizedUrl = normalizeGalleryImportUrl(rawUrl);
    if (!normalizedUrl) {
        throw new Error("Enter a valid image URL or data URL");
    }

    const savedEntry = await addToGallery(createImportedImageEntry(normalizedUrl));
    if (!savedEntry) {
        throw new Error("Failed to import image URL");
    }

    if (insert) {
        const s = getSettings();
        if (s.insertAsHiddenReply) {
            await insertImageAsHiddenReply(savedEntry);
        } else {
            await insertImageIntoMessage(savedEntry);
        }
    }

    return savedEntry;
}

function saveGallery() {
    try {
        localStorage.setItem("qig_gallery", JSON.stringify(sessionGallery));
    } catch (e) {
        // Quota exceeded — trim oldest entries and retry
        while (sessionGallery.length > 5) {
            sessionGallery.pop();
            try { localStorage.setItem("qig_gallery", JSON.stringify(sessionGallery)); return; } catch {}
        }
    }
}

function savePromptHistory() {
    try {
        localStorage.setItem("qig_prompt_history", JSON.stringify(promptHistory));
    } catch {
        while (promptHistory.length > 10) {
            promptHistory.pop();
            try { localStorage.setItem("qig_prompt_history", JSON.stringify(promptHistory)); return; } catch {}
        }
    }
}

function displayImage(entryOrUrl, skipGallery) {
    const entry = normalizeGenerationEntry(entryOrUrl);
    if (!entry.url) return;
    if (!skipGallery) addToGallery(entry);
    const popupInsertTargetIndex = Number.isInteger(entry.sourceMessageIndex)
        ? entry.sourceMessageIndex
        : (!skipGallery && Number.isInteger(lastGenerationSourceMessageIndex) ? lastGenerationSourceMessageIndex : null);

    const imagePrompt = entry.prompt || "";
    const imageNegative = entry.negative || "";
    const imagePromptWasLLM = !!entry.promptWasLLM;
    const imageMetadataSettings = cloneMetadataSettings(entry.metadataSettings || {});

    const popup = createPopup("qig-popup", "Generated Image", `
        <img id="qig-result-img" src="">
        <button id="qig-toggle-prompt-editor" style="width: calc(100% - 32px); margin: 8px 16px; padding: 6px; background: var(--SmartThemeBlurTintColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; cursor: pointer; font-size: 11px;">
            ✏️ Edit Prompt
        </button>
        <div class="qig-prompt-editor" style="display:none;">
            <div style="padding: 8px 16px;">
                <span id="qig-prompt-source-label" style="font-size: 10px; opacity: 0.7; display: block; margin-bottom: 4px;"></span>
                <label style="font-size: 11px; color: var(--SmartThemeBodyColor); display: block; margin-bottom: 4px;">Prompt:</label>
                <textarea id="qig-preview-prompt" style="width: 100%; height: 80px; resize: vertical; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 8px; font-size: 12px; font-family: monospace;"></textarea>
                <label style="font-size: 11px; color: var(--SmartThemeBodyColor); display: block; margin: 8px 0 4px;">Negative Prompt:</label>
                <textarea id="qig-preview-negative" style="width: 100%; height: 60px; resize: vertical; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 8px; font-size: 12px; font-family: monospace;"></textarea>
                <div style="display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end;">
                    <button id="qig-reset-prompt" class="menu_button" style="padding: 4px 10px; font-size: 11px;">Reset to Original</button>
                </div>
            </div>
        </div>
        <div class="qig-popup-actions">
            <button id="qig-regenerate-btn" title="Generate a new image with the same settings">🔄 Regenerate</button>
            <button id="qig-use-as-ref" title="Use this image as reference for img2img">🖼 Use as Reference</button>
            <button id="qig-insert-btn" title="Insert this image into the chat">📌 Insert</button>
            <button id="qig-background-btn" title="Set this image as the current chat background">🖼 Background</button>
            <button id="qig-gallery-btn" title="Save to gallery">🖼️ Gallery</button>
            <button id="qig-download-btn" title="Download image with metadata">💾 Download</button>
            <button id="qig-close-popup" title="Close without inserting">Close</button>
        </div>`, (popup) => {
        // Reset any previous inline resize styles
        const content = popup.querySelector('.qig-popup-content');
        if (content) {
            content.style.maxWidth = '';
            content.style.width = '';
            content.style.maxHeight = '';
        }
        initResizeHandle(popup);

        // Initialize prompt editor
        originalPrompt = imagePrompt;
        originalNegative = imageNegative;
        const promptTextarea = document.getElementById("qig-preview-prompt");
        const negativeTextarea = document.getElementById("qig-preview-negative");
        const toggleBtn = document.getElementById("qig-toggle-prompt-editor");
        const resetBtn = document.getElementById("qig-reset-prompt");
        const editorDiv = popup.querySelector(".qig-prompt-editor");
        if (promptTextarea) promptTextarea.value = imagePrompt;
        if (negativeTextarea) negativeTextarea.value = imageNegative;
        const sourceLabel = document.getElementById("qig-prompt-source-label");
        if (sourceLabel) sourceLabel.textContent = imagePromptWasLLM ? "🤖 AI-Enhanced Prompt" : "📝 Direct Prompt";
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            const isVisible = editorDiv.style.display !== "none";
            editorDiv.style.display = isVisible ? "none" : "block";
            toggleBtn.textContent = isVisible ? "✏️ Edit Prompt" : "▲ Hide Prompt";
        };
        resetBtn.onclick = (e) => {
            e.stopPropagation();
            promptTextarea.value = originalPrompt;
            negativeTextarea.value = originalNegative;
        };

        const img = document.getElementById("qig-result-img");
        img.src = "";
        img.src = entry.url;
        const downloadBtn = document.getElementById("qig-download-btn");
        downloadBtn.onclick = async (e) => {
            e.stopPropagation();
            await downloadWithMetadata(entry.url, `generated-${Date.now()}.png`, imagePrompt, imageNegative, imageMetadataSettings);
        };
        document.getElementById("qig-regenerate-btn").onclick = (e) => {
            e.stopPropagation();
            if (isGenerating) {
                toastr.warning("Generation already in progress");
                return;
            }
            if (promptTextarea && promptTextarea.value.trim()) {
                lastPrompt = promptTextarea.value;
            }
            if (negativeTextarea) {
                lastNegative = negativeTextarea.value;
            }
            lastPromptWasLLM = false;
            lastGenerationSourceMessageIndex = Number.isInteger(entry.sourceMessageIndex) ? entry.sourceMessageIndex : null;
            if (!lastPrompt.trim()) {
                toastr.error("Prompt cannot be empty");
                return;
            }
            popup.style.display = "none";
            regenerateImage();
        };
        document.getElementById("qig-gallery-btn").onclick = (e) => {
            e.stopPropagation();
            showGallery();
        };
        document.getElementById("qig-insert-btn").onclick = async (e) => {
            e.stopPropagation();
            const s = getSettings();
            try {
                if (s.insertAsHiddenReply) {
                    await insertImageAsHiddenReply(entry);
                } else {
                    await insertImageIntoMessage(entry, popupInsertTargetIndex);
                }
                toastr.success("Image inserted into message");
            } catch (err) {
                console.error("[Quick Image Gen] Insert failed:", err);
                toastr.error("Failed to insert image: " + err.message);
            }
        };
        document.getElementById("qig-background-btn").onclick = async (e) => {
            e.stopPropagation();
            try {
                await setImageAsBackground(entry, getSettings().backgroundMode);
            } catch (err) {
                log(`Set background failed: ${err.message}`);
                toastr.error("Failed to set background: " + err.message);
            }
        };
        document.getElementById("qig-use-as-ref").onclick = (e) => {
            e.stopPropagation();
            const imgSrc = document.getElementById("qig-result-img")?.src;
            if (!imgSrc) return;
            const s = getSettings();

            // Add to provider-specific references if applicable
            if (s.provider === "proxy") {
                if (addProxyRefImage(imgSrc, "Image added to reference images")) popup.style.display = "none";
                return;
            }
            if (s.provider === "nanobanana") {
                if (!s.nanobananaRefImages) s.nanobananaRefImages = [];
                if (s.nanobananaRefImages.length >= 15) {
                    toastr.warning("Maximum 15 reference images reached");
                    return;
                }
                s.nanobananaRefImages.push(imgSrc);
                saveSettingsDebounced();
                renderNanobananaRefImages();
                popup.style.display = "none";
                toastr.success("Image added to reference images");
                return;
            }

            // Otherwise use for local img2img
            s.localRefImage = imgSrc;
            saveSettingsDebounced();
            const preview = document.getElementById("qig-local-ref-preview");
            if (preview) { preview.src = imgSrc; preview.style.display = "block"; }
            const clearBtn = document.getElementById("qig-local-ref-clear");
            if (clearBtn) clearBtn.style.display = "block";
            const denoiseWrap = document.getElementById("qig-local-denoise-wrap");
            if (denoiseWrap) denoiseWrap.style.display = s.localType === "a1111" ? "block" : "none";
            popup.style.display = "none";
            toastr.success("Image set as reference for img2img");
        };
        document.getElementById("qig-close-popup").onclick = () => popup.style.display = "none";
    });
}

function displayBatchResults(results) {
    const batchFallbackSourceMessageIndex = Number.isInteger(lastGenerationSourceMessageIndex) ? lastGenerationSourceMessageIndex : null;
    const entries = results.map(result => normalizeGenerationEntry(result, {
        sourceMessageIndex: batchFallbackSourceMessageIndex,
    }));
    if (!entries.length) return;
    entries.forEach(entry => addToGallery(entry));

    let currentIndex = 0;

    const thumbsHtml = entries.map((entry, i) =>
        `<img class="qig-batch-thumb${i === 0 ? ' active' : ''}" data-index="${i}" src="${entry.url}">`
    ).join('');

    const popup = createPopup("qig-batch-popup", `Image 1/${entries.length}`, `
        <img id="qig-batch-img" src="" style="max-width:100%;max-height:60vh;object-fit:contain;padding:10px;min-height:100px;">
        <div class="qig-batch-nav">
            <button id="qig-batch-prev">◀</button>
            <span id="qig-batch-counter">1 / ${entries.length}</span>
            <button id="qig-batch-next">▶</button>
        </div>
        <div class="qig-batch-thumbs">${thumbsHtml}</div>
        <button id="qig-batch-toggle-prompt-editor" style="width: calc(100% - 32px); margin: 8px 16px; padding: 6px; background: var(--SmartThemeBlurTintColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; cursor: pointer; font-size: 11px;">
            ✏️ Edit Prompt
        </button>
        <div class="qig-prompt-editor" style="display:none;">
            <div style="padding: 8px 16px;">
                <span id="qig-batch-prompt-source-label" style="font-size: 10px; opacity: 0.7; display: block; margin-bottom: 4px;"></span>
                <label style="font-size: 11px; color: var(--SmartThemeBodyColor); display: block; margin-bottom: 4px;">Prompt:</label>
                <textarea id="qig-batch-preview-prompt" style="width: 100%; height: 80px; resize: vertical; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 8px; font-size: 12px; font-family: monospace;"></textarea>
                <label style="font-size: 11px; color: var(--SmartThemeBodyColor); display: block; margin: 8px 0 4px;">Negative Prompt:</label>
                <textarea id="qig-batch-preview-negative" style="width: 100%; height: 60px; resize: vertical; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 8px; font-size: 12px; font-family: monospace;"></textarea>
                <div style="display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end;">
                    <button id="qig-batch-reset-prompt" class="menu_button" style="padding: 4px 10px; font-size: 11px;">Reset to Original</button>
                </div>
            </div>
        </div>
        <div class="qig-popup-actions">
            <button id="qig-batch-regenerate" title="Regenerate all images in this batch">🔄 Regenerate</button>
            <button id="qig-batch-use-as-ref" title="Use selected image as reference for img2img">🖼 Use as Reference</button>
            <button id="qig-batch-insert" title="Insert selected image into chat">📌 Insert</button>
            <button id="qig-batch-insert-all" title="Insert all images into chat">📌 Insert All</button>
            <button id="qig-batch-background" title="Set selected image as the current chat background">🖼 Background</button>
            <button id="qig-batch-gallery" title="Save all to gallery">🖼️ Gallery</button>
            <button id="qig-batch-download" title="Download selected image">💾 Download</button>
            <button id="qig-batch-save-all" title="Download all images">💾 Save All</button>
            <button id="qig-batch-close" title="Close without inserting">Close</button>
        </div>`, (popup) => {
        const content = popup.querySelector('.qig-popup-content');
        if (content) {
            content.style.maxWidth = '';
            content.style.width = '';
            content.style.maxHeight = '';
        }
        initResizeHandle(popup);

        const getCurrentEntry = () => entries[currentIndex];
        const syncPromptEditor = (entry) => {
            const activeEntry = normalizeGenerationEntry(entry, { prompt: lastPrompt, negative: lastNegative, promptWasLLM: lastPromptWasLLM });
            originalPrompt = activeEntry.prompt;
            originalNegative = activeEntry.negative;
            if (batchPromptTextarea) batchPromptTextarea.value = originalPrompt;
            if (batchNegativeTextarea) batchNegativeTextarea.value = originalNegative;
            if (batchSourceLabel) batchSourceLabel.textContent = activeEntry.promptWasLLM ? "🤖 AI-Enhanced Prompt" : "📝 Direct Prompt";
        };

        // Initialize prompt editor
        const batchPromptTextarea = document.getElementById("qig-batch-preview-prompt");
        const batchNegativeTextarea = document.getElementById("qig-batch-preview-negative");
        const batchToggleBtn = document.getElementById("qig-batch-toggle-prompt-editor");
        const batchResetBtn = document.getElementById("qig-batch-reset-prompt");
        const batchEditorDiv = popup.querySelector(".qig-prompt-editor");
        const batchSourceLabel = document.getElementById("qig-batch-prompt-source-label");
        syncPromptEditor(entries[0]);
        batchToggleBtn.onclick = (e) => {
            e.stopPropagation();
            const isVisible = batchEditorDiv.style.display !== "none";
            batchEditorDiv.style.display = isVisible ? "none" : "block";
            batchToggleBtn.textContent = isVisible ? "✏️ Edit Prompt" : "▲ Hide Prompt";
        };
        batchResetBtn.onclick = (e) => {
            e.stopPropagation();
            batchPromptTextarea.value = originalPrompt;
            batchNegativeTextarea.value = originalNegative;
        };

        const img = document.getElementById("qig-batch-img");
        img.src = entries[0].url;

        function showImage(index) {
            currentIndex = index;
            img.src = entries[index].url;
            syncPromptEditor(entries[index]);
            document.getElementById("qig-batch-counter").textContent = `${index + 1} / ${entries.length}`;
            popup.querySelector('.qig-popup-header span').textContent = `Image ${index + 1}/${entries.length}`;
            popup.querySelectorAll('.qig-batch-thumb').forEach((t, i) => {
                t.classList.toggle('active', i === index);
            });
        }

        document.getElementById("qig-batch-prev").onclick = (e) => {
            e.stopPropagation();
            showImage((currentIndex - 1 + entries.length) % entries.length);
        };
        document.getElementById("qig-batch-next").onclick = (e) => {
            e.stopPropagation();
            showImage((currentIndex + 1) % entries.length);
        };

        popup.querySelectorAll('.qig-batch-thumb').forEach(thumb => {
            thumb.onclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(thumb.dataset.index);
                if (!isNaN(idx)) showImage(idx);
            };
        });

        const keyHandler = (e) => {
            if (popup.style.display === "none") {
                document.removeEventListener("keydown", keyHandler);
                return;
            }
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (e.key === "ArrowLeft") showImage((currentIndex - 1 + entries.length) % entries.length);
            if (e.key === "ArrowRight") showImage((currentIndex + 1) % entries.length);
            if (e.key === "Escape") { popup.style.display = "none"; document.removeEventListener("keydown", keyHandler); }
        };
        if (batchKeyHandler) document.removeEventListener("keydown", batchKeyHandler);
        batchKeyHandler = keyHandler;
        document.addEventListener("keydown", keyHandler);
        const origOnClick = popup.onclick;
        popup.onclick = (e) => {
            document.removeEventListener("keydown", keyHandler);
            if (origOnClick) origOnClick(e);
        };

        document.getElementById("qig-batch-download").onclick = async (e) => {
            e.stopPropagation();
            const activeEntry = getCurrentEntry();
            await downloadWithMetadata(activeEntry.url, `generated-${Date.now()}.png`, activeEntry.prompt, activeEntry.negative, activeEntry.metadataSettings);
        };
        document.getElementById("qig-batch-save-all").onclick = async (e) => {
            e.stopPropagation();
            const ts = Date.now();
            for (let i = 0; i < entries.length; i++) {
                const item = entries[i];
                await downloadWithMetadata(item.url, `generated-${ts}-${i + 1}.png`, item.prompt, item.negative, item.metadataSettings);
                if (i < entries.length - 1) await new Promise(r => setTimeout(r, 300));
            }
            toastr.success(`Downloaded ${entries.length} images`);
        };
        document.getElementById("qig-batch-insert-all").onclick = async (e) => {
            e.stopPropagation();
            try {
                for (const entry of entries) {
                    const insertTargetIndex = Number.isInteger(entry?.sourceMessageIndex) ? entry.sourceMessageIndex : batchFallbackSourceMessageIndex;
                    await insertImageIntoMessage(entry, insertTargetIndex);
                }
                toastr.success(`Inserted ${entries.length} images into message`);
            } catch (err) {
                console.error("[Quick Image Gen] Insert all failed:", err);
                toastr.error("Failed to insert images: " + err.message);
            }
        };
        document.getElementById("qig-batch-regenerate").onclick = (e) => {
            e.stopPropagation();
            if (isGenerating) {
                toastr.warning("Generation already in progress");
                return;
            }
            if (batchPromptTextarea && batchPromptTextarea.value.trim()) {
                lastPrompt = batchPromptTextarea.value;
            }
            if (batchNegativeTextarea) {
                lastNegative = batchNegativeTextarea.value;
            }
            lastPromptWasLLM = false;
            const activeEntry = getCurrentEntry();
            lastGenerationSourceMessageIndex = Number.isInteger(activeEntry?.sourceMessageIndex) ? activeEntry.sourceMessageIndex : null;
            if (!lastPrompt.trim()) {
                toastr.error("Prompt cannot be empty");
                return;
            }
            popup.style.display = "none";
            regenerateImage();
        };
        document.getElementById("qig-batch-gallery").onclick = (e) => {
            e.stopPropagation();
            showGallery();
        };
        document.getElementById("qig-batch-insert").onclick = async (e) => {
            e.stopPropagation();
            try {
                const activeEntry = getCurrentEntry();
                const insertTargetIndex = Number.isInteger(activeEntry?.sourceMessageIndex) ? activeEntry.sourceMessageIndex : batchFallbackSourceMessageIndex;
                await insertImageIntoMessage(activeEntry, insertTargetIndex);
                toastr.success("Image inserted into message");
            } catch (err) {
                console.error("[Quick Image Gen] Insert failed:", err);
                toastr.error("Failed to insert image: " + err.message);
            }
        };
        document.getElementById("qig-batch-background").onclick = async (e) => {
            e.stopPropagation();
            try {
                await setImageAsBackground(getCurrentEntry(), getSettings().backgroundMode);
            } catch (err) {
                log(`Set background failed: ${err.message}`);
                toastr.error("Failed to set background: " + err.message);
            }
        };
        document.getElementById("qig-batch-use-as-ref").onclick = (e) => {
            e.stopPropagation();
            const imgSrc = document.getElementById("qig-batch-img")?.src;
            if (!imgSrc) return;
            const s = getSettings();

            if (s.provider === "proxy") {
                if (addProxyRefImage(imgSrc, "Image added to reference images")) popup.style.display = "none";
                return;
            }
            if (s.provider === "nanobanana") {
                if (!s.nanobananaRefImages) s.nanobananaRefImages = [];
                if (s.nanobananaRefImages.length >= 15) {
                    toastr.warning("Maximum 15 reference images reached");
                    return;
                }
                s.nanobananaRefImages.push(imgSrc);
                saveSettingsDebounced();
                renderNanobananaRefImages();
                popup.style.display = "none";
                toastr.success("Image added to reference images");
                return;
            }

            s.localRefImage = imgSrc;
            saveSettingsDebounced();
            const preview = document.getElementById("qig-local-ref-preview");
            if (preview) { preview.src = imgSrc; preview.style.display = "block"; }
            const clearBtn = document.getElementById("qig-local-ref-clear");
            if (clearBtn) clearBtn.style.display = "block";
            const denoiseWrap = document.getElementById("qig-local-denoise-wrap");
            if (denoiseWrap) denoiseWrap.style.display = s.localType === "a1111" ? "block" : "none";
            popup.style.display = "none";
            toastr.success("Image set as reference for img2img");
        };
        document.getElementById("qig-batch-close").onclick = () => popup.style.display = "none";
    });
}

function showGallery() {
    const gallery = createPopup("qig-gallery-popup", "Gallery", `
        <div style="background:#16213e;padding:20px;border-radius:12px;max-width:800px;width:90%;max-height:80vh;overflow:auto;" onclick="event.stopPropagation()">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#e94560;">Gallery (${sessionGallery.length})</h3>
                <div style="display:flex;gap:8px;">
                    <button id="qig-gallery-clear" class="menu_button" style="padding:2px 8px;font-size:11px;">Clear Gallery</button>
                    <button id="qig-gallery-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;">✕</button>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
                <input id="qig-gallery-import-url" type="text" placeholder="Paste image URL or data URL" style="flex:1;min-width:220px;background:#0f1419;color:#fff;border:1px solid #333;border-radius:4px;padding:8px;font-size:12px;">
                <button id="qig-gallery-import-add" class="menu_button" style="padding:6px 10px;font-size:11px;">Add URL</button>
                <button id="qig-gallery-import-insert" class="menu_button" style="padding:6px 10px;font-size:11px;">Insert URL</button>
            </div>
            <div style="font-size:10px;opacity:0.7;margin-bottom:12px;">Add URL saves it into QIG Gallery. Insert URL saves it and sends it straight into chat.</div>
            <div id="qig-gallery-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;"></div>
        </div>`, (gallery) => {
        const grid = document.getElementById("qig-gallery-grid");
        const importInput = document.getElementById("qig-gallery-import-url");

        const renderGalleryGrid = () => {
            const titleEl = gallery.querySelector("h3");
            if (titleEl) titleEl.textContent = `Gallery (${sessionGallery.length})`;
            grid.innerHTML = sessionGallery.length ? sessionGallery.map((item, index) => {
                const imgSrc = escapeHtml(item.thumbnail || item.url || "");
                const snippet = item.prompt ? item.prompt.substring(0, 40) + (item.prompt.length > 40 ? '...' : '') : '';
                const safeSnippet = escapeHtml(snippet);
                return `<div style="position:relative;cursor:pointer;" data-gallery-index="${index}">` +
                    `<img src="${imgSrc}" style="width:100%;border-radius:6px;" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22><text y=%2240%22 x=%2220%22 fill=%22gray%22>expired</text></svg>'">` +
                    (snippet ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#ccc;font-size:9px;padding:2px 4px;border-radius:0 0 6px 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${safeSnippet}</div>` : '') +
                    `</div>`;
            }).join('') : '<p style="color:#888;">No images yet</p>';

            grid.querySelectorAll("[data-gallery-index]").forEach(el => {
                el.onclick = (e) => {
                    e.stopPropagation();
                    const item = sessionGallery[parseInt(el.dataset.galleryIndex)];
                    if (!item) return;
                    lastPrompt = item.prompt || "";
                    lastNegative = item.negative || "";
                    lastPromptWasLLM = !!item.promptWasLLM;
                    gallery.style.display = "none";
                    displayImage(item, true);
                };
            });
        };

        const runImport = async ({ insert = false } = {}) => {
            const rawUrl = importInput?.value?.trim() || "";
            if (!rawUrl) {
                toastr.warning("Paste an image URL first");
                return;
            }
            try {
                await importImageUrlToGallery(rawUrl, { insert });
                renderGalleryGrid();
                if (importInput) importInput.value = "";
                toastr.success(insert ? "Image URL inserted into chat" : "Image URL added to gallery");
            } catch (err) {
                log(`Gallery import failed: ${err.message}`);
                toastr.error("Failed to import image URL: " + err.message);
            }
        };

        document.getElementById("qig-gallery-close").onclick = () => gallery.style.display = "none";
        document.getElementById("qig-gallery-clear").onclick = () => {
            if (confirm("Clear entire gallery?")) {
                blobUrls.forEach(u => URL.revokeObjectURL(u)); blobUrls.clear();
                sessionGallery = [];
                localStorage.removeItem("qig_gallery");
                renderGalleryGrid();
            }
        };
        document.getElementById("qig-gallery-import-add").onclick = (e) => {
            e.stopPropagation();
            runImport({ insert: false });
        };
        document.getElementById("qig-gallery-import-insert").onclick = (e) => {
            e.stopPropagation();
            runImport({ insert: true });
        };
        if (importInput) {
            importInput.onkeydown = (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                runImport({ insert: false });
            };
        }
        renderGalleryGrid();
    });
}

function showPromptEditDialog(prompt) {
    return new Promise((resolve) => {
        const popup = createPopup("qig-prompt-edit-popup", "Edit LLM Generated Prompt", `
            <div style="background:#16213e;padding:20px;border-radius:12px;max-width:600px;width:90%;max-height:80vh;overflow:auto;" onclick="event.stopPropagation()">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <h3 style="margin:0;color:#e94560;">Edit Generated Prompt</h3>
                    <button id="qig-prompt-edit-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;">✕</button>
                </div>
                <textarea id="qig-prompt-edit-text" style="width:100%;height:200px;resize:vertical;background:#0f1419;color:#fff;border:1px solid #333;border-radius:4px;padding:8px;font-family:monospace;" placeholder="Edit the generated prompt..."></textarea>
                <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
                    <button id="qig-prompt-edit-cancel" class="menu_button">Cancel</button>
                    <button id="qig-prompt-edit-use" class="menu_button">Use Prompt</button>
                </div>
            </div>`, (popup) => {
            const textarea = document.getElementById("qig-prompt-edit-text");
            textarea.value = prompt;
            const closeBtn = document.getElementById("qig-prompt-edit-close");
            const cancelBtn = document.getElementById("qig-prompt-edit-cancel");
            const useBtn = document.getElementById("qig-prompt-edit-use");

            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);

            const close = () => {
                popup.style.display = "none";
                resolve(null);
            };

            const use = () => {
                popup.style.display = "none";
                resolve(textarea.value);
            };

            closeBtn.onclick = close;
            cancelBtn.onclick = close;
            useBtn.onclick = use;

            bindPopupDismiss(popup, close);

            textarea.onkeydown = (e) => {
                if (e.key === "Enter" && e.ctrlKey) {
                    e.preventDefault();
                    use();
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                }
            };
        });
    });
}

function showPlainDescriptionDialog() {
    return new Promise((resolve) => {
        const s = getSettings();
        const popup = createPopup("qig-plain-description-popup", "Generate From Plain Description", `
            <div class="qig-popup-form" style="padding:16px;min-width:min(640px,90vw);">
                <label for="qig-plain-description-text">Description</label>
                <textarea id="qig-plain-description-text" rows="8" placeholder="Describe the image in plain language. QIG will ask your AI to turn this into an image prompt."></textarea>
                <div class="qig-form-grid" style="margin-top:12px;">
                    <div class="qig-form-field">
                        <label for="qig-plain-description-style">Prompt Style</label>
                        <select id="qig-plain-description-style">
                            <option value="tags" ${s.llmPromptStyle === "tags" ? "selected" : ""}>Danbooru Tags (anime)</option>
                            <option value="natural" ${s.llmPromptStyle === "natural" ? "selected" : ""}>Natural Description</option>
                            <option value="custom" ${s.llmPromptStyle === "custom" ? "selected" : ""}>Custom Instruction</option>
                        </select>
                    </div>
                    <div class="qig-form-field" style="justify-content:end;">
                        <label class="checkbox_label">
                            <input id="qig-plain-description-edit" type="checkbox" ${s.llmEditPrompt ? "checked" : ""}>
                            <span>Edit AI prompt before generation</span>
                        </label>
                    </div>
                </div>
                <div class="qig-dialog-actions" style="margin-top:14px;">
                    <button id="qig-plain-description-cancel" class="menu_button">Cancel</button>
                    <button id="qig-plain-description-generate" class="menu_button">Generate</button>
                </div>
            </div>`, (popup) => {
            const textEl = document.getElementById("qig-plain-description-text");
            const styleEl = document.getElementById("qig-plain-description-style");
            const editEl = document.getElementById("qig-plain-description-edit");

            const close = () => {
                popup.style.display = "none";
                resolve(null);
            };
            const use = () => {
                const description = textEl.value.trim();
                if (!description) {
                    toastr.warning("Enter a plain text description first");
                    textEl.focus();
                    return;
                }
                popup.style.display = "none";
                resolve({
                    description,
                    promptStyle: styleEl.value || "tags",
                    editPrompt: !!editEl.checked,
                });
            };

            document.getElementById("qig-plain-description-cancel").onclick = close;
            document.getElementById("qig-plain-description-generate").onclick = use;
            bindPopupDismiss(popup, close);

            textEl.focus();
            textEl.onkeydown = (e) => {
                if (e.key === "Enter" && e.ctrlKey) {
                    e.preventDefault();
                    use();
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                }
            };
        }, { popupClass: "editor", contentClass: "qig-popup-content--editor", resizable: false });
    });
}

function showParagraphPicker(messageText) {
    return new Promise((resolve) => {
        const paragraphs = messageText.split(/\n\n+/).filter(p => p.trim());
        if (paragraphs.length === 0) { resolve(messageText); return; }

        const listHtml = paragraphs.map((p, i) => {
            const preview = p.length > 120 ? p.substring(0, 120) + "..." : p;
            const escaped = preview.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            return `<label class="qig-paragraph-item">
                <input type="checkbox" class="qig-para-cb" data-idx="${i}" checked>
                <span class="qig-paragraph-preview">${escaped}</span>
            </label>`;
        }).join("");

        const popup = createPopup("qig-paragraph-picker-popup", "Select Paragraphs", `
            <div style="padding:12px 16px;">
                <div style="display:flex;gap:8px;margin-bottom:10px;">
                    <button id="qig-para-select-all" class="menu_button" style="padding:2px 10px;font-size:11px;">Select All</button>
                    <button id="qig-para-deselect-all" class="menu_button" style="padding:2px 10px;font-size:11px;">Deselect All</button>
                </div>
                <div class="qig-paragraph-list">${listHtml}</div>
                <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
                    <button id="qig-para-cancel" class="menu_button">Cancel</button>
                    <button id="qig-para-use" class="menu_button">Use Selected</button>
                </div>
            </div>`, (popup) => {
            const checkboxes = () => popup.querySelectorAll(".qig-para-cb");
            document.getElementById("qig-para-select-all").onclick = () => checkboxes().forEach(cb => cb.checked = true);
            document.getElementById("qig-para-deselect-all").onclick = () => checkboxes().forEach(cb => cb.checked = false);

            const close = () => { popup.style.display = "none"; resolve(null); };
            const use = () => {
                const selected = [...checkboxes()].filter(cb => cb.checked).map(cb => paragraphs[parseInt(cb.dataset.idx)]);
                popup.style.display = "none";
                resolve(selected.length ? selected.join("\n\n") : null);
            };

            document.getElementById("qig-para-cancel").onclick = close;
            document.getElementById("qig-para-use").onclick = use;
            bindPopupDismiss(popup, close);
        });
    });
}

async function genStability(prompt, negative, s, signal) {
    if (!s.stabilityKey) throw new Error("Stability AI API key required");
    const seed = resolveRandomSeed(s.seed, s);
    const res = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.stabilityKey}`
        },
        body: JSON.stringify({
            text_prompts: [
                { text: prompt, weight: 1 },
                { text: negative || "", weight: -1 }
            ],
            cfg_scale: s.cfgScale,
            steps: Math.min(Math.max(s.steps, 10), 50),
            width: s.width,
            height: s.height,
            seed,
            samples: 1
        }),
        signal
    });
    if (!res.ok) throw new Error(`Stability error: ${res.status}`);
    const data = await res.json();
    if (data.artifacts?.[0]) return `data:image/png;base64,${data.artifacts[0].base64}`;
    throw new Error("No image in response");
}

async function genReplicate(prompt, negative, s, signal) {
    if (!s.replicateKey) throw new Error("Replicate API key required");
    const seed = resolveRandomSeed(s.seed, s);
    // Default to SDXL if no model specified
    const version = s.replicateModel || "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";

    // Create prediction
    const res = await replicateFetch("createPrediction", {
        apiKey: s.replicateKey,
        body: {
            version: version,
            input: {
                prompt: prompt,
                negative_prompt: negative,
                width: s.width,
                height: s.height,
                num_inference_steps: s.steps,
                guidance_scale: s.cfgScale,
                seed: seed,
                num_outputs: 1,
                scheduler: ({
                    "euler_a": "K_EULER_ANCESTRAL",
                    "euler": "K_EULER",
                    "dpm++_2m": "DPMSolverMultistep",
                    "dpm++_sde": "DPM++SDE",
                    "ddim": "DDIM",
                    "lms": "K_LMS",
                    "heun": "K_HEUN"
                })[s.sampler] || "K_EULER"
            }
        },
    }, signal);
    if (!res.ok) throw new Error(`Replicate error: ${res.status}`);
    const pred = await res.json();

    // Poll for result
    for (let i = 0; i < 60; i++) {
        if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
        await new Promise(r => setTimeout(r, 2000));
        const statusRes = await replicateFetch("getPrediction", {
            apiKey: s.replicateKey,
            id: pred.id,
        }, signal);
        if (!statusRes.ok) throw new Error(`Replicate polling error: ${statusRes.status}`);
        const status = await statusRes.json();
        if (status.status === "succeeded") {
            const outputs = Array.isArray(status.output) ? status.output : [status.output];
            for (const output of outputs) {
                if (typeof output === "string" && output) return output;
                if (typeof output?.url === "string" && output.url) return output.url;
                if (typeof output?.image === "string" && output.image) return output.image;
                if (typeof output?.image?.url === "string" && output.image.url) return output.image.url;
            }
            throw new Error("Replicate returned no image in response");
        }
        if (status.status === "failed") throw new Error(status.error || "Generation failed");
    }
    throw new Error("Replicate timeout");
}

async function genFal(prompt, negative, s, signal) {
    if (!s.falKey) throw new Error("Fal.ai API key required");
    const seed = resolveRandomSeed(s.seed, s);
    // Default to Flux Schnell
    const model = s.falModel || "fal-ai/flux/schnell";
    const endpoint = `https://fal.run/${model}`;

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Key ${s.falKey}`
        },
        body: JSON.stringify({
            prompt: prompt,
            negative_prompt: negative || "",
            image_size: { width: s.width, height: s.height },
            num_inference_steps: s.steps,
            guidance_scale: s.cfgScale,
            seed: seed,
            num_images: 1,
            enable_safety_checker: false
        }),
        signal
    });
    if (!res.ok) throw new Error(`Fal.ai error: ${res.status}`);
    const data = await res.json();
    if (data.images?.[0]?.url) return data.images[0].url;
    throw new Error("No image in response");
}

async function genTogether(prompt, negative, s, signal) {
    if (!s.togetherKey) throw new Error("Together AI API key required");
    const seed = resolveRandomSeed(s.seed, s);
    const model = s.togetherModel || "stabilityai/stable-diffusion-xl-base-1.0";

    const res = await fetch("https://api.together.xyz/v1/images/generations", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.togetherKey}`
        },
        body: JSON.stringify({
            model: model,
            prompt: prompt,
            negative_prompt: negative,
            width: s.width,
            height: s.height,
            steps: Math.min(s.steps, 50),
            seed: seed,
            n: 1
        }),
        signal
    });
    if (!res.ok) throw new Error(`Together AI error: ${res.status}`);
    const data = await res.json();
    if (data.data?.[0]?.url) return data.data[0].url;
    if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
    throw new Error("No image in response");
}

async function genZai(prompt, negative, s, signal) {
    if (!s.zaiKey) throw new Error("Z.AI API key required");
    const res = await fetch("https://api.z.ai/api/paas/v4/images/generations", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.zaiKey}`
        },
        body: JSON.stringify({
            model: s.zaiModel || "cogview-4-250304",
            prompt: prompt,
            quality: s.zaiQuality || "hd",
            size: `${s.width}x${s.height}`
        }),
        signal
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Z.AI error ${res.status}: ${err.message || res.statusText}`);
    }
    const data = await res.json();
    if (data.data?.[0]?.url) return data.data[0].url;
    throw new Error("No image in Z.AI response");
}

async function genOpenAICompatibleImageProvider(provider, providerName, apiUrl, apiKey, model, prompt, negative, s, signal) {
    if (!apiKey) throw new Error(`${providerName} API key required`);
    const trimmedModel = String(model || "").trim();
    if (!trimmedModel) throw new Error(`${providerName} model required`);
    const effectivePrompt = negative
        ? `${prompt}\n\nAvoid in the image: ${negative}`
        : prompt;
    const size = getOpenAICompatibleImageSize(provider, trimmedModel, s);
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: trimmedModel,
            prompt: effectivePrompt,
            size,
            n: 1,
            response_format: "b64_json",
        }),
        signal,
    });

    if (!res.ok) {
        const detail = await readProxyErrorResponse(res);
        throw new Error(`${providerName} error ${res.status}: ${detail || res.statusText}`);
    }

    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (b64) return extractGptImageDataUrl(b64, "png");
    const image = extractProxyImageFromJson(data);
    if (image) return image;
    throw new Error(`No image in ${providerName} response`);
}

async function genRouteway(prompt, negative, s, signal) {
    return await genOpenAICompatibleImageProvider(
        "routeway",
        "Routeway",
        "https://api.routeway.ai/v1/images/generations",
        s.routewayKey,
        s.routewayModel || "flux-1-schnell",
        prompt,
        negative,
        s,
        signal,
    );
}

async function genNavy(prompt, negative, s, signal) {
    return await genOpenAICompatibleImageProvider(
        "navy",
        "Navy.ai",
        "https://api.navy/v1/images/generations",
        s.navyKey,
        s.navyModel || "flux",
        prompt,
        negative,
        s,
        signal,
    );
}

const providerGenerators = {
    pollinations: genPollinations,
    novelai: genNovelAI,
    gptimage: genGptImage,
    arliai: genArliAI,
    routeway: genRouteway,
    navy: genNavy,
    nanogpt: genNanoGPT,
    chutes: genChutes,
    civitai: genCivitAI,
    nanobanana: genNanobanana,
    stability: genStability,
    replicate: genReplicate,
    fal: genFal,
    together: genTogether,
    zai: genZai,
    local: genLocal,
    comfyui: genLocal,
    proxy: genProxy
};

async function generateForProvider(prompt, negative, settings, signal, options = {}) {
    const generator = providerGenerators[settings.provider];
    if (!generator) throw new Error(`Unknown provider: ${settings.provider}`);
    return await generator(prompt, negative, settings, signal, options);
}

async function regenerateImage() {
    if (isGenerating) return;
    if (!lastPrompt) {
        showStatus("❌ No previous prompt to regenerate");
        return;
    }
    beginGeneration({ disableGenerateButton: true });
    const s = getSettings();
    const batchCount = s.batchCount || 1;
    const originalSeed = getGenerationSeedValue(s);
    const cancelCheckpoint = getCancelCheckpoint();
    setGenerationSeedValue(s, -1);
    const providerRuntimeOptions = s.provider === "proxy"
        ? { proxyRefImages: [...lastProxyContextRefImages] }
        : {};

    log(`Regenerating with prompt: ${lastPrompt.substring(0, 50)}... (batch: ${batchCount})`);
    try {
        checkAborted(cancelCheckpoint);
        if (batchCount <= 1) {
            showStatus("🔄 Regenerating...");
            const result = await generateForProvider(lastPrompt, lastNegative, s, currentAbortController?.signal, providerRuntimeOptions);
            checkAborted(cancelCheckpoint);
            hideStatus();
            if (result) {
                const entry = await finalizeGeneratedEntry(result, lastPrompt, lastNegative, s, {
                    promptWasLLM: lastPromptWasLLM,
                    sourceMessageIndex: Number.isInteger(lastGenerationSourceMessageIndex) ? lastGenerationSourceMessageIndex : undefined,
                });
                if (entry) displayImage(entry);
            }
        } else {
            const results = [];
            let baseSeed = Math.floor(Math.random() * 2147483647);
            for (let i = 0; i < batchCount; i++) {
                checkAborted(cancelCheckpoint);
                if (s.sequentialSeeds) s.seed = baseSeed + i;
                showStatus(`🔄 Regenerating ${i + 1}/${batchCount}...`);
                const expandedPrompt = expandWildcards(lastPrompt);
                const expandedNegative = expandWildcards(lastNegative);
                const result = await generateForProvider(expandedPrompt, expandedNegative, s, currentAbortController?.signal, providerRuntimeOptions);
                if (result) {
                    const entry = await finalizeGeneratedEntry(result, expandedPrompt, expandedNegative, s, {
                        promptWasLLM: lastPromptWasLLM,
                        sourceMessageIndex: Number.isInteger(lastGenerationSourceMessageIndex) ? lastGenerationSourceMessageIndex : undefined,
                    });
                    if (entry) results.push(entry);
                }
            }
            hideStatus();
            if (results.length > 1) {
                displayBatchResults(results);
            } else if (results.length === 1) {
                displayImage(results[0]);
            }
        }
    } catch (e) {
        if (e.name === "AbortError") {
            log("Regeneration cancelled by user");
            toastr.info("Generation cancelled");
        } else {
            showStatus(`❌ ${e.message}`);
            log(`Regenerate error: ${e.message}`);
            setTimeout(hideStatus, 3000);
        }
    } finally {
        setGenerationSeedValue(s, originalSeed);
        endGeneration({ disableGenerateButton: true });
    }
}

// === Contextual Filters (lorebook-style prompt injection) ===
function saveContextualFilters() {
    safeSetStorage("qig_contextual_filters", JSON.stringify(contextualFilters), "Failed to save contextual filters. Browser storage may be full.");
    backupToSettings("qig_contextual_filters", contextualFilters);
}

function isContextualFilterEnabledByPools(filter, enabledPoolIds = getEnabledPoolIdsForCurrentContext()) {
    const poolIds = normalizePoolIdList(filter?.poolIds);
    if (!poolIds.length) return enabledPoolIds.has(DEFAULT_FILTER_POOL_ID);
    return poolIds.some(id => enabledPoolIds.has(id));
}

function isContextualFilterEffective(filter, enabledPoolIds = getEnabledPoolIdsForCurrentContext()) {
    return !!filter?.enabled && isContextualFilterEnabledByPools(filter, enabledPoolIds);
}

function getPoolNameById(poolId) {
    const id = String(poolId || "");
    return filterPools.find(p => p.id === id)?.name || "Unknown Pool";
}

function findFilterPoolByName(name, { scope = FILTER_SCOPE_GLOBAL, charId = null, cardKey = null } = {}) {
    const normalizedName = String(name || "").trim().toLowerCase();
    const scopeInfo = getNormalizedScopedRecord(scope, { charId, cardKey });
    if (!normalizedName) return null;
    return filterPools.find(pool => {
        const poolScope = getScopedRecordFromEntity(pool);
        if (poolScope.scope !== scopeInfo.scope) return false;
        if (poolScope.scope === FILTER_SCOPE_CARD && poolScope.cardKey !== scopeInfo.cardKey) return false;
        if (poolScope.scope === FILTER_SCOPE_CHAR && poolScope.charId !== scopeInfo.charId) return false;
        return String(pool.name || "").trim().toLowerCase() === normalizedName;
    }) || null;
}

function createFilterPoolRecord(name, { scope = FILTER_SCOPE_GLOBAL, charId = null, cardKey = null, cardLabel = null, enable = true } = {}) {
    const trimmedName = String(name || "").trim();
    const scopeInfo = getNormalizedScopedRecord(scope, { charId, cardKey, cardLabel });
    if (!trimmedName) return null;
    if (scopeInfo.scope === FILTER_SCOPE_CARD && !scopeInfo.cardKey) return null;
    if (scopeInfo.scope === FILTER_SCOPE_CHAR && !scopeInfo.charId) return null;

    const now = new Date().toISOString();
    const pool = {
        id: `qig_pool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: trimmedName,
        scope: scopeInfo.scope,
        charId: scopeInfo.charId,
        cardKey: scopeInfo.cardKey,
        cardLabel: scopeInfo.cardLabel,
        createdAt: now,
        updatedAt: now,
    };
    filterPools.push(pool);

    if (enable) {
        if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
            const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByCard[scopeInfo.cardKey]));
            ids.add(pool.id);
            activeFilterPoolIdsByCard[scopeInfo.cardKey] = [...ids];
        } else if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
            const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByChar[scopeInfo.charId]));
            ids.add(pool.id);
            activeFilterPoolIdsByChar[scopeInfo.charId] = [...ids];
        } else {
            const ids = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
            ids.add(pool.id);
            activeFilterPoolIdsGlobal = [...ids];
        }
    }

    return pool;
}

function enableFilterPool(pool) {
    if (!pool?.id) return;
    const scopeInfo = getScopedRecordFromEntity(pool);
    if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
        const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByCard[scopeInfo.cardKey]));
        ids.add(pool.id);
        activeFilterPoolIdsByCard[scopeInfo.cardKey] = [...ids];
        return;
    }
    if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
        const key = String(scopeInfo.charId);
        const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByChar[key]));
        ids.add(pool.id);
        activeFilterPoolIdsByChar[key] = [...ids];
        return;
    }

    const ids = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
    ids.add(pool.id);
    activeFilterPoolIdsGlobal = [...ids];
}

function ensureFilterPoolByName(name, options = {}) {
    const existing = findFilterPoolByName(name, options);
    if (existing) {
        if (options.enable) enableFilterPool(existing);
        return existing;
    }
    return createFilterPoolRecord(name, options);
}

function getNextContextualFilterSortOrder(scopeRef, excludeFilterId = null) {
    const scopeKey = getContextualFilterScopeKey(scopeRef);
    return contextualFilters.filter(filter =>
        filter?.id !== excludeFilterId &&
        getContextualFilterScopeKey(filter) === scopeKey
    ).length;
}

function finalizePoolIdsForScope(poolIds, { scope = FILTER_SCOPE_GLOBAL, charId = null, cardKey = null, cardLabel = null } = {}) {
    const scopeInfo = getNormalizedScopedRecord(scope, { charId, cardKey, cardLabel });
    let nextPoolIds = normalizePoolIdList(poolIds);
    if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
        const cardDefaultPool = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
            scope: FILTER_SCOPE_CARD,
            cardKey: scopeInfo.cardKey,
            cardLabel: scopeInfo.cardLabel,
            enable: true,
        });
        const hasScopedPool = nextPoolIds.some(id => {
            const pool = filterPools.find(entry => entry.id === id);
            const poolScope = getScopedRecordFromEntity(pool);
            return poolScope.scope === FILTER_SCOPE_CARD && poolScope.cardKey === scopeInfo.cardKey;
        });
        if (!hasScopedPool && cardDefaultPool?.id) {
            nextPoolIds = nextPoolIds.filter(id => id !== DEFAULT_FILTER_POOL_ID);
            nextPoolIds.unshift(cardDefaultPool.id);
        }
    } else if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
        const charDefaultPool = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
            scope: FILTER_SCOPE_CHAR,
            charId: scopeInfo.charId,
            enable: true,
        });
        const hasScopedPool = nextPoolIds.some(id => {
            const pool = filterPools.find(entry => entry.id === id);
            const poolScope = getScopedRecordFromEntity(pool);
            return poolScope.scope === FILTER_SCOPE_CHAR && poolScope.charId === scopeInfo.charId;
        });
        if (!hasScopedPool && charDefaultPool?.id) {
            nextPoolIds = nextPoolIds.filter(id => id !== DEFAULT_FILTER_POOL_ID);
            nextPoolIds.unshift(charDefaultPool.id);
        }
    }
    if (!nextPoolIds.length) nextPoolIds.push(DEFAULT_FILTER_POOL_ID);
    return normalizePoolIdList(nextPoolIds);
}

function getMappedPoolIdsForCopiedFilter(sourcePoolIds, { scope = FILTER_SCOPE_GLOBAL, charId = null, cardKey = null, cardLabel = null } = {}) {
    const scopeInfo = getNormalizedScopedRecord(scope, { charId, cardKey, cardLabel });
    const mappedPoolIds = [];
    for (const poolId of normalizePoolIdList(sourcePoolIds)) {
        const sourcePool = filterPools.find(pool => pool.id === poolId);
        const sourcePoolName = String(sourcePool?.name || "").trim();
        if (poolId === DEFAULT_FILTER_POOL_ID || isDefaultFilterPoolName(sourcePoolName)) {
            if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
                const scopedDefault = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
                    scope: FILTER_SCOPE_CARD,
                    cardKey: scopeInfo.cardKey,
                    cardLabel: scopeInfo.cardLabel,
                    enable: true,
                });
                if (scopedDefault?.id) mappedPoolIds.push(scopedDefault.id);
            } else if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
                const scopedDefault = ensureFilterPoolByName(DEFAULT_FILTER_POOL_NAME, {
                    scope: FILTER_SCOPE_CHAR,
                    charId: scopeInfo.charId,
                    enable: true,
                });
                if (scopedDefault?.id) mappedPoolIds.push(scopedDefault.id);
                else mappedPoolIds.push(DEFAULT_FILTER_POOL_ID);
            } else {
                mappedPoolIds.push(DEFAULT_FILTER_POOL_ID);
            }
            continue;
        }
        if (!sourcePoolName) continue;
        const mappedPool = ensureFilterPoolByName(sourcePoolName, {
            scope: scopeInfo.scope,
            charId: scopeInfo.charId,
            cardKey: scopeInfo.cardKey,
            cardLabel: scopeInfo.cardLabel,
            enable: true,
        });
        if (mappedPool?.id) mappedPoolIds.push(mappedPool.id);
    }
    return finalizePoolIdsForScope(mappedPoolIds, scopeInfo);
}

function addFilterPool(scope = FILTER_SCOPE_GLOBAL) {
    const currentCharId = getCurrentCharId();
    const currentCard = getCurrentCardScopeInfo();
    const isCardScope = scope === FILTER_SCOPE_CARD;
    const isCharScope = scope === FILTER_SCOPE_CHAR;
    const targetScope = getNormalizedScopedRecord(scope, {
        charId: isCharScope ? currentCharId : null,
        cardKey: isCardScope ? currentCard.cardKey : null,
        cardLabel: isCardScope ? currentCard.cardLabel : null,
    });
    if (isCardScope && !targetScope.cardKey) {
        toastr.warning("Open a specific card chat to create a card-only pool.");
        return;
    }
    if (isCharScope && !targetScope.charId) {
        toastr.warning("Open a character chat to create a character pool.");
        return;
    }
    const rawName = prompt(`New ${isCardScope ? "card" : isCharScope ? "character" : "global"} pool name:`);
    if (rawName == null) return;
    const name = rawName.trim();
    if (!name) {
        toastr.warning("Pool name cannot be empty.");
        return;
    }
    if (findFilterPoolByName(name, targetScope)) {
        toastr.warning(`Pool "${name}" already exists in this scope.`);
        return;
    }
    createFilterPoolRecord(name, {
        scope: targetScope.scope,
        charId: targetScope.charId,
        cardKey: targetScope.cardKey,
        cardLabel: targetScope.cardLabel,
        enable: true,
    });
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function renameFilterPool(poolId) {
    const pool = filterPools.find(p => p.id === poolId);
    if (!pool) return;
    const rawName = prompt("Rename pool:", pool.name || "");
    if (rawName == null) return;
    const name = rawName.trim();
    if (!name) {
        toastr.warning("Pool name cannot be empty.");
        return;
    }
    pool.name = name;
    pool.updatedAt = new Date().toISOString();
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function deleteFilterPool(poolId) {
    if (poolId === DEFAULT_FILTER_POOL_ID) {
        toastr.warning("The default pool cannot be deleted.");
        return;
    }
    const pool = filterPools.find(p => p.id === poolId);
    if (!pool) return;
    if (!confirm(`Delete pool "${pool.name}"? Filters in this pool will be moved to "${DEFAULT_FILTER_POOL_NAME}" if needed.`)) return;
    filterPools = filterPools.filter(p => p.id !== poolId);
    activeFilterPoolIdsGlobal = normalizePoolIdList(activeFilterPoolIdsGlobal).filter(id => id !== poolId);
    const nextByCard = {};
    for (const [cardKey, ids] of Object.entries(activeFilterPoolIdsByCard || {})) {
        const nextIds = normalizePoolIdList(ids).filter(id => id !== poolId);
        if (nextIds.length) nextByCard[cardKey] = nextIds;
    }
    activeFilterPoolIdsByCard = nextByCard;
    const nextByChar = {};
    for (const [charId, ids] of Object.entries(activeFilterPoolIdsByChar || {})) {
        const nextIds = normalizePoolIdList(ids).filter(id => id !== poolId);
        if (nextIds.length) nextByChar[charId] = nextIds;
    }
    activeFilterPoolIdsByChar = nextByChar;
    const deletedPoolScope = getScopedRecordFromEntity(pool);
    for (const f of contextualFilters) {
        const nextPoolIds = normalizePoolIdList(f.poolIds).filter(id => id !== poolId);
        const filterScope = getScopedRecordFromEntity(f);
        const shouldPreserveScopedDefault =
            (deletedPoolScope.scope === FILTER_SCOPE_CARD &&
                filterScope.scope === FILTER_SCOPE_CARD &&
                !!filterScope.cardKey &&
                filterScope.cardKey === deletedPoolScope.cardKey) ||
            (deletedPoolScope.scope === FILTER_SCOPE_CHAR &&
                filterScope.scope === FILTER_SCOPE_CHAR &&
                !!filterScope.charId &&
                filterScope.charId === deletedPoolScope.charId);
        f.poolIds = shouldPreserveScopedDefault
            ? finalizePoolIdsForScope(nextPoolIds, filterScope)
            : (nextPoolIds.length ? nextPoolIds : [DEFAULT_FILTER_POOL_ID]);
    }
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function toggleFilterPool(poolId) {
    const pool = filterPools.find(p => p.id === poolId);
    if (!pool) return;
    const scopeInfo = getScopedRecordFromEntity(pool);
    if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
        const key = scopeInfo.cardKey;
        const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByCard[key]));
        if (ids.has(poolId)) ids.delete(poolId);
        else ids.add(poolId);
        if (ids.size > 0) activeFilterPoolIdsByCard[key] = [...ids];
        else delete activeFilterPoolIdsByCard[key];
    } else if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
        const key = String(scopeInfo.charId);
        const ids = new Set(normalizePoolIdList(activeFilterPoolIdsByChar[key]));
        if (ids.has(poolId)) ids.delete(poolId);
        else ids.add(poolId);
        if (ids.size > 0) activeFilterPoolIdsByChar[key] = [...ids];
        else delete activeFilterPoolIdsByChar[key];
    } else {
        const ids = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
        if (ids.has(poolId)) ids.delete(poolId);
        else ids.add(poolId);
        activeFilterPoolIdsGlobal = [...ids];
    }
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function setVisiblePoolsEnabled(enabled) {
    const selectedScope = getSelectedFilterManagerScopeDescriptor();
    const { globalPools, scopedPools } = getVisibleFilterPools(selectedScope);
    if (enabled) {
        const globalIds = new Set(normalizePoolIdList(activeFilterPoolIdsGlobal));
        for (const p of globalPools) globalIds.add(p.id);
        activeFilterPoolIdsGlobal = [...globalIds];
        if (selectedScope.scope === FILTER_SCOPE_CARD && selectedScope.cardKey) {
            const key = selectedScope.cardKey;
            const cardIds = new Set(normalizePoolIdList(activeFilterPoolIdsByCard[key]));
            for (const p of scopedPools) cardIds.add(p.id);
            if (cardIds.size > 0) activeFilterPoolIdsByCard[key] = [...cardIds];
        } else if (selectedScope.scope === FILTER_SCOPE_CHAR && selectedScope.charId) {
            const key = String(selectedScope.charId);
            const charIds = new Set(normalizePoolIdList(activeFilterPoolIdsByChar[key]));
            for (const p of scopedPools) charIds.add(p.id);
            if (charIds.size > 0) activeFilterPoolIdsByChar[key] = [...charIds];
        }
    } else {
        const hideGlobal = new Set(globalPools.map(p => p.id));
        activeFilterPoolIdsGlobal = normalizePoolIdList(activeFilterPoolIdsGlobal).filter(id => !hideGlobal.has(id));
        if (selectedScope.scope === FILTER_SCOPE_CARD && selectedScope.cardKey) {
            const key = selectedScope.cardKey;
            const hideCard = new Set(scopedPools.map(p => p.id));
            const next = normalizePoolIdList(activeFilterPoolIdsByCard[key]).filter(id => !hideCard.has(id));
            if (next.length > 0) activeFilterPoolIdsByCard[key] = next;
            else delete activeFilterPoolIdsByCard[key];
        } else if (selectedScope.scope === FILTER_SCOPE_CHAR && selectedScope.charId) {
            const key = String(selectedScope.charId);
            const hideChar = new Set(scopedPools.map(p => p.id));
            const next = normalizePoolIdList(activeFilterPoolIdsByChar[key]).filter(id => !hideChar.has(id));
            if (next.length > 0) activeFilterPoolIdsByChar[key] = next;
            else delete activeFilterPoolIdsByChar[key];
        }
    }
    saveActiveFilterPools();
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function showFilterDialog(filter) {
    const isNew = !filter;
    const currentCard = getCurrentCardScopeInfo();
    const currentCharId = getCurrentCharId();
    const charName = getCurrentCharName();
    const managerScope = getSelectedFilterManagerScopeDescriptor();
    const defaultScope = managerScope;
    const f = filter || {
        name: "",
        keywords: "",
        matchMode: "OR",
        positive: "",
        negative: "",
        removePositive: "",
        removeNegative: "",
        removeMode: "remove",
        priority: 0,
        description: "",
        scope: defaultScope.scope,
        charId: defaultScope.charId,
        cardKey: defaultScope.cardKey,
        cardLabel: defaultScope.cardLabel,
        poolIds: [DEFAULT_FILTER_POOL_ID],
        seedOverride: null,
    };
    const isLLM = f.matchMode === "LLM";
    const scopeInfo = getScopedRecordFromEntity(f);
    const editingDifferentCard = scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey && scopeInfo.cardKey !== currentCard.cardKey;
    const editingDifferentChar = scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId && (!currentCharId || String(scopeInfo.charId) !== String(currentCharId));
    const initialPoolIds = normalizePoolIdList(f.poolIds);
    const initialSeedOverride = normalizeSeedOverride(f.seedOverride);
    return new Promise((resolve) => {
        const popup = createPopup("qig-filter-dialog", isNew ? "Add Contextual Filter" : "Edit Contextual Filter", `
            <div class="qig-popup-form qig-filter-dialog-form">
                <section class="qig-form-section">
                    <div class="qig-form-grid">
                        <div class="qig-form-field">
                            <label for="qig-fd-name">Name</label>
                            <input id="qig-fd-name" type="text" value="${escapeHtml(f.name)}" placeholder="e.g., Goku & Vegeta">
                        </div>
                        <div class="qig-form-field">
                            <label for="qig-fd-scope">Scope</label>
                            <select id="qig-fd-scope">
                                <option value="global" ${scopeInfo.scope === FILTER_SCOPE_GLOBAL ? "selected" : ""}>Global (all characters)</option>
                                ${currentCard.cardKey ? `<option value="card:${escapeHtml(String(currentCard.cardKey))}" ${scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey === currentCard.cardKey ? "selected" : ""}>Card Only: ${escapeHtml(currentCard.cardLabel || "Current Card")}</option>` : ""}
                                ${currentCharId != null ? `<option value="char:${escapeHtml(String(currentCharId))}" ${scopeInfo.scope === FILTER_SCOPE_CHAR && String(scopeInfo.charId) === String(currentCharId) ? "selected" : ""}>Character: ${escapeHtml(charName || "Unknown")}</option>` : ""}
                                ${editingDifferentCard ? `<option value="card:${escapeHtml(String(scopeInfo.cardKey))}" selected>Card: ${escapeHtml(scopeInfo.cardLabel || getCardNameForFilters(scopeInfo.cardKey))}</option>` : ""}
                                ${editingDifferentChar ? `<option value="char:${escapeHtml(String(scopeInfo.charId))}" selected>Character: ${escapeHtml(getCharacterNameForFilters(scopeInfo.charId))}</option>` : ""}
                            </select>
                        </div>
                        <div class="qig-form-field qig-form-field--full">
                            <label>Pools</label>
                            <div id="qig-fd-pools-wrap" class="qig-pool-choice-grid"></div>
                        </div>
                    </div>
                </section>

                <section class="qig-form-section">
                    <div class="qig-form-grid">
                        <div class="qig-form-field">
                            <label for="qig-fd-mode">Match Mode</label>
                            <select id="qig-fd-mode">
                                <option value="OR" ${f.matchMode === "OR" ? "selected" : ""}>OR — any keyword triggers</option>
                                <option value="AND" ${f.matchMode === "AND" ? "selected" : ""}>AND — all keywords required</option>
                                <option value="LLM" ${f.matchMode === "LLM" ? "selected" : ""}>LLM — AI concept recognition</option>
                            </select>
                        </div>
                        <div class="qig-form-field">
                            <label for="qig-fd-priority">Priority</label>
                            <input id="qig-fd-priority" type="number" value="${f.priority || 0}">
                            <small class="qig-help">Higher priority filters apply first and seed ties resolve in that order.</small>
                        </div>
                        <div class="qig-form-field">
                            <label for="qig-fd-seed">Seed Override</label>
                            <input id="qig-fd-seed" type="number" min="0" step="1" value="${initialSeedOverride == null ? "" : escapeHtml(String(initialSeedOverride))}" placeholder="Leave blank to use the main seed">
                            <small class="qig-help">Optional. When this filter matches, it can override the generation seed.</small>
                        </div>
                        <div class="qig-form-field qig-form-field--full" id="qig-fd-keywords-wrap" style="display:${isLLM ? 'none' : ''};">
                            <label for="qig-fd-keywords">Keywords (comma-separated)</label>
                            <textarea id="qig-fd-keywords" rows="3" placeholder="goku, vegeta">${escapeHtml(f.keywords || "")}</textarea>
                        </div>
                        <div class="qig-form-field qig-form-field--full" id="qig-fd-desc-wrap" style="display:${isLLM ? '' : 'none'};">
                            <label for="qig-fd-description">Concept Description</label>
                            <textarea id="qig-fd-description" rows="4" placeholder="Scenes with a cyberpunk or futuristic urban aesthetic — neon lights, holograms, high-tech cityscapes">${escapeHtml(f.description || "")}</textarea>
                            <small class="qig-help">Used by LLM match mode to detect concepts that are not literal keywords.</small>
                        </div>
                    </div>
                </section>

                <section class="qig-form-section">
                    <div class="qig-form-grid">
                        <div class="qig-form-field qig-form-field--full">
                            <label for="qig-fd-positive">Positive Prompt</label>
                            <textarea id="qig-fd-positive" rows="4" placeholder="1boy, goku, &lt;lora:goku:0.8&gt;">${escapeHtml(f.positive)}</textarea>
                        </div>
                        <div class="qig-form-field qig-form-field--full">
                            <label for="qig-fd-negative">Negative Prompt</label>
                            <textarea id="qig-fd-negative" rows="3" placeholder="solo, 1boy">${escapeHtml(f.negative)}</textarea>
                        </div>
                        <div class="qig-form-field">
                            <label for="qig-fd-remove-positive">Remove From Positive</label>
                            <textarea id="qig-fd-remove-positive" rows="3" placeholder="&lt;lora:general_style&gt;, solo">${escapeHtml(f.removePositive || "")}</textarea>
                        </div>
                        <div class="qig-form-field">
                            <label for="qig-fd-remove-negative">Remove From Negative</label>
                            <textarea id="qig-fd-remove-negative" rows="3" placeholder="blurry, watermark">${escapeHtml(f.removeNegative || "")}</textarea>
                        </div>
                    </div>
                    <small class="qig-help">LoRA removals match by name only, so &lt;lora:foo&gt; removes any &lt;lora:foo:*&gt; variant.</small>
                </section>

                <div class="qig-dialog-actions">
                    <button id="qig-fd-cancel" class="menu_button">Cancel</button>
                    <button id="qig-fd-save" class="menu_button">Save</button>
                </div>
            </div>`, (popup) => {
            const selectedPoolIds = new Set(initialPoolIds.length ? initialPoolIds : [DEFAULT_FILTER_POOL_ID]);
            const poolWrap = document.getElementById("qig-fd-pools-wrap");

            const syncSelectedPoolIds = () => {
                if (!poolWrap) return;
                const checkboxes = poolWrap.querySelectorAll(".qig-fd-pool-cb");
                if (!checkboxes.length) return;
                for (const id of [...selectedPoolIds]) selectedPoolIds.delete(id);
                checkboxes.forEach(cb => { if (cb.checked) selectedPoolIds.add(String(cb.value)); });
            };

            const getSelectedScopeInfo = () => {
                const scopeVal = document.getElementById("qig-fd-scope").value || "global";
                if (scopeVal.startsWith("card:")) {
                    const cardKey = scopeVal.slice(5) || null;
                    return getNormalizedScopedRecord(FILTER_SCOPE_CARD, {
                        cardKey,
                        cardLabel: cardKey === currentCard.cardKey ? currentCard.cardLabel : getCardNameForFilters(cardKey),
                    });
                }
                if (scopeVal.startsWith("char:")) {
                    return getNormalizedScopedRecord(FILTER_SCOPE_CHAR, {
                        charId: scopeVal.slice(5) || null,
                    });
                }
                return getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL);
            };

            const renderPoolChoices = () => {
                syncSelectedPoolIds();
                const selectedScope = getSelectedScopeInfo();
                const poolChoices = getSelectablePoolsForFilterScope(selectedScope);
                const available = new Set(poolChoices.map(p => p.id));
                for (const id of [...selectedPoolIds]) {
                    if (!available.has(id)) selectedPoolIds.delete(id);
                }
                if (!selectedPoolIds.size) {
                    if (available.has(DEFAULT_FILTER_POOL_ID)) selectedPoolIds.add(DEFAULT_FILTER_POOL_ID);
                    else if (poolChoices[0]) selectedPoolIds.add(poolChoices[0].id);
                }
                if (!poolChoices.length) {
                    poolWrap.innerHTML = `<div class="qig-help">No pools available for this scope.</div>`;
                    return;
                }
                poolWrap.innerHTML = poolChoices.map(pool => {
                    const isChecked = selectedPoolIds.has(pool.id);
                    const poolScope = getScopedRecordFromEntity(pool);
                    const scopeBadge = poolScope.scope === FILTER_SCOPE_GLOBAL
                        ? '<span class="qig-scope-badge qig-scope-badge--global">G</span>'
                        : poolScope.scope === FILTER_SCOPE_CARD
                            ? '<span class="qig-scope-badge qig-scope-badge--card">Card</span>'
                            : '<span class="qig-scope-badge qig-scope-badge--char">Char</span>';
                    return `<label class="qig-pool-choice">
                        <input class="qig-fd-pool-cb" type="checkbox" value="${escapeHtml(pool.id)}" ${isChecked ? "checked" : ""}>
                        <span class="qig-pool-choice-name">${escapeHtml(pool.name)}</span>
                        ${scopeBadge}
                    </label>`;
                }).join("");
            };

            document.getElementById("qig-fd-name").focus();
            renderPoolChoices();
            document.getElementById("qig-fd-mode").onchange = (e) => {
                const llm = e.target.value === "LLM";
                document.getElementById("qig-fd-keywords-wrap").style.display = llm ? "none" : "";
                document.getElementById("qig-fd-desc-wrap").style.display = llm ? "" : "none";
            };
            document.getElementById("qig-fd-scope").onchange = renderPoolChoices;
            const close = (e) => {
                e?.preventDefault?.();
                e?.stopPropagation?.();
                popup.style.display = "none";
                resolve(null);
            };
            bindPopupDismiss(popup, close);
            document.getElementById("qig-fd-cancel").onclick = close;
            document.getElementById("qig-fd-save").onclick = (e) => {
                e?.preventDefault?.();
                e?.stopPropagation?.();
                const name = document.getElementById("qig-fd-name").value.trim();
                const mode = document.getElementById("qig-fd-mode").value;
                const keywords = document.getElementById("qig-fd-keywords").value.trim();
                const description = document.getElementById("qig-fd-description").value.trim();
                const seedInput = document.getElementById("qig-fd-seed").value.trim();
                if (!name) { alert("Name is required."); return; }
                if (mode === "LLM" && !description) { alert("Concept description is required for LLM mode."); return; }
                if (mode !== "LLM" && !keywords) { alert("Keywords are required."); return; }
                const seedOverride = seedInput === "" ? null : normalizeSeedOverride(seedInput);
                if (seedInput !== "" && seedOverride == null) {
                    alert("Seed Override must be a non-negative integer or left blank.");
                    return;
                }
                const selected = [...popup.querySelectorAll(".qig-fd-pool-cb:checked")].map(cb => String(cb.value));
                const selectedScope = getSelectedScopeInfo();
                const poolIds = finalizePoolIdsForScope(selected, selectedScope);
                if (!poolIds.length) { alert("Select at least one pool."); return; }
                popup.style.display = "none";
                resolve({
                    name,
                    keywords: mode === "LLM" ? "" : keywords,
                    matchMode: mode,
                    description: mode === "LLM" ? description : "",
                    positive: document.getElementById("qig-fd-positive").value.trim(),
                    negative: document.getElementById("qig-fd-negative").value.trim(),
                    removePositive: document.getElementById("qig-fd-remove-positive").value.trim(),
                    removeNegative: document.getElementById("qig-fd-remove-negative").value.trim(),
                    removeMode: "remove",
                    priority: parseInt(document.getElementById("qig-fd-priority").value) || 0,
                    scope: selectedScope.scope,
                    charId: selectedScope.charId,
                    cardKey: selectedScope.cardKey,
                    cardLabel: selectedScope.cardLabel,
                    poolIds,
                    seedOverride,
                });
            };
        }, { popupClass: "editor", contentClass: "qig-popup-content--editor", resizable: false });
    });
}

// CONTEXTUAL_FILTERS_CRUD_PLACEHOLDER

async function addContextualFilter() {
    const result = await showFilterDialog(null);
    if (!result) return;
    result.id = generateUUID();
    result.enabled = true;
    result.poolIds = normalizePoolIdList(result.poolIds);
    result.seedOverride = normalizeSeedOverride(result.seedOverride);
    result.sortOrder = getNextContextualFilterSortOrder(result);
    contextualFilters.push(result);
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

async function editContextualFilter(id) {
    const f = contextualFilters.find(x => x.id === id);
    if (!f) return;
    const result = await showFilterDialog(f);
    if (!result) return;
    const previousScopeKey = getContextualFilterScopeKey(f);
    Object.assign(f, result);
    f.poolIds = normalizePoolIdList(f.poolIds);
    f.seedOverride = normalizeSeedOverride(f.seedOverride);
    f.sortOrder = previousScopeKey === getContextualFilterScopeKey(f)
        ? normalizeContextualFilterSortOrder(f.sortOrder, getNextContextualFilterSortOrder(f, id))
        : getNextContextualFilterSortOrder(f, id);
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function deleteContextualFilter(id) {
    const idx = contextualFilters.findIndex(x => x.id === id);
    if (idx === -1) return;
    contextualFilters.splice(idx, 1);
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function toggleContextualFilter(id) {
    const f = contextualFilters.find(x => x.id === id);
    if (!f) return;
    f.enabled = !f.enabled;
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function clearContextualFilters() {
    const currentCharId = getCurrentCharId();
    const charName = getCurrentCharName();
    const currentCard = getCurrentCardScopeInfo();
    if (currentCard.cardKey || currentCharId != null) {
        const options = [
            { value: 1, label: "All filters" },
            { value: 2, label: "Global filters only" },
        ];
        if (currentCard.cardKey) {
            options.push({
                value: 3,
                label: `${currentCard.cardLabel || "Current card"} card-only filters`,
            });
        }
        if (currentCharId != null) {
            options.push({
                value: currentCard.cardKey ? 4 : 3,
                label: `${charName || "This character"} character-wide filters`,
            });
        }
        const choice = prompt(
            `Clear filters — type a number:\n${options.map(option => `${option.value}) ${option.label}`).join("\n")}\n\nCancel to abort.`
        );
        if (!choice) return;
        const n = parseInt(choice);
        if (n === 1) {
            contextualFilters = [];
        } else if (n === 2) {
            contextualFilters = contextualFilters.filter(filter => getScopedRecordFromEntity(filter).scope !== FILTER_SCOPE_GLOBAL);
        } else if (currentCard.cardKey && n === 3) {
            contextualFilters = contextualFilters.filter(filter => {
                const scopeInfo = getScopedRecordFromEntity(filter);
                return scopeInfo.scope !== FILTER_SCOPE_CARD || scopeInfo.cardKey !== currentCard.cardKey;
            });
        } else if ((currentCard.cardKey && n === 4) || (!currentCard.cardKey && n === 3)) {
            contextualFilters = contextualFilters.filter(filter => {
                const scopeInfo = getScopedRecordFromEntity(filter);
                return scopeInfo.scope !== FILTER_SCOPE_CHAR || String(scopeInfo.charId) !== String(currentCharId);
            });
        } else {
            return;
        }
    } else {
        if (!confirm("Clear all contextual filters?")) return;
        contextualFilters = [];
    }
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function buildCopiedContextualFilter(filter, { scope = FILTER_SCOPE_GLOBAL, charId = null, cardKey = null, cardLabel = null } = {}) {
    const targetScope = getNormalizedScopedRecord(scope, { charId, cardKey, cardLabel });
    return {
        ...JSON.parse(JSON.stringify(filter)),
        id: generateUUID(),
        scope: targetScope.scope,
        charId: targetScope.charId,
        cardKey: targetScope.cardKey,
        cardLabel: targetScope.cardLabel,
        poolIds: getMappedPoolIdsForCopiedFilter(filter.poolIds, targetScope),
        seedOverride: normalizeSeedOverride(filter.seedOverride),
        sortOrder: getNextContextualFilterSortOrder(targetScope),
    };
}

function duplicateContextualFilter(id) {
    const f = contextualFilters.find(x => x.id === id);
    if (!f) return;
    const scopeInfo = getScopedRecordFromEntity(f);
    const currentCard = getCurrentCardScopeInfo();
    const currentCharId = getCurrentCharId();
    let targetScope;
    if (scopeInfo.scope === FILTER_SCOPE_GLOBAL) {
        if (currentCard.cardKey) {
            targetScope = getNormalizedScopedRecord(FILTER_SCOPE_CARD, {
                cardKey: currentCard.cardKey,
                cardLabel: currentCard.cardLabel,
            });
        } else if (currentCharId != null) {
            targetScope = getNormalizedScopedRecord(FILTER_SCOPE_CHAR, { charId: currentCharId });
        } else {
            toastr.warning("Open a character card to duplicate this filter into scoped mode.");
            return;
        }
    } else {
        targetScope = getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL);
    }
    contextualFilters.push(buildCopiedContextualFilter(f, targetScope));
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function copyContextualFilterToScope(id, target = "global") {
    const filter = contextualFilters.find(entry => entry.id === id);
    if (!filter) return;
    if (target === "current-card" || (target === "current" && getCurrentCardKey())) {
        const currentCard = getCurrentCardScopeInfo();
        if (!currentCard.cardKey) {
            toastr.warning("Open a specific card chat to copy this filter into card-only scope.");
            return;
        }
        contextualFilters.push(buildCopiedContextualFilter(filter, {
            scope: FILTER_SCOPE_CARD,
            cardKey: currentCard.cardKey,
            cardLabel: currentCard.cardLabel,
        }));
    } else if (target === "current-char" || target === "current") {
        const currentCharId = getCurrentCharId();
        if (currentCharId == null) {
            toastr.warning("Open a character chat to copy this filter into character scope.");
            return;
        }
        contextualFilters.push(buildCopiedContextualFilter(filter, { scope: FILTER_SCOPE_CHAR, charId: String(currentCharId) }));
    } else {
        contextualFilters.push(buildCopiedContextualFilter(filter, { scope: FILTER_SCOPE_GLOBAL }));
    }
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function copyFilterPoolToCurrentCard(poolId) {
    const pool = filterPools.find(entry => entry.id === poolId);
    if (!pool) return;
    const currentCard = getCurrentCardScopeInfo();
    if (!currentCard.cardKey) {
        toastr.warning("Open a specific card chat to copy this pool into card-only scope.");
        return;
    }
    const existing = findFilterPoolByName(pool.name, {
        scope: FILTER_SCOPE_CARD,
        cardKey: currentCard.cardKey,
    });
    ensureFilterPoolByName(pool.name, {
        scope: FILTER_SCOPE_CARD,
        cardKey: currentCard.cardKey,
        cardLabel: currentCard.cardLabel,
        enable: true,
    });
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
    if (existing) {
        toastr.info(`Pool "${pool.name}" already exists for the current card.`);
    }
}

function copyFilterPoolToCurrentChar(poolId) {
    const pool = filterPools.find(entry => entry.id === poolId);
    if (!pool) return;
    const currentCharId = getCurrentCharId();
    if (currentCharId == null) {
        toastr.warning("Open a character chat to copy this pool into character scope.");
        return;
    }
    const existing = findFilterPoolByName(pool.name, { scope: FILTER_SCOPE_CHAR, charId: String(currentCharId) });
    ensureFilterPoolByName(pool.name, { scope: FILTER_SCOPE_CHAR, charId: String(currentCharId), enable: true });
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
    if (existing) {
        toastr.info(`Pool "${pool.name}" already exists for the current character.`);
    }
}

function copyFilterPoolToCurrentScope(poolId) {
    if (getCurrentCardKey()) {
        copyFilterPoolToCurrentCard(poolId);
        return;
    }
    copyFilterPoolToCurrentChar(poolId);
}

function setContextualFilterManagerScope(value) {
    filterManagerUiState.selectedScopeCharId = value || FILTER_MANAGER_SCOPE_GLOBAL_ONLY;
    filterManagerUiState.draggedFilterId = null;
    filterManagerUiState.dropTargetFilterId = null;
    filterManagerUiState.dropPosition = "after";
    renderContextualFilters();
}

function setContextualFilterManagerHideInactive(enabled) {
    filterManagerUiState.hideInactive = !!enabled;
    renderContextualFilters();
}

function clearContextualFilterManagerDragState() {
    filterManagerUiState.draggedFilterId = null;
    filterManagerUiState.dropTargetFilterId = null;
    filterManagerUiState.dropPosition = "after";
}

function moveContextualFilter(draggedId, targetId, position = "after") {
    if (!draggedId || !targetId || draggedId === targetId) return;

    const dragged = contextualFilters.find(filter => filter.id === draggedId);
    const target = contextualFilters.find(filter => filter.id === targetId);
    if (!dragged || !target) return;

    if (getContextualFilterScopeKey(dragged) !== getContextualFilterScopeKey(target)) {
        clearContextualFilterManagerDragState();
        return;
    }
    if (getContextualFilterPriorityValue(dragged) !== getContextualFilterPriorityValue(target)) {
        clearContextualFilterManagerDragState();
        toastr.info("Drag reordering keeps filters grouped by priority. Drag within the same priority block.");
        renderContextualFilters();
        return;
    }

    const scopeKey = getContextualFilterScopeKey(dragged);
    const scopedFilters = contextualFilters
        .filter(filter => getContextualFilterScopeKey(filter) === scopeKey)
        .sort(compareContextualFilters);
    const draggedIndex = scopedFilters.findIndex(filter => filter.id === draggedId);
    if (draggedIndex === -1) return;

    const [draggedFilter] = scopedFilters.splice(draggedIndex, 1);
    const targetIndex = scopedFilters.findIndex(filter => filter.id === targetId);
    if (targetIndex === -1) return;
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    scopedFilters.splice(insertIndex, 0, draggedFilter);
    scopedFilters.forEach((filter, index) => {
        filter.sortOrder = index;
    });

    clearContextualFilterManagerDragState();
    ensureFilterPoolsState({ persist: true });
    renderContextualFilters();
}

function getContextualFiltersSummaryViewState() {
    ensureFilterPoolsState();
    const currentCard = getCurrentCardScopeInfo();
    const currentCharId = getCurrentCharId();
    const charName = getCurrentCharName();
    const activeCharIds = new Set(getActiveCharacterScopeIds());
    const globalFilters = contextualFilters
        .filter(filter => getScopedRecordFromEntity(filter).scope === FILTER_SCOPE_GLOBAL)
        .sort(compareContextualFilters);
    const cardFilters = currentCard.cardKey
        ? contextualFilters.filter(filter => {
            const scopeInfo = getScopedRecordFromEntity(filter);
            return scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey === currentCard.cardKey;
        }).sort(compareContextualFilters)
        : [];
    const charFilters = activeCharIds.size
        ? contextualFilters.filter(filter => {
            const scopeInfo = getScopedRecordFromEntity(filter);
            return scopeInfo.scope === FILTER_SCOPE_CHAR && activeCharIds.has(String(scopeInfo.charId));
        }).sort(compareContextualFilters)
        : [];
    const enabledPoolIds = getEnabledPoolIdsForCurrentContext();
    const { globalPools } = getVisibleFilterPools(getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL));
    const cardPools = currentCard.cardKey
        ? getVisibleFilterPools(getNormalizedScopedRecord(FILTER_SCOPE_CARD, {
            cardKey: currentCard.cardKey,
            cardLabel: currentCard.cardLabel,
        })).scopedPools
        : [];
    const charPools = currentCharId != null
        ? getVisibleFilterPools(getNormalizedScopedRecord(FILTER_SCOPE_CHAR, {
            charId: currentCharId,
        })).scopedPools
        : [];
    const visibleFilters = [...globalFilters, ...cardFilters, ...charFilters];
    const activeVisibleCount = visibleFilters.filter(filter => isContextualFilterEffective(filter, enabledPoolIds)).length;
    const seededFilterCount = visibleFilters.filter(filter => normalizeSeedOverride(filter?.seedOverride) != null).length;
    const otherScopeCount = getContextualFilterScopeOptions().filter(option =>
        option.value !== FILTER_MANAGER_SCOPE_CURRENT_CARD &&
        option.value !== FILTER_MANAGER_SCOPE_CURRENT_CHAR &&
        option.value !== FILTER_MANAGER_SCOPE_GLOBAL_ONLY
    ).length;
    return {
        currentCardKey: currentCard.cardKey,
        currentCardLabel: currentCard.cardLabel,
        currentCharId,
        charName,
        enabledPoolIds,
        globalPools,
        cardPools,
        charPools,
        cardFilters,
        charFilters,
        visibleFilters,
        activeVisibleCount,
        seededFilterCount,
        otherScopeCount,
    };
}

function renderContextualFiltersSummary(container, viewState = getContextualFiltersSummaryViewState()) {
    if (!container) return;
    const totalPools = viewState.globalPools.length + viewState.cardPools.length + viewState.charPools.length;
    const scopeLabel = viewState.currentCardKey
        ? `${viewState.currentCardLabel || "Current card"} + character scope`
        : (viewState.currentCharId != null ? (viewState.charName || "Current character") : "Global-only context");
    const scopeParts = [];
    if (viewState.cardFilters.length) scopeParts.push(`${viewState.cardFilters.length} card-only`);
    if (viewState.charFilters.length) scopeParts.push(`${viewState.charFilters.length} character-wide`);
    const hiddenNote = scopeParts.length
        ? `Current context includes ${scopeParts.join(" and ")} filter(s), plus global filters.${viewState.otherScopeCount > 0 ? ` Manage Filters can browse ${viewState.otherScopeCount} other saved scope(s).` : ""}`
        : (viewState.otherScopeCount > 0
            ? `Manage Filters can browse ${viewState.otherScopeCount} other saved scope(s) without switching chats.`
            : "This summary is showing filters available in the current context.");
    container.innerHTML = `
        <div class="qig-filter-summary">
            <div class="qig-filter-summary-grid">
                <div class="qig-filter-summary-card">
                    <span class="qig-filter-summary-label">Visible Filters</span>
                    <strong>${viewState.visibleFilters.length}</strong>
                    <small>${scopeLabel}</small>
                </div>
                <div class="qig-filter-summary-card">
                    <span class="qig-filter-summary-label">Active Now</span>
                    <strong>${viewState.activeVisibleCount}</strong>
                    <small>${viewState.enabledPoolIds.size} enabled pool(s)</small>
                </div>
                <div class="qig-filter-summary-card">
                    <span class="qig-filter-summary-label">Seed Overrides</span>
                    <strong>${viewState.seededFilterCount}</strong>
                    <small>${totalPools} pool(s) available</small>
                </div>
            </div>
            <p class="qig-filter-summary-note">${hiddenNote}</p>
            <button id="qig-manage-filters-btn-inline" class="menu_button" onclick="showContextualFilterManager()">Manage Filters</button>
        </div>`;
}

function getContextualFilterManagerViewState() {
    ensureFilterPoolsState();
    const scopeOptions = getContextualFilterScopeOptions();
    const selectedScopeValue = ensureContextualFilterManagerScopeSelection(scopeOptions);
    const currentCard = getCurrentCardScopeInfo();
    const currentCharId = getCurrentCharId();
    const currentCharKey = currentCharId != null ? String(currentCharId) : null;
    const viewedScope = getSelectedFilterManagerScopeDescriptor(selectedScopeValue);
    const knownCharNames = getKnownFilterScopeCharacterMap();
    const knownCardNames = getKnownFilterScopeCardMap();
    const viewedScopeLabel = viewedScope.scope === FILTER_SCOPE_CARD
        ? getCardNameForFilters(viewedScope.cardKey, knownCardNames)
        : viewedScope.scope === FILTER_SCOPE_CHAR
            ? getCharacterNameForFilters(viewedScope.charId, knownCharNames)
            : null;
    const isViewingCurrentCardScope = viewedScope.scope === FILTER_SCOPE_CARD && !!currentCard.cardKey && viewedScope.cardKey === currentCard.cardKey;
    const isViewingCurrentCharScope = viewedScope.scope === FILTER_SCOPE_CHAR && currentCharKey != null && viewedScope.charId === currentCharKey;
    const enabledPoolIds = getEnabledPoolIdsForScope(viewedScope);
    const { globalPools, scopedPools } = getVisibleFilterPools(viewedScope);
    const globalFilters = contextualFilters
        .filter(filter => getScopedRecordFromEntity(filter).scope === FILTER_SCOPE_GLOBAL)
        .sort(compareContextualFilters);
    const scopedFilters = contextualFilters.filter(filter => {
        const scopeInfo = getScopedRecordFromEntity(filter);
        if (viewedScope.scope === FILTER_SCOPE_CARD) {
            return scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey === viewedScope.cardKey;
        }
        if (viewedScope.scope === FILTER_SCOPE_CHAR) {
            return scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId === viewedScope.charId;
        }
        return false;
    }).sort(compareContextualFilters);

    const displayGlobalPools = filterManagerUiState.hideInactive
        ? globalPools.filter(pool => enabledPoolIds.has(pool.id))
        : globalPools;
    const displayScopedPools = filterManagerUiState.hideInactive
        ? scopedPools.filter(pool => enabledPoolIds.has(pool.id))
        : scopedPools;
    const displayGlobalFilters = filterManagerUiState.hideInactive
        ? globalFilters.filter(filter => isContextualFilterEffective(filter, enabledPoolIds))
        : globalFilters;
    const displayScopedFilters = filterManagerUiState.hideInactive
        ? scopedFilters.filter(filter => isContextualFilterEffective(filter, enabledPoolIds))
        : scopedFilters;

    return {
        scopeOptions,
        selectedScopeValue,
        currentCardKey: currentCard.cardKey,
        currentCardLabel: currentCard.cardLabel,
        currentCharId: currentCharKey,
        currentCharName: getCurrentCharName(),
        viewedScope,
        viewedScopeLabel,
        isViewingCurrentCharScope,
        isViewingCurrentCardScope,
        isViewingCurrentScope: viewedScope.scope === FILTER_SCOPE_GLOBAL || isViewingCurrentCardScope || isViewingCurrentCharScope,
        isBrowsingOtherScope: viewedScope.scope !== FILTER_SCOPE_GLOBAL && !isViewingCurrentCardScope && !isViewingCurrentCharScope,
        enabledPoolIds,
        hideInactive: !!filterManagerUiState.hideInactive,
        globalPools,
        scopedPools,
        displayGlobalPools,
        displayScopedPools,
        globalFilters,
        scopedFilters,
        displayGlobalFilters,
        displayScopedFilters,
        visibleFilters: [...globalFilters, ...scopedFilters],
        displayFilters: [...displayGlobalFilters, ...displayScopedFilters],
        visiblePools: [...globalPools, ...scopedPools],
        displayPools: [...displayGlobalPools, ...displayScopedPools],
        activeVisibleCount: [...globalFilters, ...scopedFilters].filter(filter => isContextualFilterEffective(filter, enabledPoolIds)).length,
        seededFilterCount: [...globalFilters, ...scopedFilters].filter(filter => normalizeSeedOverride(filter?.seedOverride) != null).length,
    };
}

function getScopeBadgeMeta(scope) {
    if (scope === FILTER_SCOPE_CARD) {
        return {
            className: "qig-scope-badge--card",
            label: "Card",
        };
    }
    if (scope === FILTER_SCOPE_CHAR) {
        return {
            className: "qig-scope-badge--char",
            label: "Char",
        };
    }
    return {
        className: "qig-scope-badge--global",
        label: "G",
    };
}

function showContextualFilterManager() {
    resetContextualFilterManagerState();
    return createPopup("qig-filter-manager-popup", "Contextual Filters", `
        <div class="qig-filter-manager-shell">
            <div id="qig-filter-manager-actions" class="qig-filter-manager-topbar"></div>
            <div class="qig-filter-manager-grid">
                <section class="qig-filter-manager-pane">
                    <div class="qig-filter-manager-pane-header">Pools</div>
                    <div id="qig-filter-manager-pools" class="qig-filter-manager-scroll"></div>
                </section>
                <section class="qig-filter-manager-pane">
                    <div class="qig-filter-manager-pane-header">Filters</div>
                    <div id="qig-filter-manager-filters" class="qig-filter-manager-scroll"></div>
                </section>
            </div>
        </div>`, (popup) => {
        renderContextualFilterManager(popup);
    }, { popupClass: "manager", contentClass: "qig-popup-content--wide", resizable: false });
}

function bindContextualFilterManagerDragHandlers(popup) {
    if (!popup) return;
    const clearDropClasses = () => {
        popup.querySelectorAll(".qig-manager-row--drop-before, .qig-manager-row--drop-after").forEach(row => {
            row.classList.remove("qig-manager-row--drop-before", "qig-manager-row--drop-after");
        });
    };

    popup.querySelectorAll(".qig-filter-drag-handle").forEach(handle => {
        handle.addEventListener("dragstart", (event) => {
            const draggedId = String(handle.dataset.filterId || "");
            if (!draggedId) return;
            filterManagerUiState.draggedFilterId = draggedId;
            filterManagerUiState.dropTargetFilterId = null;
            filterManagerUiState.dropPosition = "after";
            popup.classList.add("qig-filter-manager--dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggedId);
        });

        handle.addEventListener("dragend", () => {
            clearDropClasses();
            popup.classList.remove("qig-filter-manager--dragging");
            clearContextualFilterManagerDragState();
        });
    });

    popup.querySelectorAll(".qig-manager-row[data-filter-id]").forEach(row => {
        row.addEventListener("dragover", (event) => {
            const draggedId = filterManagerUiState.draggedFilterId;
            const targetId = String(row.dataset.filterId || "");
            if (!draggedId || !targetId || draggedId === targetId) return;

            const dragged = contextualFilters.find(filter => filter.id === draggedId);
            const target = contextualFilters.find(filter => filter.id === targetId);
            if (!dragged || !target) return;
            if (getContextualFilterScopeKey(dragged) !== getContextualFilterScopeKey(target)) return;
            if (getContextualFilterPriorityValue(dragged) !== getContextualFilterPriorityValue(target)) return;

            event.preventDefault();
            const bounds = row.getBoundingClientRect();
            const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
            filterManagerUiState.dropTargetFilterId = targetId;
            filterManagerUiState.dropPosition = position;
            clearDropClasses();
            row.classList.add(position === "before" ? "qig-manager-row--drop-before" : "qig-manager-row--drop-after");
        });

        row.addEventListener("drop", (event) => {
            event.preventDefault();
            const draggedId = filterManagerUiState.draggedFilterId;
            const targetId = String(row.dataset.filterId || "");
            if (!draggedId || !targetId) return;
            const position = filterManagerUiState.dropPosition || "after";
            clearDropClasses();
            popup.classList.remove("qig-filter-manager--dragging");
            moveContextualFilter(draggedId, targetId, position);
        });
    });
}

function renderContextualFilterManager(popup = document.getElementById("qig-filter-manager-popup"), viewState = getContextualFilterManagerViewState()) {
    if (!popup) return;
    const actionContainer = popup.querySelector("#qig-filter-manager-actions");
    const poolsContainer = popup.querySelector("#qig-filter-manager-pools");
    const filtersContainer = popup.querySelector("#qig-filter-manager-filters");
    if (!actionContainer || !poolsContainer || !filtersContainer) return;

    const renderScopeBadge = (scope, title) => {
        const meta = getScopeBadgeMeta(scope);
        return `<span class="qig-scope-badge ${meta.className}" title="${escapeHtml(title)}">${escapeHtml(meta.label)}</span>`;
    };
    const formatSectionTitle = (label, shown, total) => `${label} (${shown}${shown !== total ? `/${total}` : ""})`;

    const renderPoolRow = (pool) => {
        const poolScope = getScopedRecordFromEntity(pool);
        const isActive = viewState.enabledPoolIds.has(pool.id);
        const assignedCount = contextualFilters.filter(f => normalizePoolIdList(f.poolIds).includes(pool.id)).length;
        const canDelete = pool.id !== DEFAULT_FILTER_POOL_ID;
        const isEditable = true;
        if (!isEditable) {
            return `<div class="qig-manager-row qig-manager-row--readonly ${isActive ? "" : "qig-manager-row--dimmed"}">
                <button class="menu_button qig-manager-main-button ${isActive ? "qig-manager-main-button--active" : ""} qig-manager-main-button--readonly" title="Browse mode: copy this pool into another scope">${isActive ? "✅" : "⬜"} ${escapeHtml(pool.name)} (${assignedCount})</button>
                ${renderScopeBadge(poolScope.scope, poolScope.scope === FILTER_SCOPE_GLOBAL ? "Global pool" : poolScope.scope === FILTER_SCOPE_CARD ? "Card-only pool" : "Character-wide pool")}
                ${viewState.currentCardKey ? `<button class="menu_button qig-manager-copy-button" onclick="copyFilterPoolToCurrentCard('${escapeHtml(pool.id)}')" title="Copy pool to the current card">Copy to Card</button>` : ""}
                ${viewState.currentCharId != null ? `<button class="menu_button qig-manager-copy-button" onclick="copyFilterPoolToCurrentChar('${escapeHtml(pool.id)}')" title="Copy pool to the current character">Copy to Char</button>` : `<span class="qig-manager-muted-inline">Read-only</span>`}
            </div>`;
        }
        return `<div class="qig-manager-row ${isActive ? "" : "qig-manager-row--dimmed"}">
            <button class="menu_button qig-manager-main-button ${isActive ? "qig-manager-main-button--active" : ""}" onclick="toggleFilterPool('${escapeHtml(pool.id)}')" title="Toggle pool">${isActive ? "✅" : "⬜"} ${escapeHtml(pool.name)} (${assignedCount})</button>
            ${renderScopeBadge(poolScope.scope, poolScope.scope === FILTER_SCOPE_GLOBAL ? "Global pool" : poolScope.scope === FILTER_SCOPE_CARD ? "Card-only pool" : "Character-wide pool")}
            <button class="menu_button qig-manager-icon-button" onclick="renameFilterPool('${escapeHtml(pool.id)}')" title="Rename pool">✎</button>
            <button class="menu_button qig-manager-icon-button" onclick="deleteFilterPool('${escapeHtml(pool.id)}')" ${canDelete ? "" : "disabled"} title="Delete pool">🗑️</button>
        </div>`;
    };

    const renderRow = (f) => {
        const eName = escapeHtml(f.name);
        const eDesc = escapeHtml(f.description || "");
        const eKeywords = escapeHtml(f.keywords || "");
        const eRemovePos = escapeHtml(f.removePositive || "");
        const eRemoveNeg = escapeHtml(f.removeNegative || "");
        const eId = escapeHtml(f.id);
        const eMode = escapeHtml(f.matchMode);
        const eDetail = f.matchMode === "LLM" ? eDesc : eKeywords;
        const eRemovalInfo = [
            eRemovePos ? `Remove +: ${eRemovePos}` : "",
            eRemoveNeg ? `Remove -: ${eRemoveNeg}` : "",
        ].filter(Boolean).join("\n");
        const poolNames = normalizePoolIdList(f.poolIds).map(id => getPoolNameById(id));
        const poolInfo = poolNames.length ? `Pools: ${poolNames.join(", ")}` : `Pools: ${DEFAULT_FILTER_POOL_NAME}`;
        const ePoolInfo = escapeHtml(poolInfo);
        const filterScope = getScopedRecordFromEntity(f);
        const isGlobal = filterScope.scope === FILTER_SCOPE_GLOBAL;
        const effectiveEnabled = isContextualFilterEffective(f, viewState.enabledPoolIds);
        const seedOverride = normalizeSeedOverride(f.seedOverride);
        const statusParts = [
            f.matchMode === "LLM" ? "\u{1F916} LLM" : eMode,
            `p${f.priority || 0}`,
            seedOverride != null ? `seed ${seedOverride}` : "",
            effectiveEnabled ? "" : "off",
        ].filter(Boolean).join(" ");
        const isEditable = true;
        const scopeLabel = filterScope.scope === FILTER_SCOPE_CARD
            ? `Card Only: ${filterScope.cardLabel || getCardNameForFilters(filterScope.cardKey)}`
            : filterScope.scope === FILTER_SCOPE_CHAR
                ? `Character: ${getCharacterNameForFilters(filterScope.charId)}`
                : "Global";
        const tooltip = `${scopeLabel}\n${eMode}: ${eDetail}\nPriority: ${f.priority}\n${seedOverride != null ? `Seed Override: ${seedOverride}\n` : ""}${ePoolInfo}${eRemovalInfo ? `\n${eRemovalInfo}` : ""}`;
        const rowClasses = [
            "qig-manager-row",
            effectiveEnabled ? "" : "qig-manager-row--dimmed",
            isEditable ? "" : "qig-manager-row--readonly",
            filterManagerUiState.dropTargetFilterId === f.id
                ? (filterManagerUiState.dropPosition === "before" ? "qig-manager-row--drop-before" : "qig-manager-row--drop-after")
                : "",
        ].filter(Boolean).join(" ");

        if (!isEditable) {
            return `<div class="${rowClasses}">` +
            `<span class="qig-manager-drag-placeholder" title="Browse mode">⋮⋮</span>` +
            renderScopeBadge(filterScope.scope, filterScope.scope === FILTER_SCOPE_CARD ? "Card-only filter" : filterScope.scope === FILTER_SCOPE_CHAR ? "Character-wide filter" : "Global filter") +
            `<button class="menu_button qig-manager-main-button qig-manager-main-button--readonly" title="${tooltip}">${eName}</button>` +
            `<span class="qig-filter-status">${escapeHtml(statusParts)}</span>` +
            `${viewState.currentCardKey ? `<button class="menu_button qig-manager-copy-button" onclick="copyContextualFilterToScope('${eId}', 'current-card')" title="Copy filter to the current card">Copy to Card</button>` : ""}` +
            `${viewState.currentCharId != null ? `<button class="menu_button qig-manager-copy-button" onclick="copyContextualFilterToScope('${eId}', 'current-char')" title="Copy filter to the current character">Copy to Char</button>` : ""}` +
            `<button class="menu_button qig-manager-copy-button" onclick="copyContextualFilterToScope('${eId}', 'global')" title="Copy filter to global scope">Copy to Global</button>` +
            `</div>`;
        }

        const duplicateTargetLabel = isGlobal
            ? (viewState.currentCardKey ? "card" : viewState.currentCharId != null ? "character" : "scoped")
            : "global";
        return `<div class="${rowClasses}" data-filter-id="${eId}">` +
        `<button class="menu_button qig-manager-icon-button qig-filter-drag-handle" type="button" draggable="true" data-filter-id="${eId}" title="Drag to reorder filters with the same priority">⋮⋮</button>` +
        `<input type="checkbox" ${f.enabled ? "checked" : ""} onchange="toggleContextualFilter('${eId}')" title="Enable/disable">` +
        renderScopeBadge(filterScope.scope, filterScope.scope === FILTER_SCOPE_CARD ? "Card-only filter" : filterScope.scope === FILTER_SCOPE_CHAR ? "Character-wide filter" : "Global filter") +
        `<button class="menu_button qig-manager-main-button" onclick="editContextualFilter('${eId}')" title="${tooltip}">${eName}</button>` +
        `<span class="qig-filter-status">${escapeHtml(statusParts)}</span>` +
        `<button class="menu_button qig-manager-icon-button" onclick="duplicateContextualFilter('${eId}')" title="Duplicate to ${duplicateTargetLabel} scope">\u29C9</button>` +
        `<button class="menu_button qig-manager-icon-button" onclick="deleteContextualFilter('${eId}')" title="Delete filter">×</button>` +
        `</div>`;
    };

    let poolHtml = "";
    if (viewState.globalPools.length) {
        poolHtml += `<div class="qig-manager-section-title">${formatSectionTitle("Global Pools", viewState.displayGlobalPools.length, viewState.globalPools.length)}</div>`;
        poolHtml += viewState.displayGlobalPools.map(renderPoolRow).join("");
    }
    if (viewState.scopedPools.length) {
        const scopedPoolLabel = viewState.viewedScope.scope === FILTER_SCOPE_CARD
            ? `${viewState.viewedScopeLabel || "Card"} Pools`
            : `${viewState.viewedScopeLabel || "Character"} Pools`;
        poolHtml += `<div class="qig-manager-section-title">${escapeHtml(formatSectionTitle(scopedPoolLabel, viewState.displayScopedPools.length, viewState.scopedPools.length))}</div>`;
        poolHtml += viewState.displayScopedPools.map(renderPoolRow).join("");
    }
    if (!poolHtml) poolHtml = `<div class="qig-help">No pools available yet. Create one from the toolbar above.</div>`;

    let html = "";
    if (viewState.globalFilters.length) {
        html += `<div class="qig-manager-section-title">${formatSectionTitle("Global Filters", viewState.displayGlobalFilters.length, viewState.globalFilters.length)}</div>`;
        html += viewState.displayGlobalFilters.map(renderRow).join("");
    }
    if (viewState.scopedFilters.length) {
        const scopedFilterLabel = viewState.viewedScope.scope === FILTER_SCOPE_CARD
            ? `${viewState.viewedScopeLabel || "Card"} Filters`
            : `${viewState.viewedScopeLabel || "Character"} Filters`;
        html += `<div class="qig-manager-section-title">${escapeHtml(formatSectionTitle(scopedFilterLabel, viewState.displayScopedFilters.length, viewState.scopedFilters.length))}</div>`;
        html += viewState.displayScopedFilters.map(renderRow).join("");
    }
    if (!viewState.displayFilters.length && viewState.visibleFilters.length && viewState.hideInactive) {
        html += `<div class="qig-manager-muted">All filters in this view are currently inactive.</div>`;
    }
    if (!html) {
        html = `<div class="qig-help">No filters yet. Add one to get started.</div>`;
    }

    const scopeOptionsHtml = viewState.scopeOptions.map(option => `
        <option value="${escapeHtml(String(option.value))}" ${String(option.value) === String(viewState.selectedScopeValue) ? "selected" : ""}>
            ${escapeHtml(option.label)}
        </option>
    `).join("");
    const scopeSummary = viewState.viewedScope.scope === FILTER_SCOPE_CARD
        ? `Card: ${escapeHtml(viewState.viewedScopeLabel || "Current")} + global`
        : viewState.viewedScope.scope === FILTER_SCOPE_CHAR
            ? `Character: ${escapeHtml(viewState.viewedScopeLabel || "Current")} + global`
            : "Global only";
    const browseSummary = viewState.isBrowsingOtherScope
        ? ` Browsing another ${viewState.viewedScope.scope === FILTER_SCOPE_CARD ? "card" : "character"} scope; edits here apply directly to that saved scope.`
        : "";
    const hiddenSummary = viewState.hideInactive && viewState.displayFilters.length !== viewState.visibleFilters.length
        ? ` Showing ${viewState.displayFilters.length} after hiding inactive rows.`
        : "";

    actionContainer.innerHTML = `
        <div class="qig-filter-manager-controls">
            <label class="qig-filter-manager-scope">
                <span>Scope</span>
                <select id="qig-filter-manager-scope" onchange="setContextualFilterManagerScope(this.value)">
                    ${scopeOptionsHtml}
                </select>
            </label>
            <label class="checkbox_label qig-filter-manager-hide-inactive">
                <input type="checkbox" ${viewState.hideInactive ? "checked" : ""} onchange="setContextualFilterManagerHideInactive(this.checked)">
                <span>Hide inactive</span>
            </label>
        </div>
        <div class="qig-filter-manager-actions">
            <button class="menu_button" onclick="addFilterPoolGlobal()">+ Global Pool</button>
            <button class="menu_button" onclick="addFilterPoolForCurrentCard()">+ Card Pool</button>
            <button class="menu_button" onclick="addFilterPoolForCurrentChar()">+ Char Pool</button>
            <button class="menu_button" onclick="setVisiblePoolsEnabled(true)">Enable Shown Pools</button>
            <button class="menu_button" onclick="setVisiblePoolsEnabled(false)">Disable Shown Pools</button>
            <button class="menu_button" onclick="addContextualFilter()">+ Add Filter</button>
            <button class="menu_button" onclick="clearContextualFilters()">Clear All</button>
        </div>
        <div class="qig-filter-manager-summary">
            Viewing ${scopeSummary}. ${viewState.visibleFilters.length} filter(s), ${viewState.activeVisibleCount} active, ${viewState.seededFilterCount} with seed overrides.${hiddenSummary}${browseSummary}
        </div>`;
    poolsContainer.innerHTML = poolHtml;
    filtersContainer.innerHTML = html;
    bindContextualFilterManagerDragHandlers(popup);
}

function renderContextualFilters() {
    const container = document.getElementById("qig-contextual-filters");
    if (container) renderContextualFiltersSummary(container, getContextualFiltersSummaryViewState());
    const popup = document.getElementById("qig-filter-manager-popup");
    if (popup && popup.style.display !== "none") {
        renderContextualFilterManager(popup, getContextualFilterManagerViewState());
    }
}

window.addContextualFilter = addContextualFilter;
window.editContextualFilter = editContextualFilter;
window.deleteContextualFilter = deleteContextualFilter;
window.toggleContextualFilter = toggleContextualFilter;
window.clearContextualFilters = clearContextualFilters;
window.duplicateContextualFilter = duplicateContextualFilter;
window.copyContextualFilterToScope = copyContextualFilterToScope;
window.copyFilterPoolToCurrentScope = copyFilterPoolToCurrentScope;
window.copyFilterPoolToCurrentCard = copyFilterPoolToCurrentCard;
window.copyFilterPoolToCurrentChar = copyFilterPoolToCurrentChar;
window.showContextualFilterManager = showContextualFilterManager;
window.setContextualFilterManagerScope = setContextualFilterManagerScope;
window.setContextualFilterManagerHideInactive = setContextualFilterManagerHideInactive;
window.addFilterPoolGlobal = () => addFilterPool("global");
window.addFilterPoolForCurrentCard = () => addFilterPool("card");
window.addFilterPoolForCurrentChar = () => addFilterPool("char");
window.renameFilterPool = renameFilterPool;
window.deleteFilterPool = deleteFilterPool;
window.toggleFilterPool = toggleFilterPool;
window.setVisiblePoolsEnabled = setVisiblePoolsEnabled;

// Character-specific settings
let charSettingsBaseState = null;
let charSettingsBaseCharId = null;

function getCurrentRefImages(s) {
    if (s.provider === "proxy") return s.proxyRefImages || [];
    if (s.provider === "nanobanana") return s.nanobananaRefImages || [];
    if (s.provider === "nanogpt") return s.nanogptRefImages || [];
    return [];
}

function cloneCharScopedState(s = getSettings()) {
    return {
        prompt: s.prompt,
        negativePrompt: s.negativePrompt,
        style: s.style,
        width: s.width,
        height: s.height,
        proxyRefImages: [...(s.proxyRefImages || [])],
        nanobananaRefImages: [...(s.nanobananaRefImages || [])],
        nanogptRefImages: [...(s.nanogptRefImages || [])],
    };
}

function applyCharScopedState(state, s = getSettings()) {
    if (!state) return;

    // Detect if user has manually edited the prompt field
    const promptEl = document.getElementById("qig-prompt");
    const hasManualPromptEdit = promptEl && promptEl.value !== s.prompt;

    // Only apply character-scoped prompt if there's no manual edit
    if (!hasManualPromptEdit) {
        s.prompt = state.prompt ?? defaultSettings.prompt;
    } else {
        log(`[Prompt] Preserving manual edit, not applying character-scoped prompt`);
    }

    s.negativePrompt = state.negativePrompt ?? defaultSettings.negativePrompt;
    s.style = state.style ?? defaultSettings.style;
    s.width = state.width ?? defaultSettings.width;
    s.height = state.height ?? defaultSettings.height;
    s.proxyRefImages = [...(state.proxyRefImages || [])];
    s.nanobananaRefImages = [...(state.nanobananaRefImages || [])];
    s.nanogptRefImages = [...(state.nanogptRefImages || [])];

    const negativeEl = document.getElementById("qig-negative");
    const styleEl = document.getElementById("qig-style");
    const widthEl = document.getElementById("qig-width");
    const heightEl = document.getElementById("qig-height");

    // Only update textarea value if we applied character-scoped prompt
    if (promptEl && !hasManualPromptEdit) {
        promptEl.value = s.prompt ?? "";
    }

    if (negativeEl) negativeEl.value = s.negativePrompt ?? "";
    if (styleEl) styleEl.value = s.style ?? defaultSettings.style;
    if (widthEl) widthEl.value = s.width ?? defaultSettings.width;
    if (heightEl) heightEl.value = s.height ?? defaultSettings.height;

    if (s.provider === "novelai") {
        normalizeSize(s);
        syncNaiResolutionSelect();
    }
    syncSizeInputs(s.width, s.height);
    renderRefImages();
    renderNanobananaRefImages();
    renderNanogptRefImages();
}

function getCurrentCharId() {
    const ctx = getContext();
    return ctx?.characterId ?? null;
}

function getCurrentCharName() {
    const entry = getCurrentCharacterEntry();
    return entry?.name || entry?.avatar || null;
}

function getCurrentCardKey() {
    return getCurrentCardScopeInfo().cardKey;
}

function getCurrentCardLabel() {
    return getCurrentCardScopeInfo().cardLabel;
}

function getKnownFilterScopeCharacterMap(ctx = getContext()) {
    const known = new Map();
    for (const entry of getContextCharactersList(ctx)) {
        if (!entry?.id) continue;
        const key = String(entry.id);
        const name = String(entry.name || entry.avatar || `Character ${key}`).trim();
        if (!known.has(key) && name) known.set(key, name);
    }

    const profile = resolveChatProfileContext(ctx);
    profile.charIds.forEach((charId, index) => {
        const key = String(charId);
        if (known.has(key)) return;
        const name = String(profile.charNames[index] || `Character ${key}`).trim();
        if (name) known.set(key, name);
    });

    if (ctx?.characterId != null) {
        const key = String(ctx.characterId);
        if (!known.has(key)) {
            known.set(key, String(getCurrentCharName() || `Character ${key}`));
        }
    }

    return known;
}

function getCharacterNameForFilters(charId, knownMap = getKnownFilterScopeCharacterMap()) {
    const key = String(charId ?? "").trim();
    if (!key) return "Character";
    return knownMap.get(key) || `Character ${key}`;
}

function getKnownFilterScopeCardMap(ctx = getContext()) {
    const known = new Map();
    for (const entry of getContextCharactersList(ctx)) {
        const rawCardKey = String(entry?.avatar || entry?.data?.avatar || "").trim();
        const cardKey = normalizeCardScopeKey(rawCardKey);
        if (!cardKey || known.has(cardKey)) continue;
        known.set(cardKey, normalizeScopeLabel(entry?.name || entry?.avatar) || formatCardScopeFallbackLabel(rawCardKey));
    }

    const currentCard = getCurrentCardScopeInfo(ctx);
    if (currentCard.cardKey && !known.has(currentCard.cardKey)) {
        known.set(currentCard.cardKey, currentCard.cardLabel || formatCardScopeFallbackLabel(currentCard.cardKey));
    }

    for (const filter of contextualFilters) {
        const scopeInfo = getScopedRecordFromEntity(filter);
        if (scopeInfo.scope !== FILTER_SCOPE_CARD || !scopeInfo.cardKey || known.has(scopeInfo.cardKey)) continue;
        known.set(scopeInfo.cardKey, normalizeScopeLabel(filter.cardLabel) || formatCardScopeFallbackLabel(scopeInfo.cardKey));
    }

    for (const pool of filterPools) {
        const scopeInfo = getScopedRecordFromEntity(pool);
        if (scopeInfo.scope !== FILTER_SCOPE_CARD || !scopeInfo.cardKey || known.has(scopeInfo.cardKey)) continue;
        known.set(scopeInfo.cardKey, normalizeScopeLabel(pool.cardLabel) || formatCardScopeFallbackLabel(scopeInfo.cardKey));
    }

    return known;
}

function getCardNameForFilters(cardKey, knownMap = getKnownFilterScopeCardMap()) {
    const key = normalizeCardScopeKey(cardKey);
    if (!key) return "Card";
    return knownMap.get(key) || formatCardScopeFallbackLabel(key);
}

function getFilterManagerScopeValue(scope, { cardKey = null, charId = null } = {}) {
    if (scope === FILTER_SCOPE_CARD && cardKey) return `card:${normalizeCardScopeKey(cardKey)}`;
    if (scope === FILTER_SCOPE_CHAR && charId != null && charId !== "") return `char:${String(charId)}`;
    return FILTER_MANAGER_SCOPE_GLOBAL_ONLY;
}

function getDefaultFilterManagerScopeValue() {
    if (getCurrentCardKey()) return FILTER_MANAGER_SCOPE_CURRENT_CARD;
    if (getCurrentCharId() != null) return FILTER_MANAGER_SCOPE_CURRENT_CHAR;
    return FILTER_MANAGER_SCOPE_GLOBAL_ONLY;
}

function getSelectedFilterManagerScopeDescriptor(selectedScopeValue = filterManagerUiState.selectedScopeCharId) {
    if (selectedScopeValue === FILTER_MANAGER_SCOPE_CURRENT_CARD) {
        const currentCard = getCurrentCardScopeInfo();
        return getNormalizedScopedRecord(FILTER_SCOPE_CARD, {
            cardKey: currentCard.cardKey,
            cardLabel: currentCard.cardLabel,
        });
    }
    if (selectedScopeValue === FILTER_MANAGER_SCOPE_CURRENT_CHAR) {
        return getNormalizedScopedRecord(FILTER_SCOPE_CHAR, {
            charId: getCurrentCharId(),
        });
    }
    if (selectedScopeValue == null || selectedScopeValue === FILTER_MANAGER_SCOPE_GLOBAL_ONLY || selectedScopeValue === "" || selectedScopeValue === FILTER_SCOPE_GLOBAL) {
        return getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL);
    }
    if (String(selectedScopeValue).startsWith("card:")) {
        const rawCardKey = String(selectedScopeValue).slice(5);
        return getNormalizedScopedRecord(FILTER_SCOPE_CARD, {
            cardKey: rawCardKey,
            cardLabel: getCardNameForFilters(rawCardKey),
        });
    }
    if (String(selectedScopeValue).startsWith("char:")) {
        return getNormalizedScopedRecord(FILTER_SCOPE_CHAR, {
            charId: String(selectedScopeValue).slice(5),
        });
    }
    return getNormalizedScopedRecord(FILTER_SCOPE_GLOBAL);
}

function resetContextualFilterManagerState() {
    filterManagerUiState = {
        selectedScopeCharId: getDefaultFilterManagerScopeValue(),
        hideInactive: false,
        draggedFilterId: null,
        dropTargetFilterId: null,
        dropPosition: "after",
    };
}

function getContextualFilterScopeOptions() {
    const currentCharId = getCurrentCharId();
    const currentCard = getCurrentCardScopeInfo();
    const currentKey = currentCharId != null ? String(currentCharId) : null;
    const nameMap = getKnownFilterScopeCharacterMap();
    const cardMap = getKnownFilterScopeCardMap();
    const otherCharIds = new Set();
    const otherCardKeys = new Set();

    for (const filter of contextualFilters) {
        const scopeInfo = getScopedRecordFromEntity(filter);
        if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
            otherCharIds.add(String(scopeInfo.charId));
        }
        if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
            otherCardKeys.add(scopeInfo.cardKey);
        }
    }
    for (const pool of filterPools) {
        const scopeInfo = getScopedRecordFromEntity(pool);
        if (scopeInfo.scope === FILTER_SCOPE_CHAR && scopeInfo.charId) {
            otherCharIds.add(String(scopeInfo.charId));
        }
        if (scopeInfo.scope === FILTER_SCOPE_CARD && scopeInfo.cardKey) {
            otherCardKeys.add(scopeInfo.cardKey);
        }
    }

    const options = [];
    if (currentCard.cardKey) {
        options.push({
            value: FILTER_MANAGER_SCOPE_CURRENT_CARD,
            scope: FILTER_SCOPE_CARD,
            cardKey: currentCard.cardKey,
            label: `Current Card: ${getCardNameForFilters(currentCard.cardKey, cardMap)}`,
            isCurrent: true,
        });
    }
    if (currentKey != null) {
        options.push({
            value: FILTER_MANAGER_SCOPE_CURRENT_CHAR,
            scope: FILTER_SCOPE_CHAR,
            charId: currentKey,
            label: `Current Character: ${getCharacterNameForFilters(currentKey, nameMap)}`,
            isCurrent: true,
        });
    }

    options.push({
        value: FILTER_MANAGER_SCOPE_GLOBAL_ONLY,
        scope: FILTER_SCOPE_GLOBAL,
        label: "Global only",
        isCurrent: false,
    });

    const otherCardOptions = [...otherCardKeys]
        .filter(cardKey => cardKey !== currentCard.cardKey)
        .map(cardKey => ({
            value: getFilterManagerScopeValue(FILTER_SCOPE_CARD, { cardKey }),
            scope: FILTER_SCOPE_CARD,
            cardKey,
            label: `Card: ${getCardNameForFilters(cardKey, cardMap)}`,
            isCurrent: false,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    const otherOptions = [...otherCharIds]
        .filter(charId => charId !== currentKey)
        .map(charId => ({
            value: getFilterManagerScopeValue(FILTER_SCOPE_CHAR, { charId }),
            scope: FILTER_SCOPE_CHAR,
            charId,
            label: `Character: ${getCharacterNameForFilters(charId, nameMap)}`,
            isCurrent: false,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return [...options, ...otherCardOptions, ...otherOptions];
}

function ensureContextualFilterManagerScopeSelection(scopeOptions = getContextualFilterScopeOptions()) {
    const validValues = new Set(scopeOptions.map(option => String(option.value)));
    const currentSelection = String(filterManagerUiState.selectedScopeCharId ?? "");
    if (validValues.has(currentSelection)) return filterManagerUiState.selectedScopeCharId;

    const defaultValue = getDefaultFilterManagerScopeValue();
    if (validValues.has(String(defaultValue))) {
        filterManagerUiState.selectedScopeCharId = defaultValue;
        return filterManagerUiState.selectedScopeCharId;
    }

    filterManagerUiState.selectedScopeCharId = scopeOptions[0]?.value || FILTER_MANAGER_SCOPE_GLOBAL_ONLY;
    return filterManagerUiState.selectedScopeCharId;
}

function saveCharSettings() {
    const charId = getCurrentCharId();
    if (charId == null) return;
    const s = getSettings();
    charSettings[charId] = {
        prompt: s.prompt,
        negativePrompt: s.negativePrompt,
        style: s.style,
        width: s.width,
        height: s.height
    };
    const savedCharSettings = safeSetStorage("qig_char_settings", JSON.stringify(charSettings), "Failed to save character settings. Browser storage may be full.");
    const refs = getCurrentRefImages(s);
    if (refs.length > 0) {
        charRefImages[charId] = refs;
    } else {
        delete charRefImages[charId];
    }
    const savedCharRefs = safeSetStorage("qig_char_ref_images", JSON.stringify(charRefImages), "Failed to save character reference images. Browser storage may be full.");
    if (!savedCharSettings || !savedCharRefs) return;
    backupToSettings("qig_char_settings", charSettings);
    backupToSettings("qig_char_ref_images", charRefImages);
    showStatus("💾 Saved settings for this character");
    setTimeout(hideStatus, 2000);
}

function loadCharSettings() {
    const s = getSettings();
    const charId = getCurrentCharId();
    if (!document.getElementById("qig-prompt")) return false;

    if (charId == null) {
        if (charSettingsBaseState) {
            applyCharScopedState(charSettingsBaseState, s);
            saveSettingsDebounced();
        }
        charSettingsBaseState = null;
        charSettingsBaseCharId = null;
        return false;
    }

    if (charSettingsBaseCharId !== charId) {
        if (charSettingsBaseState) {
            applyCharScopedState(charSettingsBaseState, s);
        }
        charSettingsBaseState = cloneCharScopedState(s);
        charSettingsBaseCharId = charId;
    }

    const hasSettings = !!charSettings[charId];
    const refs = Array.isArray(charRefImages[charId]) ? charRefImages[charId] : [];
    const hasRefs = refs.length > 0;
    if (!hasSettings && !hasRefs) {
        applyCharScopedState(charSettingsBaseState, s);
        saveSettingsDebounced();
        renderContextualFilters();
        return false;
    }

    const cs = charSettings[charId] || {};
    if (Object.prototype.hasOwnProperty.call(cs, "prompt")) {
        s.prompt = cs.prompt ?? "";
        document.getElementById("qig-prompt").value = s.prompt;
    }
    if (Object.prototype.hasOwnProperty.call(cs, "negativePrompt")) {
        s.negativePrompt = cs.negativePrompt ?? "";
        document.getElementById("qig-negative").value = s.negativePrompt;
    }
    if (Object.prototype.hasOwnProperty.call(cs, "style")) {
        s.style = cs.style ?? defaultSettings.style;
        document.getElementById("qig-style").value = s.style;
    }
    if (Object.prototype.hasOwnProperty.call(cs, "width")) {
        s.width = cs.width ?? defaultSettings.width;
        document.getElementById("qig-width").value = s.width;
    }
    if (Object.prototype.hasOwnProperty.call(cs, "height")) {
        s.height = cs.height ?? defaultSettings.height;
        document.getElementById("qig-height").value = s.height;
    }
    if (s.provider === "novelai") {
        normalizeSize(s);
        syncNaiResolutionSelect();
    }
    syncSizeInputs(s.width, s.height);

    s.proxyRefImages = [];
    s.nanobananaRefImages = [];
    s.nanogptRefImages = [];
    if (hasRefs) {
        if (s.provider === "proxy") {
            s.proxyRefImages = [...refs];
        } else if (s.provider === "nanobanana") {
            s.nanobananaRefImages = [...refs];
        } else if (s.provider === "nanogpt") {
            s.nanogptRefImages = [...refs];
        }
    }
    renderRefImages();
    renderNanobananaRefImages();
    renderNanogptRefImages();
    saveSettingsDebounced();
    renderContextualFilters();
    return true;
}

async function saveConnectionProfile() {
    const s = getSettings();
    const provider = s.provider;
    const rawName = prompt("Profile name:");
    if (rawName == null) return;
    const name = rawName.trim();
    if (!name) {
        toastr.warning("Profile name cannot be empty");
        return;
    }
    const keys = PROVIDER_KEYS[provider] || [];
    const profile = {};
    keys.forEach(k => profile[k] = s[k]);
    const existing = !!connectionProfiles[provider]?.[name];
    if (existing && !confirm(`Profile "${name}" already exists. Overwrite it?`)) return;
    if (!connectionProfiles[provider]) connectionProfiles[provider] = {};
    connectionProfiles[provider][name] = profile;
    if (!safeSetStorage("qig_profiles", JSON.stringify(connectionProfiles), "Failed to save profile. Browser storage may be full.")) return;
    if (!await saveBackupToSettings("qig_profiles", connectionProfiles)) return;
    renderProfileSelect(name);
    showStatus(`${existing ? "♻️ Updated" : "💾 Saved"} profile: ${name}`);
    setTimeout(hideStatus, 2000);
}

function loadConnectionProfile(name) {
    const s = getSettings();
    const provider = s.provider;
    const profile = connectionProfiles[provider]?.[name];
    if (!profile) return;
    Object.assign(s, profile);
    if (provider === "proxy") {
        normalizeProxyChatImageSettings(s, profile);
        s.proxyEndpointMode = normalizeProxyEndpointSetting(s.proxyEndpointMode);
        normalizeProxyChatImageSettings(s, s);
    }
    saveSettingsDebounced();
    refreshProviderInputs(provider);
    renderProfileSelect(name);
    showStatus(`📂 Loaded profile: ${name}`);
    setTimeout(hideStatus, 2000);
}

async function deleteConnectionProfile(name) {
    const provider = getSettings().provider;
    if (!confirm(`Delete profile "${name}"?`)) return;
    delete connectionProfiles[provider]?.[name];
    if (!safeSetStorage("qig_profiles", JSON.stringify(connectionProfiles), "Failed to delete profile. Browser storage may be full.")) return;
    if (!await saveBackupToSettings("qig_profiles", connectionProfiles)) return;
    renderProfileSelect();
}

function renderProfileSelect(selectedName = "") {
    const container = document.getElementById("qig-profile-select");
    if (!container) return;
    const provider = getSettings().provider;
    const profiles = Object.keys(connectionProfiles[provider] || {});
    const previousSelection = document.getElementById("qig-profile-dropdown")?.value || "";
    const selected = selectedName || previousSelection;
    container.innerHTML = profiles.length
        ? `<select id="qig-profile-dropdown"><option value="">-- Select Profile --</option>${profiles.map(p => `<option value="${escapeHtml(p)}" ${p === selected ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select><button id="qig-profile-del" class="menu_button" style="padding:2px 6px;">🗑️</button>`
        : "<span style='color:#888;font-size:11px;'>No saved profiles</span>";
    const dropdown = document.getElementById("qig-profile-dropdown");
    if (dropdown) dropdown.onchange = (e) => { if (e.target.value) loadConnectionProfile(e.target.value); };
    const delBtn = document.getElementById("qig-profile-del");
    if (delBtn) delBtn.onclick = () => { const dd = document.getElementById("qig-profile-dropdown"); if (dd?.value) deleteConnectionProfile(dd.value); };
}

const COMFY_WORKFLOW_KEYS = ["localModel", "comfyDenoise", "comfyClipSkip", "comfyScheduler", "comfyUpscale", "comfyUpscaleModel", "comfyLoras", "comfyWorkflow", "comfySkipNegativePrompt", "comfyFluxClipModel1", "comfyFluxClipModel2", "comfyFluxVaeModel", "comfyFluxClipType"];

function getComfyWorkflowSnapshot(s = getSettings()) {
    return {
        localModel: s.localModel || "",
        comfyDenoise: s.comfyDenoise ?? 1.0,
        comfyClipSkip: s.comfyClipSkip ?? 1,
        comfyScheduler: s.comfyScheduler || "normal",
        comfyUpscale: !!s.comfyUpscale,
        comfyUpscaleModel: s.comfyUpscaleModel || "RealESRGAN_x4plus.pth",
        comfyLoras: s.comfyLoras || "",
        comfyWorkflow: s.comfyWorkflow || "",
        comfySkipNegativePrompt: !!s.comfySkipNegativePrompt,
        comfyFluxClipModel1: s.comfyFluxClipModel1 || "",
        comfyFluxClipModel2: s.comfyFluxClipModel2 || "",
        comfyFluxVaeModel: s.comfyFluxVaeModel || "",
        comfyFluxClipType: s.comfyFluxClipType || "flux"
    };
}

function applyComfyWorkflowSnapshot(snapshot) {
    const s = getSettings();
    COMFY_WORKFLOW_KEYS.forEach(k => {
        if (snapshot[k] !== undefined) s[k] = snapshot[k];
    });
    s.localType = "comfyui";
}

function saveComfyWorkflowStore(errorMessage = "Failed to save workflow presets. Browser storage may be full.") {
    return saveLocalStoreBackup("qig_comfy_workflows", comfyWorkflows, errorMessage);
}

async function saveComfyWorkflowStoreNow(errorMessage = "Failed to save workflow presets. Browser storage may be full.") {
    return saveLocalStoreBackupNow("qig_comfy_workflows", comfyWorkflows, errorMessage);
}

function setComfyWorkflowActionState(hasSelection) {
    ["qig-comfy-workflow-load", "qig-comfy-workflow-update", "qig-comfy-workflow-del"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !hasSelection;
    });
}

function renderComfyWorkflowPresets(selectedId = "") {
    const select = document.getElementById("qig-comfy-workflow-select");
    if (!select) return;
    const previousSelection = select.value || selectedComfyWorkflowId || "";
    const targetId = selectedId || previousSelection;
    const options = [
        `<option value="">-- Select Workflow Preset --</option>`,
        ...comfyWorkflows.map(w => `<option value="${escapeHtml(w.id || "")}" ${w.id === targetId ? "selected" : ""}>${escapeHtml(w.name || "(unnamed)")}</option>`)
    ];
    select.innerHTML = options.join("");
    const found = targetId && comfyWorkflows.some(w => w.id === targetId);
    selectedComfyWorkflowId = found ? targetId : "";
    if (selectedComfyWorkflowId) select.value = selectedComfyWorkflowId;
    setComfyWorkflowActionState(!!selectedComfyWorkflowId);
}

function getSelectedComfyWorkflowPreset() {
    const select = document.getElementById("qig-comfy-workflow-select");
    const id = select?.value || selectedComfyWorkflowId;
    if (!id) return null;
    return comfyWorkflows.find(w => w.id === id) || null;
}

function loadSelectedComfyWorkflowPreset() {
    const preset = getSelectedComfyWorkflowPreset();
    if (!preset) {
        toastr.warning("Select a workflow preset first");
        return;
    }
    applyComfyWorkflowSnapshot(preset);
    saveSettingsDebounced();
    refreshProviderInputs("local");
    renderComfyWorkflowPresets(preset.id);
    showStatus(`📂 Loaded workflow preset: ${preset.name}`);
    setTimeout(hideStatus, 2000);
}

async function saveComfyWorkflowPresetAs() {
    const rawName = prompt("Workflow preset name:");
    if (rawName == null) return;
    const name = rawName.trim();
    if (!name) {
        toastr.warning("Workflow preset name cannot be empty");
        return;
    }
    const existing = comfyWorkflows.find(w => w.name === name);
    const snapshot = getComfyWorkflowSnapshot();
    if (existing) {
        if (!confirm(`Workflow preset "${name}" already exists. Overwrite it?`)) return;
        Object.assign(existing, snapshot, { updatedAt: new Date().toISOString() });
        if (!await saveComfyWorkflowStoreNow()) return;
        renderComfyWorkflowPresets(existing.id);
        showStatus(`♻️ Updated workflow preset: ${name}`);
        setTimeout(hideStatus, 2000);
        return;
    }
    const id = `cwf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    comfyWorkflows.push({ id, name, ...snapshot, updatedAt: new Date().toISOString() });
    if (!await saveComfyWorkflowStoreNow()) return;
    renderComfyWorkflowPresets(id);
    showStatus(`💾 Saved workflow preset: ${name}`);
    setTimeout(hideStatus, 2000);
}

async function updateSelectedComfyWorkflowPreset() {
    const preset = getSelectedComfyWorkflowPreset();
    if (!preset) {
        toastr.warning("Select a workflow preset first");
        return;
    }
    if (!confirm(`Overwrite workflow preset "${preset.name}" with current Comfy settings?`)) return;
    Object.assign(preset, getComfyWorkflowSnapshot(), { updatedAt: new Date().toISOString() });
    if (!await saveComfyWorkflowStoreNow()) return;
    renderComfyWorkflowPresets(preset.id);
    showStatus(`♻️ Updated workflow preset: ${preset.name}`);
    setTimeout(hideStatus, 2000);
}

async function deleteSelectedComfyWorkflowPreset() {
    const preset = getSelectedComfyWorkflowPreset();
    if (!preset) {
        toastr.warning("Select a workflow preset first");
        return;
    }
    if (!confirm(`Delete workflow preset "${preset.name}"?`)) return;
    comfyWorkflows = comfyWorkflows.filter(w => w.id !== preset.id);
    if (!await saveComfyWorkflowStoreNow()) return;
    renderComfyWorkflowPresets("");
    showStatus(`🗑️ Deleted workflow preset: ${preset.name}`);
    setTimeout(hideStatus, 2000);
}

// === Generation Presets ===
const PRESET_KEYS = ["provider", "style", "width", "height", "steps", "cfgScale", "sampler", "seed", "prompt", "negativePrompt", "qualityTags", "appendQuality", "useLastMessage", "useLLMPrompt", "llmPromptStyle", "llmPrefill", "llmCustomInstruction", "batchCount", "sequentialSeeds", "a1111Scheduler", "comfyScheduler", "a1111RestoreFaces", "a1111Tiling", "a1111Subseed", "a1111SubseedStrength", "proxyEndpointMode", "proxyPayloadMode", "proxyRefImageMode", "proxySse", "proxyChatImageMode", "proxyChatImageAllowImagesEndpoint", "proxyChatImageSystemPrompt", "proxyChatImageIncludePersonality", "proxyChatImageMaxTokens"];

function saveGenerationPresetStore(errorMessage = "Failed to save preset. Browser storage may be full.") {
    return saveLocalStoreBackup("qig_gen_presets", generationPresets, errorMessage);
}

async function saveGenerationPresetStoreNow(errorMessage = "Failed to save preset. Browser storage may be full.") {
    return saveLocalStoreBackupNow("qig_gen_presets", generationPresets, errorMessage);
}

function ensureGenerationPresetIds({ persist = false } = {}) {
    if (!Array.isArray(generationPresets)) {
        generationPresets = [];
        return false;
    }
    let changed = false;
    for (const preset of generationPresets) {
        if (!preset || typeof preset !== "object") continue;
        if (typeof preset.id === "string" && preset.id.trim()) continue;
        preset.id = generateUUID();
        changed = true;
    }
    if (changed && persist) {
        saveGenerationPresetStore("Failed to migrate preset IDs. Browser storage may be full.");
    }
    return changed;
}

function getActiveGenerationPresetId() {
    return String(getSettings()?.lastLoadedPresetId || "");
}

function syncActiveGenerationPresetSetting({ persist = false } = {}) {
    const s = getSettings();
    if (!s) return;
    const activePresetId = String(s.lastLoadedPresetId || "");
    if (!activePresetId) return;
    if (generationPresets.some(preset => preset?.id === activePresetId)) return;
    s.lastLoadedPresetId = "";
    if (persist) saveSettingsDebounced();
}

function normalizeGenerationPresetStore(presets = generationPresets) {
    if (!Array.isArray(presets)) return false;
    let changed = false;
    for (const preset of presets) {
        if (!preset || typeof preset !== "object") continue;
        const before = JSON.stringify([
            preset.proxyChatImageMode,
            preset.proxyChatImageAllowImagesEndpoint,
            preset.proxyChatImageSystemPrompt,
            preset.proxyChatImageIncludePersonality,
            preset.proxyChatImageMaxTokens,
            preset.proxyEndpointMode,
        ]);
        normalizeProxyChatImageSettings(preset, preset);
        preset.proxyEndpointMode = normalizeProxyEndpointSetting(preset.proxyEndpointMode);
        normalizeProxyChatImageSettings(preset, preset);
        const after = JSON.stringify([
            preset.proxyChatImageMode,
            preset.proxyChatImageAllowImagesEndpoint,
            preset.proxyChatImageSystemPrompt,
            preset.proxyChatImageIncludePersonality,
            preset.proxyChatImageMaxTokens,
            preset.proxyEndpointMode,
        ]);
        if (before !== after) changed = true;
    }
    return changed;
}

function normalizeProxyProfileStore(profiles = connectionProfiles) {
    const proxyProfiles = profiles?.proxy;
    if (!proxyProfiles || typeof proxyProfiles !== "object") return false;
    let changed = false;
    for (const profile of Object.values(proxyProfiles)) {
        if (!profile || typeof profile !== "object") continue;
        const before = JSON.stringify([
            profile.proxyChatImageMode,
            profile.proxyChatImageAllowImagesEndpoint,
            profile.proxyChatImageSystemPrompt,
            profile.proxyChatImageIncludePersonality,
            profile.proxyChatImageMaxTokens,
            profile.proxyEndpointMode,
        ]);
        normalizeProxyChatImageSettings(profile, profile);
        profile.proxyEndpointMode = normalizeProxyEndpointSetting(profile.proxyEndpointMode);
        normalizeProxyChatImageSettings(profile, profile);
        const after = JSON.stringify([
            profile.proxyChatImageMode,
            profile.proxyChatImageAllowImagesEndpoint,
            profile.proxyChatImageSystemPrompt,
            profile.proxyChatImageIncludePersonality,
            profile.proxyChatImageMaxTokens,
            profile.proxyEndpointMode,
        ]);
        if (before !== after) changed = true;
    }
    return changed;
}

function setActiveGenerationPresetId(presetId = "", { persist = true } = {}) {
    const s = getSettings();
    if (!s) return;
    const nextId = String(presetId || "");
    if (String(s.lastLoadedPresetId || "") !== nextId) {
        s.lastLoadedPresetId = nextId;
        if (persist) saveSettingsDebounced();
    }
    renderPresets();
}

async function savePreset() {
    const name = prompt("Preset name:");
    if (!name) return;
    ensureFilterPoolsState();
    const s = getSettings();
    const preset = { id: generateUUID(), name };
    PRESET_KEYS.forEach(k => preset[k] = s[k]);
    // Include ST Style toggle state
    if (s.useSTStyle !== undefined) preset.useSTStyle = s.useSTStyle;
    // Include inject mode settings
    const injectKeys = ["injectEnabled", "injectTagName", "injectPrompt", "injectRegex", "injectPosition", "injectDepth", "injectInsertMode", "injectAutoClean", "paletteMode"];
    injectKeys.forEach(k => { if (s[k] !== undefined) preset[k] = s[k]; });
    generationPresets.push(preset);
    if (!await saveGenerationPresetStoreNow()) return;
    renderPresets();
    showStatus(`💾 Saved preset: ${name}`);
    setTimeout(hideStatus, 2000);
}

function loadPreset(i) {
    ensureGenerationPresetIds({ persist: true });
    const p = generationPresets[i];
    if (!p) return;
    const s = getSettings();
    PRESET_KEYS.forEach(k => { if (p[k] !== undefined) s[k] = p[k]; });
    normalizeProxyChatImageSettings(s, p);
    s.proxyEndpointMode = normalizeProxyEndpointSetting(s.proxyEndpointMode);
    normalizeProxyChatImageSettings(s, s);
    ensureFilterPoolsState();
    renderContextualFilters();
    // Restore ST Style toggle
    if (p.useSTStyle !== undefined) { s.useSTStyle = p.useSTStyle; }
    // Restore inject mode settings
    const injectKeys = ["injectEnabled", "injectTagName", "injectPrompt", "injectRegex", "injectPosition", "injectDepth", "injectInsertMode", "injectAutoClean", "paletteMode"];
    injectKeys.forEach(k => { if (p[k] !== undefined) s[k] = p[k]; });
    s.paletteMode = normalizePaletteMode(s.paletteMode);
    s.lastLoadedPresetId = p.id || "";
    saveSettingsDebounced();
    refreshAllUI(s);
    renderPresets();
    closePalettePresetMenu();
    showStatus(`📂 Loaded preset: ${p.name}`);
    setTimeout(hideStatus, 2000);
}

async function deletePreset(i) {
    const removed = generationPresets.splice(i, 1)[0];
    if (removed?.id && getActiveGenerationPresetId() === removed.id) {
        setActiveGenerationPresetId("", { persist: false });
    }
    syncActiveGenerationPresetSetting({ persist: false });
    if (!await saveGenerationPresetStoreNow("Failed to delete preset. Browser storage may be full.")) return;
    closePalettePresetMenu();
    renderPresets();
}

async function clearPresets() {
    if (confirm("Clear all presets?")) {
        generationPresets = [];
        localStorage.removeItem("qig_gen_presets");
        setActiveGenerationPresetId("", { persist: false });
        if (!await saveBackupToSettings("qig_gen_presets", generationPresets)) return;
        closePalettePresetMenu();
        renderPresets();
    }
}

function renderPresets() {
    const container = document.getElementById("qig-presets");
    if (!container) return;
    ensureGenerationPresetIds({ persist: true });
    syncActiveGenerationPresetSetting({ persist: true });
    const activePresetId = getActiveGenerationPresetId();
    const html = generationPresets.map((p, i) =>
        `<span style="display:inline-flex;align-items:center;margin:2px;">` +
        `<button class="menu_button ${p?.id === activePresetId ? "qig-preset-chip--active" : ""}" style="padding:2px 6px;font-size:10px;" onclick="loadPreset(${i})">${escapeHtml(p.name || "")}</button>` +
        `<button class="menu_button" style="padding:2px 4px;font-size:10px;margin-left:1px;" onclick="deletePreset(${i})">×</button></span>`
    ).join('');
    container.innerHTML = generationPresets.length > 0
        ? `<div style="max-height:80px;overflow-y:auto;margin-bottom:4px;">${html}</div>` +
          `<button class="menu_button" style="padding:2px 6px;font-size:10px;margin:2px;" onclick="clearPresets()">Clear All</button>`
        : '';
}

function syncInjectTagUI(settings = getSettings()) {
    const safeTagName = getInjectTagName(settings);
    const tagInput = document.getElementById("qig-inject-tag-name");
    if (tagInput) tagInput.value = safeTagName;
    const preview = document.getElementById("qig-inject-tag-preview");
    if (preview) preview.textContent = getInjectTagPreview(safeTagName);
}

function syncInjectDefaultFields(settings = getSettings()) {
    const promptEl = document.getElementById("qig-inject-prompt");
    if (promptEl) promptEl.value = settings.injectPrompt ?? "";
    const regexEl = document.getElementById("qig-inject-regex");
    if (regexEl) regexEl.value = settings.injectRegex ?? "";
    syncInjectTagUI(settings);
}

function applyInjectTagNameChange(nextTagName) {
    const s = getSettings();
    const previousTagName = getInjectTagName(s);
    const normalizedTagName = normalizeInjectTagName(nextTagName);
    const shouldUpdatePrompt = isGeneratedInjectPrompt(s.injectPrompt, previousTagName);
    const shouldUpdateRegex = isGeneratedInjectRegex(s.injectRegex, previousTagName);

    s.injectTagName = normalizedTagName;
    if (shouldUpdatePrompt) s.injectPrompt = buildDefaultInjectPrompt(normalizedTagName);
    if (shouldUpdateRegex) s.injectRegex = buildDefaultInjectRegex(normalizedTagName);
    syncInjectDefaultFields(s);
    return normalizedTagName;
}

function refreshAllUI(s) {
    const fields = {
        "qig-prompt": "prompt", "qig-negative": "negativePrompt", "qig-quality": "qualityTags",
        "qig-width": "width", "qig-height": "height", "qig-steps": "steps",
        "qig-cfg": "cfgScale", "qig-sampler": "sampler", "qig-seed": "seed",
        "qig-batch": "batchCount", "qig-provider": "provider", "qig-style": "style",
        "qig-llm-style": "llmPromptStyle",
        "qig-llm-prefill": "llmPrefill",
        "qig-llm-custom": "llmCustomInstruction",
        "qig-auto-generate-every": "autoGenerateEveryMessages",
        "qig-auto-generate-delay": "autoGenerateDelayMs",
        "qig-two-step-instruction": "twoStepInstruction",
        "qig-background-mode": "backgroundMode",
        "qig-output-mode": "outputMode",
        "qig-palette-mode": "paletteMode",
        "qig-inject-tag-name": "injectTagName",
        "qig-inject-prompt": "injectPrompt", "qig-inject-regex": "injectRegex",
        "qig-inject-position": "injectPosition", "qig-inject-depth": "injectDepth",
        "qig-inject-insert-mode": "injectInsertMode",
        "qig-proxy-chat-system": "proxyChatImageSystemPrompt",
        "qig-proxy-chat-max-tokens": "proxyChatImageMaxTokens"
    };
    Object.entries(fields).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.value = s[key] ?? "";
    });
    const checks = {
        "qig-append-quality": "appendQuality", "qig-use-last": "useLastMessage",
        "qig-use-llm": "useLLMPrompt", "qig-auto-generate": "autoGenerate",
        "qig-two-step-prompt": "twoStepPrompt", "qig-auto-background": "autoSetBackground",
        "qig-seq-seeds": "sequentialSeeds",
        "qig-use-st-style": "useSTStyle", "qig-inject-enabled": "injectEnabled",
        "qig-inject-autoclean": "injectAutoClean", "qig-proxy-chat-mode": "proxyChatImageMode",
        "qig-proxy-chat-allow-images": "proxyChatImageAllowImagesEndpoint",
        "qig-proxy-chat-personality": "proxyChatImageIncludePersonality"
    };
    Object.entries(checks).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!s[key];
    });
    syncAutoGenerateControls(s);
    syncTwoStepPromptControls(s);
    syncBackgroundControls(s);
    syncInjectDefaultFields(s);
    updateProviderUI();
    refreshProviderInputs(s.provider);
    renderProfileSelect();
    // Update seq seeds visibility
    const seqWrap = document.getElementById("qig-seq-seeds-wrap");
    if (seqWrap) seqWrap.style.display = (s.batchCount || 1) > 1 ? "" : "none";
    // Update inject mode visibility
    const injectOpts = document.getElementById("qig-inject-options");
    if (injectOpts) injectOpts.style.display = s.injectEnabled ? "block" : "none";
    const injectDepthWrap = document.getElementById("qig-inject-depth-wrap");
    if (injectDepthWrap) injectDepthWrap.style.display = s.injectPosition === "atDepth" ? "block" : "none";
    renderContextualFilters();
}

window.loadPreset = loadPreset;
window.deletePreset = deletePreset;
window.clearPresets = clearPresets;

// === Export / Import Settings ===
function exportAllSettings() {
    const data = {
        version: 5,
        exportDate: new Date().toISOString(),
        connectionProfiles,
        comfyWorkflows,
        generationPresets,
        charSettings,
        charRefImages,
        contextualFilters,
        filterPools,
        activeFilterPoolIdsGlobal,
        activeFilterPoolIdsByCard,
        activeFilterPoolIdsByChar,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qig-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastr.success("Settings exported");
}

function importSettings() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.version) { toastr.error("Invalid settings file"); return; }
            if (!confirm(`Import settings from ${data.exportDate || 'unknown date'}? This will overwrite current settings.`)) return;
            if (data.connectionProfiles) {
                connectionProfiles = data.connectionProfiles;
                normalizeProxyProfileStore(connectionProfiles);
                if (!safeSetStorage("qig_profiles", JSON.stringify(connectionProfiles))) throw new Error("Could not save imported profiles. Browser storage may be full.");
                writeBackupToSettings("qig_profiles", connectionProfiles);
            }
            if (Array.isArray(data.comfyWorkflows)) {
                comfyWorkflows = data.comfyWorkflows;
                if (!safeSetStorage("qig_comfy_workflows", JSON.stringify(comfyWorkflows))) throw new Error("Could not save imported workflow presets. Browser storage may be full.");
                writeBackupToSettings("qig_comfy_workflows", comfyWorkflows);
            }
            if (data.generationPresets) {
                generationPresets = data.generationPresets;
                ensureGenerationPresetIds();
                normalizeGenerationPresetStore(generationPresets);
                if (!safeSetStorage("qig_gen_presets", JSON.stringify(generationPresets))) throw new Error("Could not save imported presets. Browser storage may be full.");
                writeBackupToSettings("qig_gen_presets", generationPresets);
            }
            if (data.charSettings) {
                charSettings = data.charSettings;
                if (!safeSetStorage("qig_char_settings", JSON.stringify(charSettings))) throw new Error("Could not save imported character settings. Browser storage may be full.");
                writeBackupToSettings("qig_char_settings", charSettings);
            }
            if (data.charRefImages) {
                charRefImages = data.charRefImages;
                if (!safeSetStorage("qig_char_ref_images", JSON.stringify(charRefImages))) throw new Error("Could not save imported character reference images. Browser storage may be full.");
                writeBackupToSettings("qig_char_ref_images", charRefImages);
            }
            if (data.contextualFilters) {
                contextualFilters = data.contextualFilters;
                if (!safeSetStorage("qig_contextual_filters", JSON.stringify(contextualFilters))) throw new Error("Could not save imported contextual filters. Browser storage may be full.");
                writeBackupToSettings("qig_contextual_filters", contextualFilters);
            }
            if (Array.isArray(data.filterPools)) {
                filterPools = data.filterPools;
                if (!safeSetStorage("qig_filter_pools", JSON.stringify(filterPools))) throw new Error("Could not save imported filter pools. Browser storage may be full.");
                writeBackupToSettings("qig_filter_pools", filterPools);
            }
            if (Array.isArray(data.activeFilterPoolIdsGlobal)) {
                activeFilterPoolIdsGlobal = data.activeFilterPoolIdsGlobal;
                if (!safeSetStorage("qig_active_pool_ids_global", JSON.stringify(activeFilterPoolIdsGlobal))) throw new Error("Could not save imported global pool states. Browser storage may be full.");
                writeBackupToSettings("qig_active_pool_ids_global", activeFilterPoolIdsGlobal);
            }
            if (data.activeFilterPoolIdsByCard && typeof data.activeFilterPoolIdsByCard === "object") {
                activeFilterPoolIdsByCard = data.activeFilterPoolIdsByCard;
                if (!safeSetStorage("qig_active_pool_ids_by_card", JSON.stringify(activeFilterPoolIdsByCard))) throw new Error("Could not save imported card pool states. Browser storage may be full.");
                writeBackupToSettings("qig_active_pool_ids_by_card", activeFilterPoolIdsByCard);
            }
            if (data.activeFilterPoolIdsByChar && typeof data.activeFilterPoolIdsByChar === "object") {
                activeFilterPoolIdsByChar = data.activeFilterPoolIdsByChar;
                if (!safeSetStorage("qig_active_pool_ids_by_char", JSON.stringify(activeFilterPoolIdsByChar))) throw new Error("Could not save imported character pool states. Browser storage may be full.");
                writeBackupToSettings("qig_active_pool_ids_by_char", activeFilterPoolIdsByChar);
            }
            if (Array.isArray(data.promptReplacements)) {
                migratePromptReplacementsToFilters(data.promptReplacements, {
                    settings: getSettings(),
                    persist: false,
                    sourceLabel: "imported settings",
                });
            }
            syncActiveGenerationPresetSetting({ persist: true });
            ensureFilterPoolsState({ persist: true });
            await flushSettingsBackup();
            renderPresets();
            renderProfileSelect();
            renderComfyWorkflowPresets();
            renderContextualFilters();
            toastr.success("Settings imported successfully");
        } catch (err) {
            console.error("[Quick Image Gen] Import failed:", err);
            toastr.error("Failed to import: " + err.message);
        }
    };
    input.click();
}

function syncLocalTypeSections(localType) {
    const a1111Opts = document.getElementById("qig-local-a1111-opts");
    const comfyOpts = document.getElementById("qig-local-comfyui-opts");
    if (a1111Opts) a1111Opts.style.display = localType === "a1111" ? "block" : "none";
    if (comfyOpts) comfyOpts.style.display = localType === "comfyui" ? "block" : "none";
    const denoiseWrap = document.getElementById("qig-local-denoise-wrap");
    if (denoiseWrap) {
        const s = getSettings();
        denoiseWrap.style.display = localType === "a1111" && s.localRefImage ? "block" : "none";
    }
}

function syncA1111VisibilityFromSettings(s) {
    const hiresOpts = document.getElementById("qig-a1111-hires-opts");
    if (hiresOpts) hiresOpts.style.display = s.a1111HiresFix ? "block" : "none";
    const adetailerOpts = document.getElementById("qig-a1111-adetailer-opts");
    if (adetailerOpts) adetailerOpts.style.display = s.a1111Adetailer ? "block" : "none";
    const ad2Opts = document.getElementById("qig-a1111-ad2-opts");
    if (ad2Opts) ad2Opts.style.display = s.a1111Adetailer2 ? "block" : "none";
    const ipadapterOpts = document.getElementById("qig-a1111-ipadapter-opts");
    if (ipadapterOpts) ipadapterOpts.style.display = s.a1111IpAdapter ? "block" : "none";
    const controlnetOpts = document.getElementById("qig-a1111-controlnet-opts");
    if (controlnetOpts) controlnetOpts.style.display = s.a1111ControlNet ? "block" : "none";
}

function refreshProviderInputs(provider, { updateProviderVisibility = true } = {}) {
    const s = getSettings();
    const map = {
        pollinations: [["qig-pollinations-model", "pollinationsModel"]],
        novelai: [["qig-nai-key", "naiKey"], ["qig-nai-model", "naiModel"], ["qig-nai-proxy-url", "naiProxyUrl"], ["qig-nai-proxy-key", "naiProxyKey"]],
        gptimage: [["qig-gpt-image-key", "gptImageKey"], ["qig-gpt-image-model", "gptImageModel"], ["qig-gpt-image-proxy-url", "gptImageProxyUrl"], ["qig-gpt-image-proxy-key", "gptImageProxyKey"], ["qig-gpt-image-quality", "gptImageQuality"], ["qig-gpt-image-format", "gptImageFormat"], ["qig-gpt-image-background", "gptImageBackground"], ["qig-gpt-image-moderation", "gptImageModeration"]],
        arliai: [["qig-arli-key", "arliKey"], ["qig-arli-model", "arliModel"]],
        routeway: [["qig-routeway-key", "routewayKey"], ["qig-routeway-model", "routewayModel"]],
        navy: [["qig-navy-key", "navyKey"], ["qig-navy-model", "navyModel"]],
        nanogpt: [["qig-nanogpt-key", "nanogptKey"], ["qig-nanogpt-model", "nanogptModel"], ["qig-nanogpt-strength", "nanogptStrength"]],
        chutes: [["qig-chutes-key", "chutesKey"], ["qig-chutes-model", "chutesModel"]],
        civitai: [["qig-civitai-key", "civitaiKey"], ["qig-civitai-model", "civitaiModel"], ["qig-civitai-scheduler", "civitaiScheduler"], ["qig-civitai-loras", "civitaiLoras"]],
        nanobanana: [["qig-nanobanana-key", "nanobananaKey"], ["qig-nanobanana-model", "nanobananaModel"], ["qig-nanobanana-nbp-mode", "nanobananaNbpMode"], ["qig-nanobanana-nbp-preset", "nanobananaNbpPreset"], ["qig-nanobanana-nbp-negative", "nanobananaNbpUseNegative"], ["qig-nanobanana-nbp-custom-director", "nanobananaNbpCustomDirector"], ["qig-nanobanana-nbp-custom", "nanobananaNbpCustomPrompt"], ["qig-nanobanana-extra", "nanobananaExtraInstructions"]],
        stability: [["qig-stability-key", "stabilityKey"]],
        replicate: [["qig-replicate-key", "replicateKey"], ["qig-replicate-model", "replicateModel"]],
        fal: [["qig-fal-key", "falKey"], ["qig-fal-model", "falModel"]],
        together: [["qig-together-key", "togetherKey"], ["qig-together-model", "togetherModel"]],
        zai: [["qig-zai-key", "zaiKey"], ["qig-zai-model", "zaiModel"], ["qig-zai-quality", "zaiQuality"]],
        local: [
            ["qig-local-url", "localUrl"],
            ["qig-local-type", "localType"],
            ["qig-local-model", "localModel"],
            ["qig-local-denoise", "localDenoise"],
            ["qig-comfy-denoise", "comfyDenoise"],
            ["qig-comfy-clip", "comfyClipSkip"],
            ["qig-comfy-scheduler", "comfyScheduler"],
            ["qig-comfy-timeout", "comfyTimeout"],
            ["qig-comfy-upscale", "comfyUpscale"],
            ["qig-comfy-upscale-model", "comfyUpscaleModel"],
            ["qig-comfy-workflow", "comfyWorkflow"],
            ["qig-comfy-loras", "comfyLoras"],
            ["qig-a1111-model", "a1111Model"],
            ["qig-a1111-clip", "a1111ClipSkip"],
            ["qig-a1111-scheduler", "a1111Scheduler"],
            ["qig-a1111-restore-faces", "a1111RestoreFaces"],
            ["qig-a1111-tiling", "a1111Tiling"],
            ["qig-a1111-subseed", "a1111Subseed"],
            ["qig-a1111-subseed-strength", "a1111SubseedStrength"],
            ["qig-a1111-loras", "a1111Loras"],
            ["qig-a1111-vae", "a1111Vae"],
            ["qig-a1111-hires", "a1111HiresFix"],
            ["qig-a1111-hires-upscaler", "a1111HiresUpscaler"],
            ["qig-a1111-hires-scale", "a1111HiresScale"],
            ["qig-a1111-hires-steps", "a1111HiresSteps"],
            ["qig-a1111-hires-denoise", "a1111HiresDenoise"],
            ["qig-a1111-hires-sampler", "a1111HiresSampler"],
            ["qig-a1111-hires-scheduler", "a1111HiresScheduler"],
            ["qig-a1111-hires-prompt", "a1111HiresPrompt"],
            ["qig-a1111-hires-negative", "a1111HiresNegative"],
            ["qig-a1111-hires-resize-x", "a1111HiresResizeX"],
            ["qig-a1111-hires-resize-y", "a1111HiresResizeY"],
            ["qig-a1111-adetailer", "a1111Adetailer"],
            ["qig-a1111-adetailer-model", "a1111AdetailerModel"],
            ["qig-a1111-ad-prompt", "a1111AdetailerPrompt"],
            ["qig-a1111-ad-negative", "a1111AdetailerNegative"],
            ["qig-a1111-ad-denoise", "a1111AdetailerDenoise"],
            ["qig-a1111-ad-confidence", "a1111AdetailerConfidence"],
            ["qig-a1111-ad-mask-blur", "a1111AdetailerMaskBlur"],
            ["qig-a1111-ad-dilate", "a1111AdetailerDilateErode"],
            ["qig-a1111-ad-inpaint-only", "a1111AdetailerInpaintOnlyMasked"],
            ["qig-a1111-ad-inpaint-padding", "a1111AdetailerInpaintPadding"],
            ["qig-a1111-ad2-enable", "a1111Adetailer2"],
            ["qig-a1111-ad2-model", "a1111Adetailer2Model"],
            ["qig-a1111-ad2-prompt", "a1111Adetailer2Prompt"],
            ["qig-a1111-ad2-negative", "a1111Adetailer2Negative"],
            ["qig-a1111-ad2-denoise", "a1111Adetailer2Denoise"],
            ["qig-a1111-ad2-confidence", "a1111Adetailer2Confidence"],
            ["qig-a1111-ad2-mask-blur", "a1111Adetailer2MaskBlur"],
            ["qig-a1111-ad2-dilate", "a1111Adetailer2DilateErode"],
            ["qig-a1111-ad2-inpaint-only", "a1111Adetailer2InpaintOnlyMasked"],
            ["qig-a1111-ad2-inpaint-padding", "a1111Adetailer2InpaintPadding"],
            ["qig-a1111-save-webui", "a1111SaveToWebUI"],
            ["qig-a1111-ipadapter", "a1111IpAdapter"],
            ["qig-a1111-ipadapter-mode", "a1111IpAdapterMode"],
            ["qig-a1111-ipadapter-weight", "a1111IpAdapterWeight"],
            ["qig-a1111-ipadapter-pixel", "a1111IpAdapterPixelPerfect"],
            ["qig-a1111-ipadapter-resize", "a1111IpAdapterResizeMode"],
            ["qig-a1111-ipadapter-control", "a1111IpAdapterControlMode"],
            ["qig-a1111-ipadapter-start", "a1111IpAdapterStartStep"],
            ["qig-a1111-ipadapter-end", "a1111IpAdapterEndStep"],
            ["qig-a1111-controlnet", "a1111ControlNet"],
            ["qig-a1111-cn-model", "a1111ControlNetModel"],
            ["qig-a1111-cn-module", "a1111ControlNetModule"],
            ["qig-a1111-cn-weight", "a1111ControlNetWeight"],
            ["qig-a1111-cn-pixel", "a1111ControlNetPixelPerfect"],
            ["qig-a1111-cn-resize", "a1111ControlNetResizeMode"],
            ["qig-a1111-cn-control", "a1111ControlNetControlMode"],
            ["qig-a1111-cn-start", "a1111ControlNetGuidanceStart"],
            ["qig-a1111-cn-end", "a1111ControlNetGuidanceEnd"],
            ["qig-comfy-skip-neg", "comfySkipNegativePrompt"],
            ["qig-comfy-flux-clip1", "comfyFluxClipModel1"],
            ["qig-comfy-flux-clip2", "comfyFluxClipModel2"],
            ["qig-comfy-flux-vae", "comfyFluxVaeModel"],
            ["qig-comfy-flux-clip-type", "comfyFluxClipType"]
        ],
        proxy: [["qig-proxy-url", "proxyUrl"], ["qig-proxy-key", "proxyKey"], ["qig-proxy-model", "proxyModel"], ["qig-proxy-timeout", "proxyTimeout"], ["qig-proxy-endpoint-mode", "proxyEndpointMode"], ["qig-proxy-payload-mode", "proxyPayloadMode"], ["qig-proxy-ref-mode", "proxyRefImageMode"], ["qig-proxy-sse-mode", "proxySse"], ["qig-proxy-loras", "proxyLoras"], ["qig-proxy-steps", "proxySteps"], ["qig-proxy-cfg", "proxyCfg"], ["qig-proxy-sampler", "proxySampler"], ["qig-proxy-seed", "proxySeed"], ["qig-proxy-extra", "proxyExtraInstructions"], ["qig-proxy-facefix", "proxyFacefix"], ["qig-proxy-chat-mode", "proxyChatImageMode"], ["qig-proxy-chat-allow-images", "proxyChatImageAllowImagesEndpoint"], ["qig-proxy-chat-system", "proxyChatImageSystemPrompt"], ["qig-proxy-chat-personality", "proxyChatImageIncludePersonality"], ["qig-proxy-chat-max-tokens", "proxyChatImageMaxTokens"], ["qig-proxy-comfy-mode", "proxyComfyMode"], ["qig-proxy-comfy-timeout", "proxyComfyTimeout"], ["qig-proxy-comfy-node-id", "proxyComfyNodeId"], ["qig-proxy-comfy-workflow", "proxyComfyWorkflow"]]
    };
    (map[provider] || []).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.type === "checkbox" ? el.checked = s[key] : el.value = s[key] ?? "";
    });

    if (provider === "local") {
        syncLocalTypeSections(s.localType);
        syncA1111VisibilityFromSettings(s);
        const fluxOpts = document.getElementById("qig-comfy-flux-opts");
        if (fluxOpts) fluxOpts.style.display = s.comfySkipNegativePrompt ? "block" : "none";
        const upscaleOpts = document.getElementById("qig-comfy-upscale-opts");
        if (upscaleOpts) upscaleOpts.style.display = s.comfyUpscale ? "block" : "none";
        const localDenoise = document.getElementById("qig-local-denoise-val");
        if (localDenoise) localDenoise.textContent = String(s.localDenoise ?? 0.75);
        const hiresDenoise = document.getElementById("qig-a1111-hires-denoise-val");
        if (hiresDenoise) hiresDenoise.textContent = String(s.a1111HiresDenoise ?? 0.55);
        const ipWeight = document.getElementById("qig-a1111-ipadapter-weight-val");
        if (ipWeight) ipWeight.textContent = String(s.a1111IpAdapterWeight ?? 0.7);
    }

    // Update reference images display
    if (provider === "proxy") {
        normalizeProxyChatImageSettings(s, s);
        s.proxyEndpointMode = normalizeProxyEndpointSetting(s.proxyEndpointMode);
        normalizeProxyChatImageSettings(s, s);
        s.proxyPayloadMode = normalizeProxyPayloadSetting(s.proxyPayloadMode);
        s.proxyRefImageMode = normalizeProxyRefImageSetting(s.proxyRefImageMode);
        s.proxySse = normalizeProxySseSetting(s.proxySse);
        ["qig-proxy-endpoint-mode", "qig-proxy-payload-mode", "qig-proxy-ref-mode", "qig-proxy-sse-mode", "qig-proxy-chat-mode", "qig-proxy-chat-allow-images", "qig-proxy-chat-personality", "qig-proxy-chat-system", "qig-proxy-chat-max-tokens"].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (id === "qig-proxy-endpoint-mode") el.value = s.proxyEndpointMode;
            if (id === "qig-proxy-payload-mode") el.value = s.proxyPayloadMode;
            if (id === "qig-proxy-ref-mode") el.value = s.proxyRefImageMode;
            if (id === "qig-proxy-sse-mode") el.value = s.proxySse;
            if (id === "qig-proxy-chat-system") el.value = s.proxyChatImageSystemPrompt || DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT;
            if (id === "qig-proxy-chat-max-tokens") el.value = getProxyChatMaxTokens(s);
            if (id === "qig-proxy-chat-mode") el.checked = !!s.proxyChatImageMode;
            if (id === "qig-proxy-chat-allow-images") el.checked = !!s.proxyChatImageAllowImagesEndpoint;
            if (id === "qig-proxy-chat-personality") el.checked = !!s.proxyChatImageIncludePersonality;
        });
        renderRefImages();
        updateProxyCompatibilityUI();
    }
    if (provider === "nanobanana") renderNanobananaRefImages();
    if (provider === "nanogpt") renderNanogptRefImages();
    if (updateProviderVisibility) updateProviderUI();
}

function updateProviderUI() {
    const s = getSettings();
    document.querySelectorAll(".qig-provider-section").forEach(el => el.style.display = "none");
    const section = document.getElementById(`qig-${s.provider}-settings`);
    if (section) section.style.display = "block";

    const advancedSettingsEl = document.getElementById("qig-advanced-settings");
    const advancedShell = advancedSettingsEl?.closest(".qig-advanced-settings-shell");
    if (advancedShell) advancedShell.style.display = "";

    const isNai = s.provider === "novelai";
    const sizeCustomEl = document.getElementById("qig-size-custom");
    const naiResolutionEl = document.getElementById("qig-nai-resolution");
    if (sizeCustomEl) sizeCustomEl.style.display = "flex";
    if (naiResolutionEl) naiResolutionEl.style.display = isNai ? "block" : "none";
    if (isNai) {
        const changed = normalizeSize(s);
        syncSizeInputs(s.width, s.height);
        syncNaiResolutionSelect();
        if (changed) saveSettingsDebounced();
    }
}

function addProxyRefImage(src, successMessage = "") {
    const s = getSettings();
    const value = String(src || "").trim();
    if (!value) return false;
    if (!s.proxyRefImages) s.proxyRefImages = [];
    if (s.proxyRefImages.length >= 15) {
        toastr.warning("Maximum 15 reference images reached");
        return false;
    }
    if (normalizeProxyRefImageSetting(s.proxyRefImageMode) === "url_only" && !isHttpUrl(value)) {
        toastr.warning("This proxy compatibility mode only accepts public image URLs for reference images.");
        return false;
    }
    s.proxyRefImages.push(value);
    saveSettingsDebounced();
    renderRefImages();
    updateProxyCompatibilityUI();
    if (successMessage) toastr.success(successMessage);
    return true;
}

function updateProxyCompatibilityUI() {
    const s = getSettings();
    const comfyOpts = document.getElementById("qig-proxy-comfy-opts");
    const stdOpts = document.getElementById("qig-proxy-standard-opts");
    if (comfyOpts) comfyOpts.style.display = s.proxyComfyMode ? "block" : "none";
    if (stdOpts) stdOpts.style.display = s.proxyComfyMode ? "none" : "block";

    const chatMode = !!s.proxyChatImageMode;
    const chatPanel = getOrCacheElement("qig-proxy-chat-image-panel");
    const chatRouteStatus = getOrCacheElement("qig-proxy-chat-route-status");
    const endpointModeEl = getOrCacheElement("qig-proxy-endpoint-mode");
    if (chatPanel) chatPanel.style.display = chatMode ? "block" : "none";
    if (endpointModeEl) endpointModeEl.disabled = chatMode && !s.proxyChatImageAllowImagesEndpoint;
    if (chatRouteStatus) {
        chatRouteStatus.textContent = chatMode
            ? (s.proxyChatImageAllowImagesEndpoint
                ? "Route permission is on: Auto may use /images/generations when the URL implies it."
                : "Route permission is off: QIG will use chat/completions for this mode.")
            : "Simple mode is off. Endpoint routing follows the Advanced selector.";
    }

    const isUrlOnly = normalizeProxyRefImageSetting(s.proxyRefImageMode) === "url_only";
    const invalidRefCount = (s.proxyRefImages || []).filter(img => typeof img === "string" && img.trim() && !isHttpUrl(img)).length;
    const refBtn = getOrCacheElement("qig-proxy-ref-btn");
    const refInput = getOrCacheElement("qig-proxy-ref-input");
    const refUrl = getOrCacheElement("qig-proxy-ref-url");
    const hint = getOrCacheElement("qig-proxy-compat-hint");

    if (refBtn) {
        refBtn.disabled = isUrlOnly;
        refBtn.title = isUrlOnly ? "This mode only accepts public image URLs" : "Add local files as reference images";
        refBtn.style.opacity = isUrlOnly ? "0.5" : "1";
        refBtn.style.cursor = isUrlOnly ? "not-allowed" : "pointer";
    }
    if (refInput) refInput.disabled = isUrlOnly;
    if (refUrl) {
        refUrl.placeholder = isUrlOnly
            ? "Paste a public https:// image URL and press Enter"
            : "Paste image URL and press Enter";
    }

    if (hint) {
        const endpointMode = resolveProxyEndpointMode(s.proxyUrl, s);
        const payloadMode = normalizeProxyPayloadSetting(s.proxyPayloadMode);
        const sseMode = normalizeProxySseSetting(s.proxySse);
        const hintParts = [
            endpointMode === "chat_completions"
                ? "Using chat-completions style routing."
                : "Using /images/generations style routing.",
            payloadMode === "openai_strict"
                ? "Strict payload strips nonstandard image fields, which helps with proxies that 400 on extra parameters."
                : "Extended payload keeps provider-specific extras like steps, CFG, sampler, seed, LoRAs, and face fix.",
            sseMode === "auto"
                ? `SSE auto is currently ${shouldUseProxySse(s, payloadMode) ? "enabled" : "disabled"}.`
                : `SSE is forced ${sseMode}.`,
        ];
        if (isUrlOnly) {
            hintParts.push("Reference images must be public http(s) URLs. Uploaded, local, blob, and data URLs will be rejected.");
        }
        if (invalidRefCount > 0) {
            hintParts.push(`${invalidRefCount} saved reference image(s) are incompatible with the current URL-only mode.`);
        }
        hint.textContent = hintParts.join(" ");
    }
}

function renderRefImages() {
    const container = getOrCacheElement("qig-proxy-refs");
    if (!container) return;
    const imgs = getSettings().proxyRefImages || [];
    const isUrlOnly = normalizeProxyRefImageSetting(getSettings().proxyRefImageMode) === "url_only";
    container.innerHTML = imgs.map((src, i) =>
        `<div style="position:relative;" title="${escapeHtml(summarizeProxyRefImage(src || ""))}"><img src="${escapeHtml(src || "")}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;border:1px solid ${isUrlOnly && !isHttpUrl(src || "") ? "#e94560" : "#333"};"><button onclick="removeRefImage(${i})" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e94560;color:#fff;font-size:10px;cursor:pointer;line-height:1;">×</button></div>`
    ).join('');
}

window.removeRefImage = function (idx) {
    const s = getSettings();
    if (!s.proxyRefImages) s.proxyRefImages = [];
    s.proxyRefImages.splice(idx, 1);
    saveSettingsDebounced();
    renderRefImages();
    updateProxyCompatibilityUI();
};

function renderNanobananaRefImages() {
    const container = getOrCacheElement("qig-nanobanana-refs");
    if (!container) return;
    const imgs = getSettings().nanobananaRefImages || [];
    container.innerHTML = imgs.map((src, i) =>
        `<div style="position:relative;"><img src="${escapeHtml(src || "")}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;"><button onclick="removeNanobananaRefImage(${i})" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e94560;color:#fff;font-size:10px;cursor:pointer;line-height:1;">×</button></div>`
    ).join('');
}

window.removeNanobananaRefImage = function (idx) {
    const s = getSettings();
    if (!s.nanobananaRefImages) s.nanobananaRefImages = [];
    s.nanobananaRefImages.splice(idx, 1);
    saveSettingsDebounced();
    renderNanobananaRefImages();
};

function renderNanogptRefImages() {
    const container = getOrCacheElement("qig-nanogpt-refs");
    if (!container) return;
    const imgs = getSettings().nanogptRefImages || [];
    container.innerHTML = imgs.map((src, i) =>
        `<div style="position:relative;"><img src="${escapeHtml(src || "")}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;"><button onclick="removeNanogptRefImage(${i})" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e94560;color:#fff;font-size:10px;cursor:pointer;line-height:1;">×</button></div>`
    ).join('');
}

window.removeNanogptRefImage = function (idx) {
    const s = getSettings();
    if (!s.nanogptRefImages) s.nanogptRefImages = [];
    s.nanogptRefImages.splice(idx, 1);
    saveSettingsDebounced();
    renderNanogptRefImages();
};

function bind(id, key, isNum = false, isCheckbox = false, onChange = null) {
    if (typeof isNum === "function") {
        onChange = isNum;
        isNum = false;
    } else if (typeof isCheckbox === "function") {
        onChange = isCheckbox;
        isCheckbox = false;
    }
    const el = getOrCacheElement(id);
    if (!el) return;
    el.oninput = (e) => {
        const value = isCheckbox ? e.target.checked : (isNum ? parseFloat(e.target.value) : e.target.value);
        getSettings()[key] = value;
        if (key === "prompt") {
            log(`[Prompt] Saved to settings: "${value.substring(0, 50)}..."`);
        }
        if (typeof onChange === "function") onChange(value, e);
        saveSettingsDebounced();
    };
}

function bindCheckbox(id, key) {
    return bind(id, key, false, true);
}

function setAutoGenerateEnabled(checked) {
    const normalized = !!checked;
    const s = getSettings();
    s.autoGenerate = normalized;
    normalizeAutoGenerateSettings(s);
    syncAutoGenerateControls(s);
    resetAutoGenerateCadence({ clearTimer: true });
}

function syncAutoGenerateControls(settings = getSettings()) {
    const s = normalizeAutoGenerateSettings(settings);
    const enabledEl = getOrCacheElement("qig-auto-generate");
    if (enabledEl) enabledEl.checked = !!s?.autoGenerate;
    const everyEl = getOrCacheElement("qig-auto-generate-every");
    if (everyEl) everyEl.value = String(s?.autoGenerateEveryMessages ?? AUTO_GENERATE_EVERY_DEFAULT);
    const delayEl = getOrCacheElement("qig-auto-generate-delay");
    if (delayEl) delayEl.value = String(s?.autoGenerateDelayMs ?? AUTO_GENERATE_DELAY_DEFAULT);
}

function syncTwoStepPromptControls(settings = getSettings()) {
    const panel = getOrCacheElement("qig-two-step-options");
    if (panel) panel.style.display = settings?.twoStepPrompt ? "block" : "none";
}

function syncBackgroundControls(settings = getSettings()) {
    const modeEl = getOrCacheElement("qig-background-mode");
    if (!modeEl) return;
    const enabled = !!settings?.autoSetBackground;
    modeEl.value = normalizeBackgroundMode(settings?.backgroundMode);
    modeEl.disabled = !enabled;
    const field = modeEl.closest(".qig-field");
    if (field) field.style.opacity = enabled ? "1" : "0.6";
}

function bindAutoGenerateCheckbox(id) {
    const el = getOrCacheElement(id);
    if (!el) return;
    el.onchange = (e) => {
        setAutoGenerateEnabled(e.target.checked);
        saveSettingsDebounced();
    };
}

function bindAutoGenerateNumberInput(id, key, normalizer) {
    const el = getOrCacheElement(id);
    if (!el) return;
    el.oninput = (e) => {
        const s = getSettings();
        const next = normalizer(e.target.value);
        const changed = s[key] !== next;
        s[key] = next;
        if (changed) resetAutoGenerateCadence({ clearTimer: true });
        saveSettingsDebounced();
    };
    el.onchange = () => syncAutoGenerateControls();
}

function modelSelect(provider, settingKey, currentVal) {
    const models = PROVIDER_MODELS[provider];
    if (!models) return `<input id="qig-${settingKey}" type="text" value="${escapeHtml(currentVal ?? "")}" placeholder="Model ID">`;
    const opts = models.map(m => `<option value="${m.id}" ${currentVal === m.id ? "selected" : ""}>${m.name}</option>`).join("");
    return `<select id="qig-${settingKey}">${opts}</select>`;
}

function pollinationsModelInput(currentVal) {
    const value = escapeHtml(currentVal ?? "");
    const knownIds = new Set();
    const datalistOptions = [];

    for (const model of POLLINATIONS_MODEL_OPTIONS) {
        if (knownIds.has(model.id)) continue;
        knownIds.add(model.id);
        const label = model.id
            ? `${model.name} - ${model.id}`
            : model.name;
        datalistOptions.push(`<option value="${escapeHtml(model.id)}" label="${escapeHtml(label)}"></option>`);
    }

    const normalizedCurrent = String(currentVal ?? "").trim();
    if (normalizedCurrent && !knownIds.has(normalizedCurrent)) {
        datalistOptions.push(`<option value="${escapeHtml(normalizedCurrent)}" label="${escapeHtml(`${normalizedCurrent} - current custom model`)}"></option>`);
    }

    return `
        <input id="qig-pollinations-model" type="text" list="qig-pollinations-model-list" value="${value}" placeholder="Leave blank for default or type any Pollinations model ID">
        <datalist id="qig-pollinations-model-list">${datalistOptions.join("")}</datalist>
    `;
}

function gptImageModelInput(currentVal) {
    const value = escapeHtml(currentVal ?? "");
    const knownIds = new Set();
    const options = [];
    for (const model of PROVIDER_MODELS.gptimage || []) {
        if (!model?.id || knownIds.has(model.id)) continue;
        knownIds.add(model.id);
        options.push(`<option value="${escapeHtml(model.id)}" label="${escapeHtml(model.name || model.id)}"></option>`);
    }
    const normalizedCurrent = String(currentVal ?? "").trim();
    if (normalizedCurrent && !knownIds.has(normalizedCurrent)) {
        options.push(`<option value="${escapeHtml(normalizedCurrent)}" label="${escapeHtml(`${normalizedCurrent} - current custom model`)}"></option>`);
    }
    return `
        <input id="qig-gpt-image-model" type="text" list="qig-gpt-image-model-list" value="${value}" placeholder="gpt-image-2">
        <datalist id="qig-gpt-image-model-list">${options.join("")}</datalist>
    `;
}

function routewayModelInput(currentVal) {
    const value = escapeHtml(currentVal ?? "");
    const knownIds = new Set();
    const options = [];
    for (const model of PROVIDER_MODELS.routeway || []) {
        if (!model?.id || knownIds.has(model.id)) continue;
        knownIds.add(model.id);
        options.push(`<option value="${escapeHtml(model.id)}" label="${escapeHtml(model.name || model.id)}"></option>`);
    }
    const normalizedCurrent = String(currentVal ?? "").trim();
    if (normalizedCurrent && !knownIds.has(normalizedCurrent)) {
        options.push(`<option value="${escapeHtml(normalizedCurrent)}" label="${escapeHtml(`${normalizedCurrent} - current custom model`)}"></option>`);
    }
    return `
        <input id="qig-routeway-model" type="text" list="qig-routeway-model-list" value="${value}" placeholder="flux-1-schnell">
        <datalist id="qig-routeway-model-list">${options.join("")}</datalist>
    `;
}

function navyModelInput(currentVal) {
    const value = escapeHtml(currentVal ?? "");
    const knownIds = new Set();
    const options = [];
    for (const model of PROVIDER_MODELS.navy || []) {
        if (!model?.id || knownIds.has(model.id)) continue;
        knownIds.add(model.id);
        options.push(`<option value="${escapeHtml(model.id)}" label="${escapeHtml(model.name || model.id)}"></option>`);
    }
    const normalizedCurrent = String(currentVal ?? "").trim();
    if (normalizedCurrent && !knownIds.has(normalizedCurrent)) {
        options.push(`<option value="${escapeHtml(normalizedCurrent)}" label="${escapeHtml(`${normalizedCurrent} - current custom model`)}"></option>`);
    }
    return `
        <input id="qig-navy-model" type="text" list="qig-navy-model-list" value="${value}" placeholder="flux">
        <datalist id="qig-navy-model-list">${options.join("")}</datalist>
    `;
}

function buildOptions(items, selectedValue, labelFn) {
    return items.map(([k, v]) =>
        `<option value="${k}" ${selectedValue === k ? "selected" : ""}>${labelFn ? labelFn(v) : v}</option>`
    ).join("");
}

function createUI() {
    clearCache();
    document.querySelectorAll("#qig-settings").forEach(el => el.remove());
    const s = getSettings();
    if (s.provider === "novelai") normalizeSize(s);
    const esc = (v) => escapeHtml(v == null ? "" : String(v));
    const collapsed = getCollapsedSections(s);
    const providerSettingsHidden = collapsed.providerSettings ? "hidden" : "";
    const providerSettingsExpanded = collapsed.providerSettings ? "false" : "true";
    const promptAdvancedHidden = collapsed.promptAdvanced ? "hidden" : "";
    const promptAdvancedExpanded = collapsed.promptAdvanced ? "false" : "true";
    const injectOptionsCollapsed = collapsed.injectOptions && !s.injectEnabled;
    const injectOptionsHidden = injectOptionsCollapsed ? "hidden" : "";
    const injectOptionsExpanded = injectOptionsCollapsed ? "false" : "true";
    const advancedSettingsHidden = collapsed.advancedSettings ? "hidden" : "";
    const advancedSettingsExpanded = collapsed.advancedSettings ? "false" : "true";
    const selectedNaiResolution = getNaiResolutionOptionValue(s.width, s.height);
    const samplerOpts = Object.entries(SAMPLER_GROUPS).map(([group, ids]) =>
        `<optgroup label="${group}">${ids.map(x => `<option value="${x}" ${s.sampler === x ? "selected" : ""}>${SAMPLER_DISPLAY_NAMES[x] || x}</option>`).join("")}</optgroup>`
    ).join("");
    const comfyWorkflowPresetOpts = [
        `<option value="">-- Select Workflow Preset --</option>`,
        ...comfyWorkflows.map(w => `<option value="${esc(w.id || "")}" ${w.id === selectedComfyWorkflowId ? "selected" : ""}>${esc(w.name || "(unnamed)")}</option>`)
    ].join("");
    const providerOpts = buildOptions(Object.entries(PROVIDERS), s.provider, v => v.name);
    const styleOpts = buildOptions(Object.entries(STYLES), s.style, v => v.name);
    const activeProviderName = PROVIDERS[s.provider]?.name || s.provider || "Provider";
    const activeStyleName = STYLES[s.style]?.name || s.style || "No style";
    const activeBatchCount = Math.max(1, Number(s.batchCount) || 1);
    const activeBatchLabel = `${activeBatchCount} image${activeBatchCount === 1 ? "" : "s"}`;

    const html = `
    <div id="qig-settings" class="qig-settings" role="region" aria-label="Quick Image Gen settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Quick Image Gen</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <nav class="qig-action-bar" aria-label="Quick Image Gen primary actions">
                    <button id="qig-generate-btn" class="menu_button qig-primary-action" title="Generate image with current settings (Ctrl+Enter)" aria-label="Generate image with current settings">
                        <span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span>
                        <span>Generate</span>
                        <span class="qig-shortcut-hint">Ctrl+Enter</span>
                    </button>
                    <button id="qig-gallery-settings-btn" class="menu_button qig-action-bar__secondary" title="Browse generated images (Ctrl+Shift+G)" aria-label="Open generated image gallery"><span class="fa-solid fa-images" aria-hidden="true"></span><span>Gallery</span></button>
                    <button id="qig-prompt-history-btn" class="menu_button qig-action-bar__secondary" title="View prompt history (Ctrl+Shift+H)" aria-label="Open prompt history"><span class="fa-solid fa-clock-rotate-left" aria-hidden="true"></span><span>Prompts</span></button>
                </nav>

                <div class="qig-menu-hero">
                    <div class="qig-menu-hero__summary">
                        <span class="qig-menu-eyebrow">Ready to generate</span>
                        <div class="qig-menu-title">Quick Image Gen</div>
                        <div class="qig-menu-meta">
                            <span>${esc(activeProviderName)}</span>
                            <span>${esc(activeStyleName)}</span>
                            <span>${esc(activeBatchLabel)}</span>
                        </div>
                    </div>
                    <div class="qig-hero-note">Set provider and prompt below. Generate stays available while you scroll.</div>
                </div>

                <div class="qig-quick-actions" aria-label="Quick Image Gen shortcuts">
                    <button id="qig-save-char-btn" class="menu_button" title="Save current settings as defaults for this character"><span class="fa-solid fa-user-check"></span><span>Save Char</span></button>
                    <button id="qig-logs-btn" class="menu_button" title="View generation logs and errors"><span class="fa-solid fa-list-check"></span><span>Logs</span></button>
                </div>

                <section class="qig-menu-section qig-menu-section--connection" aria-labelledby="qig-connection-heading">
                    <div class="qig-section-header">
                        <div>
                            <span id="qig-connection-heading" class="qig-section-kicker">Connection</span>
                            <p>Choose the image backend, load reusable credentials, and set the active style.</p>
                        </div>
                    </div>
                    <div class="qig-control-grid">
                        <div class="qig-field">
                            <label>Provider</label>
                            <select id="qig-provider">${providerOpts}</select>
                            <small>Image generation service, cloud API or local server.</small>
                        </div>
                        <div class="qig-field">
                            <label>Style</label>
                            <select id="qig-style">${styleOpts}</select>
                            <small>Visual style preset applied to the prompt.</small>
                        </div>
                        <div class="qig-field qig-field--full">
                            <label>Connection Profile</label>
                            <div class="qig-inline-control">
                                <div id="qig-profile-select" class="qig-inline-control__main"></div>
                                <button id="qig-profile-save" class="menu_button" title="Save current provider, API key, and model as a reusable profile"><span class="fa-solid fa-floppy-disk"></span><span>Save Profile</span></button>
                            </div>
                        </div>
                    </div>
                    <div class="qig-provider-card qig-collapsible">
                        <button id="qig-provider-settings-toggle" type="button" class="qig-collapsible__header" aria-expanded="${providerSettingsExpanded}" aria-controls="qig-provider-settings-content">
                            <span>
                                <span class="qig-card-title">Active Provider Settings</span>
                                <small>Credentials, model IDs, and provider-specific options for ${esc(activeProviderName)}.</small>
                            </span>
                            <span class="qig-collapsible__icon fa-solid ${collapsed.providerSettings ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></span>
                        </button>
                        <div id="qig-provider-settings-content" class="qig-collapsible__content" ${providerSettingsHidden}>
                <div id="qig-pollinations-settings" class="qig-provider-section">
                    <label>Pollinations API Key <small>(optional, required for paid models)</small></label>
                    <input id="qig-pollinations-key" type="password" value="${esc(s.pollinationsKey)}" placeholder="pk_... or sk_...">
                    <small style="opacity:0.6;font-size:10px;">Latest Pollinations paid access uses API keys. Use <code>pk_</code> keys for browser/client-side use when possible.</small>
                    <label>Model</label>
                    ${pollinationsModelInput(s.pollinationsModel)}
                    <small style="opacity:0.6;font-size:10px;">Suggestions include current free and paid Pollinations image models. You can also type any custom model ID manually.</small>
                </div>
                
                <div id="qig-novelai-settings" class="qig-provider-section">
                    <label>NovelAI API Key</label>
                    <input id="qig-nai-key" type="password" value="${esc(s.naiKey)}">
                    <label>Model</label>
                    <input id="qig-nai-model" type="text" value="${esc(s.naiModel)}" placeholder="nai-diffusion-4-5-curated">
                    <label>Proxy URL <small>(optional — leave blank to use official API)</small></label>
                    <input id="qig-nai-proxy-url" type="text" value="${esc(s.naiProxyUrl)}" placeholder="https://your-proxy-url">
                    <label>Proxy Key <small>(optional — overrides API key above for proxy)</small></label>
                    <input id="qig-nai-proxy-key" type="password" value="${esc(s.naiProxyKey)}" placeholder="Leave blank to use API key above">
                </div>

                <div id="qig-gptimage-settings" class="qig-provider-section">
                    <label>OpenAI API Key</label>
                    <input id="qig-gpt-image-key" type="password" value="${esc(s.gptImageKey)}" placeholder="sk-...">
                    <label>Model</label>
                    ${gptImageModelInput(s.gptImageModel)}
                    <small style="opacity:0.6;font-size:10px;">Defaults to <code>gpt-image-2</code>. You can type any compatible model ID for proxies.</small>
                    <label>Proxy URL <small>(optional — leave blank to use official OpenAI API)</small></label>
                    <input id="qig-gpt-image-proxy-url" type="text" value="${esc(s.gptImageProxyUrl)}" placeholder="https://your-proxy-url/v1">
                    <label>Proxy Key <small>(optional — overrides API key above for proxy)</small></label>
                    <input id="qig-gpt-image-proxy-key" type="password" value="${esc(s.gptImageProxyKey)}" placeholder="Leave blank to use API key above">
                    <div class="qig-row">
                        <div>
                            <label>Quality</label>
                            <select id="qig-gpt-image-quality">
                                <option value="auto" ${s.gptImageQuality === "auto" ? "selected" : ""}>Auto</option>
                                <option value="low" ${s.gptImageQuality === "low" ? "selected" : ""}>Low</option>
                                <option value="medium" ${s.gptImageQuality === "medium" ? "selected" : ""}>Medium</option>
                                <option value="high" ${s.gptImageQuality === "high" ? "selected" : ""}>High</option>
                            </select>
                        </div>
                        <div>
                            <label>Format</label>
                            <select id="qig-gpt-image-format">
                                <option value="png" ${s.gptImageFormat === "png" ? "selected" : ""}>PNG</option>
                                <option value="jpeg" ${s.gptImageFormat === "jpeg" ? "selected" : ""}>JPEG</option>
                                <option value="webp" ${s.gptImageFormat === "webp" ? "selected" : ""}>WebP</option>
                            </select>
                        </div>
                    </div>
                    <div class="qig-row">
                        <div>
                            <label>Background</label>
                            <select id="qig-gpt-image-background">
                                <option value="auto" ${s.gptImageBackground === "auto" ? "selected" : ""}>Auto</option>
                                <option value="transparent" ${s.gptImageBackground === "transparent" ? "selected" : ""}>Transparent</option>
                                <option value="opaque" ${s.gptImageBackground === "opaque" ? "selected" : ""}>Opaque</option>
                            </select>
                        </div>
                        <div>
                            <label>Moderation</label>
                            <select id="qig-gpt-image-moderation">
                                <option value="auto" ${s.gptImageModeration === "auto" ? "selected" : ""}>Auto</option>
                                <option value="low" ${s.gptImageModeration === "low" ? "selected" : ""}>Low</option>
                            </select>
                        </div>
                    </div>
                    <small style="opacity:0.6;font-size:10px;">QIG maps the shared size controls to GPT Image sizes: square, landscape, or portrait. Transparent background works with PNG/WebP. Negative prompt text is appended as an avoid instruction.</small>
                </div>
                
                <div id="qig-arliai-settings" class="qig-provider-section">
                    <label>ArliAI API Key</label>
                    <input id="qig-arli-key" type="password" value="${esc(s.arliKey)}">
                    <label>Model</label>
                    <input id="qig-arli-model" type="text" value="${esc(s.arliModel)}" placeholder="arliai-realistic-v1">
                </div>

                <div id="qig-routeway-settings" class="qig-provider-section">
                    <label>Routeway API Key</label>
                    <input id="qig-routeway-key" type="password" value="${esc(s.routewayKey)}" placeholder="clsk-...">
                    <label>Model</label>
                    ${routewayModelInput(s.routewayModel)}
                    <small style="opacity:0.6;font-size:10px;">Suggestions include known Routeway image models. Custom model IDs are supported. Known models auto-map the shared size controls to the nearest supported API size.</small>
                </div>

                <div id="qig-navy-settings" class="qig-provider-section">
                    <label>Navy.ai API Key</label>
                    <input id="qig-navy-key" type="password" value="${esc(s.navyKey)}">
                    <label>Model</label>
                    ${navyModelInput(s.navyModel)}
                    <small style="opacity:0.6;font-size:10px;">Suggestions include known Navy.ai image models. Custom model IDs are supported.</small>
                </div>

                <div id="qig-nanogpt-settings" class="qig-provider-section">
                    <label>NanoGPT API Key</label>
                    <input id="qig-nanogpt-key" type="password" value="${esc(s.nanogptKey)}">
                    <label>Model</label>
                    <input id="qig-nanogpt-model" type="text" value="${esc(s.nanogptModel)}" placeholder="image-flux-schnell">
                    <label>Strength <span id="qig-nanogpt-strength-val">${s.nanogptStrength ?? 0.75}</span></label>
                    <input id="qig-nanogpt-strength" type="range" min="0" max="1" step="0.05" value="${s.nanogptStrength ?? 0.75}" oninput="document.getElementById('qig-nanogpt-strength-val').textContent=this.value">
                    <label>Reference Images (up to 15)</label>
                    <div id="qig-nanogpt-refs" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;"></div>
                    <input type="file" id="qig-nanogpt-ref-input" accept="image/*" multiple style="display:none">
                    <div style="display:flex;gap:4px;align-items:center;">
                        <button id="qig-nanogpt-ref-btn" class="menu_button" style="padding:4px 8px;">📎 Files</button>
                        <input id="qig-nanogpt-ref-url" type="text" placeholder="Paste image URL and press Enter" style="flex:1;font-size:11px;">
                    </div>
                </div>
                
                <div id="qig-chutes-settings" class="qig-provider-section">
                    <label>Chutes API Key</label>
                    <input id="qig-chutes-key" type="password" value="${esc(s.chutesKey)}">
                    <label>Model</label>
                    <input id="qig-chutes-model" type="text" value="${esc(s.chutesModel)}" placeholder="stabilityai/stable-diffusion-xl-base-1.0">
                </div>
                
                <div id="qig-civitai-settings" class="qig-provider-section">
                    <label>CivitAI API Key</label>
                    <input id="qig-civitai-key" type="password" value="${esc(s.civitaiKey)}">
                    <label>Model URN</label>
                    <input id="qig-civitai-model" type="text" value="${esc(s.civitaiModel)}" placeholder="urn:air:sd1:checkpoint:civitai:4201@130072">
                    <small style="opacity:0.6;font-size:10px;">Find this on the model page → API tab → copy the URN</small>
                    <label>Scheduler</label>
                    <select id="qig-civitai-scheduler">
                        <option value="EulerA" ${s.civitaiScheduler === "EulerA" ? "selected" : ""}>Euler A</option>
                        <option value="Euler" ${s.civitaiScheduler === "Euler" ? "selected" : ""}>Euler</option>
                        <option value="DPM++ 2M Karras" ${s.civitaiScheduler === "DPM++ 2M Karras" ? "selected" : ""}>DPM++ 2M Karras</option>
                        <option value="DPM++ SDE Karras" ${s.civitaiScheduler === "DPM++ SDE Karras" ? "selected" : ""}>DPM++ SDE Karras</option>
                        <option value="DDIM" ${s.civitaiScheduler === "DDIM" ? "selected" : ""}>DDIM</option>
                    </select>
                    <label>LoRAs (URN:weight, comma-separated)</label>
                    <small style="opacity:0.6;font-size:10px;">Always applied. For scene-specific LoRAs, use Contextual Filters.</small>
                    <input id="qig-civitai-loras" type="text" value="${esc(s.civitaiLoras || "")}" placeholder="urn:air:sd1:lora:civitai:82098@87153:0.8, urn:air:sdxl:lora:civitai:12345@67890:1.0">
                </div>
                
                <div id="qig-nanobanana-settings" class="qig-provider-section">
                    <div class="qig-provider-ready">
                        <div>
                            <strong>Nano Banana Pro setup</strong>
                            <small>Use a Gemini API key, keep the Pro model selected, then generate from the current chat scene or a direct prompt.</small>
                        </div>
                        <span class="qig-status-pill ${s.nanobananaKey ? "qig-status-pill--ready" : ""}">${s.nanobananaKey ? "Key saved" : "Needs key"}</span>
                    </div>
                    <div class="qig-row">
                        <div>
                            <label for="qig-nanobanana-key">Gemini API Key</label>
                            <input id="qig-nanobanana-key" type="password" value="${esc(s.nanobananaKey)}" autocomplete="off" placeholder="AI Studio API key">
                            <small>Stored in SillyTavern extension settings. Save a Connection Profile if you swap providers often.</small>
                        </div>
                        <div>
                            <label for="qig-nanobanana-model">Model</label>
                            <select id="qig-nanobanana-model">
                                ${buildNanobananaModelOptions(s.nanobananaModel)}
                            </select>
                            <small>Pro gives the strongest instruction following. Flash is better for quick drafts.</small>
                        </div>
                    </div>
                    <div class="qig-nbp-panel">
                        <label class="checkbox_label qig-nbp-toggle">
                            <input id="qig-nanobanana-nbp-mode" type="checkbox" ${s.nanobananaNbpMode !== false ? "checked" : ""}>
                            <span>Use TLD Nano Banana Pro director</span>
                        </label>
                        <div id="qig-nanobanana-nbp-options" class="qig-dependent-panel" style="display:${s.nanobananaNbpMode !== false ? "block" : "none"}">
                            <div class="qig-row">
                                <div>
                                    <label for="qig-nanobanana-nbp-preset">Director preset</label>
                                    <select id="qig-nanobanana-nbp-preset">
                                        ${Object.entries(NBP_DIRECTOR_PROMPTS).map(([key, preset]) => `<option value="${esc(key)}" ${normalizeNbpDirectorPreset(s.nanobananaNbpPreset) === key ? "selected" : ""}>${esc(preset.name)}</option>`).join("")}
                                    </select>
                                </div>
                                <label class="checkbox_label qig-inline-checkbox">
                                    <input id="qig-nanobanana-nbp-negative" type="checkbox" ${s.nanobananaNbpUseNegative !== false ? "checked" : ""}>
                                    <span>Include anti-gloss and anatomy guardrails</span>
                                </label>
                            </div>
                            <div id="qig-nanobanana-custom-director-wrap" style="display:${normalizeNbpDirectorPreset(s.nanobananaNbpPreset) === "custom" ? "block" : "none"}">
                                <label for="qig-nanobanana-nbp-custom-director">Custom director prompt</label>
                                <textarea id="qig-nanobanana-nbp-custom-director" rows="5" placeholder="Write the full reusable art-direction prompt. This replaces the built-in TLD director when Custom Director is selected.">${esc(s.nanobananaNbpCustomDirector || "")}</textarea>
                                <small>Use this for your own NBP prompting style, provider experiments, or alternate house styles. The scene-specific note below still appends after it.</small>
                            </div>
                            <label for="qig-nanobanana-nbp-custom">Scene-specific director note</label>
                            <textarea id="qig-nanobanana-nbp-custom" rows="2" placeholder="Optional: preserve Kokomi's canon outfit, use intimate close framing, keep the cave lighting warm...">${esc(s.nanobananaNbpCustomPrompt || "")}</textarea>
                            <small>The director text is injected into the provider request after the final QIG prompt. It works with manual prompts, chat-message prompts, and LLM prompt rewriting.</small>
                        </div>
                    </div>
                    <label for="qig-nanobanana-extra">Extra Instructions</label>
                    <textarea id="qig-nanobanana-extra" rows="2" placeholder="Optional one-off provider instruction. Usually leave blank when the NBP director is enabled.">${esc(s.nanobananaExtraInstructions || "")}</textarea>
                    <label>Reference Images (up to 15)</label>
                    <div id="qig-nanobanana-refs" class="qig-ref-grid"></div>
                    <input type="file" id="qig-nanobanana-ref-input" accept="image/*" multiple style="display:none">
                    <div class="qig-ref-controls">
                        <button id="qig-nanobanana-ref-btn" class="menu_button" title="Add reference image files"><span class="fa-solid fa-paperclip"></span><span>Files</span></button>
                        <input id="qig-nanobanana-ref-url" type="text" placeholder="Paste image URL and press Enter">
                    </div>
                </div>

                <div id="qig-stability-settings" class="qig-provider-section">
                    <label>Stability AI API Key</label>
                    <input id="qig-stability-key" type="password" value="${esc(s.stabilityKey)}">
                    <div class="form-hint">Uses SDXL 1.0</div>
                </div>

                <div id="qig-replicate-settings" class="qig-provider-section">
                    <label>Replicate API Key</label>
                    <input id="qig-replicate-key" type="password" value="${esc(s.replicateKey)}">
                    <label>Model Version</label>
                    <input id="qig-replicate-model" type="text" value="${esc(s.replicateModel)}" placeholder="stability-ai/sdxl:...">
                    <small style="opacity:0.6;font-size:10px;">owner/model:version format from the Replicate model page</small>
                </div>

                <div id="qig-fal-settings" class="qig-provider-section">
                    <label>Fal.ai API Key</label>
                    <input id="qig-fal-key" type="password" value="${esc(s.falKey)}">
                    <label>Model Endpoint</label>
                    <input id="qig-fal-model" type="text" value="${esc(s.falModel)}" placeholder="fal-ai/flux/schnell">
                    <small style="opacity:0.6;font-size:10px;">Model path from the Fal.ai dashboard (e.g., fal-ai/flux/schnell)</small>
                </div>

                <div id="qig-together-settings" class="qig-provider-section">
                    <label>Together AI API Key</label>
                    <input id="qig-together-key" type="password" value="${esc(s.togetherKey)}">
                    <label>Model</label>
                    <input id="qig-together-model" type="text" value="${esc(s.togetherModel)}" placeholder="stabilityai/stable-diffusion-xl-base-1.0">
                </div>

                <div id="qig-zai-settings" class="qig-provider-section">
                    <label>Z.AI API Key</label>
                    <input id="qig-zai-key" type="password" value="${esc(s.zaiKey)}">
                    <label>Model</label>
                    ${modelSelect("zai", "zai-model", s.zaiModel)}
                    <label>Quality</label>
                    <select id="qig-zai-quality">
                        <option value="hd" ${s.zaiQuality === "hd" ? "selected" : ""}>HD (slower, more detail)</option>
                        <option value="standard" ${s.zaiQuality === "standard" ? "selected" : ""}>Standard (faster)</option>
                    </select>
                    <div class="form-hint">Image URLs expire after 30 days. Sizes are constrained per-model.</div>
                </div>

                <div id="qig-local-settings" class="qig-provider-section">
                    <label>Local URL</label>
                    <input id="qig-local-url" type="text" value="${esc(s.localUrl)}" placeholder="http://127.0.0.1:7860">
                    <label>Type</label>
                    <select id="qig-local-type">
                        <option value="a1111" ${s.localType === "a1111" ? "selected" : ""}>Automatic1111</option>
                        <option value="comfyui" ${s.localType === "comfyui" ? "selected" : ""}>ComfyUI</option>
                    </select>
                    <div id="qig-local-comfyui-opts" style="display:${s.localType === "comfyui" ? "block" : "none"}">
                         <label>Model</label>
                         <div style="display:flex;gap:4px;align-items:center;">
                             <select id="qig-local-model" style="flex:1;">
                                 <option value="${esc(s.localModel)}" selected>${esc(s.localModel || "-- Click Refresh --")}</option>
                             </select>
                             <button id="qig-comfy-model-refresh" class="menu_button" style="padding:4px 8px;" title="Refresh model list">🔄</button>
                         </div>
                         <div class="form-hint">Click Refresh to load checkpoints (standard mode) or diffusion UNETs (Flux/UNET mode) from ComfyUI, or type a model manually.</div>
                         <div class="qig-row">
                            <div><label>Denoise</label><input id="qig-comfy-denoise" type="number" value="${esc(s.comfyDenoise ?? 1.0)}" min="0" max="1" step="0.05"><small style="opacity:0.6;font-size:10px;">1.0 = full txt2img. For img2img: upload a Reference Image below and set Denoise &lt; 1.0</small></div>
                            <div><label>CLIP Skip</label><input id="qig-comfy-clip" type="number" value="${esc(s.comfyClipSkip || 1)}" min="1" max="12" step="1"><small style="opacity:0.6;font-size:10px;">1 for most models, 2 for anime/NAI-based</small></div>
                         </div>
                         <label>Scheduler</label>
                         <select id="qig-comfy-scheduler">${COMFY_SCHEDULERS.map(x => `<option value="${x}" ${s.comfyScheduler === x ? "selected" : ""}>${x}</option>`).join("")}</select>
                         <small style="opacity:0.6;font-size:10px;">Noise schedule for the sampler — karras is popular for DPM++, normal for others</small>
                         <label>Timeout (seconds)</label>
                         <input id="qig-comfy-timeout" type="number" value="${esc(s.comfyTimeout || 300)}" min="10" max="1800">
                         <small style="opacity:0.6;font-size:10px;">How long SillyTavern waits for ComfyUI to finish before giving up.</small>
                         <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer;">
                            <input id="qig-comfy-upscale" type="checkbox" ${s.comfyUpscale ? "checked" : ""}>
                            <span>Upscale Output</span>
                            <small style="opacity:0.6;font-size:10px;">(run upscale model after generation)</small>
                         </label>
                         <div id="qig-comfy-upscale-opts" style="display:${s.comfyUpscale ? 'block' : 'none'}; margin-left:24px; border-left:2px solid rgba(255,255,255,0.1); padding-left:10px;">
                             <label>Upscale Model</label>
                             <input id="qig-comfy-upscale-model" type="text" value="${esc(s.comfyUpscaleModel || "RealESRGAN_x4plus.pth")}" placeholder="RealESRGAN_x4plus.pth">
                             <small style="opacity:0.6;font-size:10px;">Must match filename in ComfyUI models/upscale_models/</small>
                         </div>
                         <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer;">
                            <input id="qig-comfy-skip-neg" type="checkbox" ${s.comfySkipNegativePrompt ? "checked" : ""}>
                            <span>Skip Negative Prompt</span>
                            <small style="opacity:0.6;font-size:10px;">(for Flux/UNET-only models that don't use negative conditioning)</small>
                         </label>
                         <div id="qig-comfy-flux-opts" style="display:${s.comfySkipNegativePrompt ? 'block' : 'none'}; margin-left:24px; border-left:2px solid rgba(255,255,255,0.1); padding-left:10px;">
                            <div class="form-hint">UNET-only models need separate CLIP and VAE loaders. Leave blank if your checkpoint already includes CLIP+VAE (full Flux checkpoints).</div>
                            <div class="qig-row">
                                <div><label>CLIP Model 1</label><input id="qig-comfy-flux-clip1" type="text" value="${esc(s.comfyFluxClipModel1 || "")}" placeholder="t5xxl_fp16.safetensors"><small style="opacity:0.6;font-size:10px;">From models/text_encoders/</small></div>
                                <div><label>CLIP Model 2</label><input id="qig-comfy-flux-clip2" type="text" value="${esc(s.comfyFluxClipModel2 || "")}" placeholder="clip_l.safetensors"><small style="opacity:0.6;font-size:10px;">From models/text_encoders/ (leave blank if single-CLIP)</small></div>
                            </div>
                            <label>CLIP Type</label>
                            <input id="qig-comfy-flux-clip-type" type="text" value="${esc(s.comfyFluxClipType || "flux")}" placeholder="flux">
                            <small style="opacity:0.6;font-size:10px;">DualCLIP (2 models): flux, sdxl, sd3, hunyuan_video. SingleCLIP (1 model): flux2, sd3, stable_diffusion, qwen_image, hunyuan_image, etc.</small>
                            <label>VAE Model</label>
                            <input id="qig-comfy-flux-vae" type="text" value="${esc(s.comfyFluxVaeModel || "")}" placeholder="ae.safetensors">
                            <small style="opacity:0.6;font-size:10px;">From models/vae/. Required for UNET-only models.</small>
                         </div>
                         <label>LoRAs (filename:weight, comma-separated)</label>
                         <small style="opacity:0.6;font-size:10px;">Always applied. For scene-specific LoRAs, use Contextual Filters. Filename must match your ComfyUI loras folder.</small>
                         <input id="qig-comfy-loras" type="text" value="${esc(s.comfyLoras || "")}" placeholder="my_lora.safetensors:0.8, style_lora.safetensors:0.6">
                         <label>Workflow Preset</label>
                         <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                             <select id="qig-comfy-workflow-select" style="flex:1;min-width:180px;">${comfyWorkflowPresetOpts}</select>
                             <button id="qig-comfy-workflow-load" class="menu_button" style="padding:2px 8px;">📂 Load</button>
                             <button id="qig-comfy-workflow-save-as" class="menu_button" style="padding:2px 8px;">💾 Save As</button>
                             <button id="qig-comfy-workflow-update" class="menu_button" style="padding:2px 8px;">♻️ Update</button>
                             <button id="qig-comfy-workflow-del" class="menu_button" style="padding:2px 8px;">🗑️</button>
                         </div>
                         <small style="opacity:0.6;font-size:10px;">Use presets for quick graph switching (e.g., with LoRA / without LoRA). Profiles save provider settings; workflow presets focus on Comfy graph fields.</small>
                         <label>Custom Workflow JSON</label>
                         <textarea id="qig-comfy-workflow" rows="3" placeholder='Paste workflow from ComfyUI "Save (API Format)". Use placeholders: %prompt%, %negative%, %seed%, %width%, %height%, %steps%, %cfg%, %denoise%, %clip_skip%, %sampler%, %scheduler%, %model%, %reference_image%'>${esc(s.comfyWorkflow || "")}</textarea>
                         <div class="form-hint">Optional for standard SD1.5/SDXL checkpoints. Required for non-standard pipelines (Flux/UNET-only, dual-CLIP, custom node graphs). Export from ComfyUI: Save → API Format. Use %reference_image% in a LoadImage node to include the uploaded reference image.</div>
                    </div>
                    <div id="qig-local-a1111-opts" style="display:${s.localType === "a1111" ? "block" : "none"}">
                         <label>Model</label>
                         <div style="display:flex;gap:4px;align-items:center;">
                             <select id="qig-a1111-model" style="flex:1;">
                                 <option value="">-- Click Refresh to load models --</option>
                             </select>
                             <button id="qig-a1111-model-refresh" class="menu_button" style="padding:4px 8px;" title="Refresh model list">🔄</button>
                         </div>
                         <label>LoRAs (name:weight, comma-separated)</label>
                         <small style="opacity:0.6;font-size:10px;">Always applied. For scene-specific LoRAs, use Contextual Filters.</small>
                         <input id="qig-a1111-loras" type="text" value="${esc(s.a1111Loras || "")}" placeholder="my_lora:0.8, detail_lora:0.6">
                         <label>VAE</label>
                         <select id="qig-a1111-vae">
                             <option value="" ${!s.a1111Vae ? "selected" : ""}>Automatic</option>
                         </select>
                         <small style="opacity:0.6;font-size:10px;">Override model's built-in VAE. Click Refresh to populate list.</small>
                         <div class="qig-row" style="margin-top:8px;">
                            <div><label>CLIP Skip</label><input id="qig-a1111-clip" type="number" value="${esc(s.a1111ClipSkip || 1)}" min="1" max="12" step="1"><small style="opacity:0.6;font-size:10px;">1 for most models, 2 for anime/NAI-based</small></div>
                            <div><label>Scheduler</label><select id="qig-a1111-scheduler">${A1111_SCHEDULERS.map(x => `<option value="${x}" ${s.a1111Scheduler === x ? "selected" : ""}>${x}</option>`).join("")}</select><small style="opacity:0.6;font-size:10px;">Noise schedule (A1111 1.6+)</small></div>
                         </div>
                         <div class="qig-row" style="margin-top:4px;">
                            <label class="checkbox_label" style="flex:1;">
                                <input id="qig-a1111-restore-faces" type="checkbox" ${s.a1111RestoreFaces ? "checked" : ""}>
                                <span>Restore Faces</span>
                            </label>
                            <label class="checkbox_label" style="flex:1;">
                                <input id="qig-a1111-tiling" type="checkbox" ${s.a1111Tiling ? "checked" : ""}>
                                <span>Tiling</span>
                            </label>
                         </div>
                         <div class="qig-row" style="margin-top:4px;">
                             <div><label>Variation Seed</label><input id="qig-a1111-subseed" type="number" value="${esc(s.a1111Subseed ?? -1)}"><small style="opacity:0.6;font-size:10px;">-1 = random. Blends with main seed</small></div>
                             <div><label>Variation Strength</label><input id="qig-a1111-subseed-strength" type="number" value="${esc(s.a1111SubseedStrength ?? 0)}" min="0" max="1" step="0.05"><small style="opacity:0.6;font-size:10px;">0 = no effect, 1 = full variation</small></div>
                         </div>
                         <label class="checkbox_label" style="margin-top:8px;">
                             <input id="qig-a1111-hires" type="checkbox" ${s.a1111HiresFix ? "checked" : ""}>
                             <span>Hires Fix (generate at low res, then upscale for detail)</span>
                         </label>
                         <div id="qig-a1111-hires-opts" style="display:${s.a1111HiresFix ? 'block' : 'none'}">
                             <label>Upscaler</label>
                             <select id="qig-a1111-hires-upscaler">
                                 <option value="Latent" selected>Latent</option>
                             </select>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Scale</label><input id="qig-a1111-hires-scale" type="number" value="${esc(s.a1111HiresScale || 2)}" min="1" max="4" step="0.25"></div>
                                 <div><label>2nd Pass Steps (0=same)</label><input id="qig-a1111-hires-steps" type="number" value="${esc(s.a1111HiresSteps || 0)}" min="0" max="150"></div>
                             </div>
                             <label>Denoise: <span id="qig-a1111-hires-denoise-val">${s.a1111HiresDenoise || 0.55}</span></label>
                             <input id="qig-a1111-hires-denoise" type="range" min="0" max="1" step="0.05" value="${esc(s.a1111HiresDenoise || 0.55)}">
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Hires Sampler</label><select id="qig-a1111-hires-sampler"><option value="" ${!s.a1111HiresSampler ? "selected" : ""}>Same as first pass</option>${Object.entries(SAMPLER_DISPLAY_NAMES).map(([k,v]) => `<option value="${v}" ${s.a1111HiresSampler === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
                                 <div><label>Hires Scheduler</label><select id="qig-a1111-hires-scheduler"><option value="" ${!s.a1111HiresScheduler ? "selected" : ""}>Same as first pass</option>${A1111_SCHEDULERS.map(x => `<option value="${x}" ${s.a1111HiresScheduler === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
                             </div>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Resize W (0=use scale)</label><input id="qig-a1111-hires-resize-x" type="number" value="${esc(s.a1111HiresResizeX || 0)}" min="0" max="4096" step="8"></div>
                                 <div><label>Resize H (0=use scale)</label><input id="qig-a1111-hires-resize-y" type="number" value="${esc(s.a1111HiresResizeY || 0)}" min="0" max="4096" step="8"></div>
                             </div>
                             <label>Hires Prompt (optional)</label>
                             <input id="qig-a1111-hires-prompt" type="text" value="${esc(s.a1111HiresPrompt || "")}" placeholder="Leave empty to use main prompt">
                             <label>Hires Negative (optional)</label>
                             <input id="qig-a1111-hires-negative" type="text" value="${esc(s.a1111HiresNegative || "")}" placeholder="Leave empty to use main negative">
                         </div>
                         <label class="checkbox_label">
                             <input id="qig-a1111-adetailer" type="checkbox" ${s.a1111Adetailer ? "checked" : ""}>
                             <span>ADetailer (auto-detect and fix faces/hands)</span>
                         </label>
                         <div id="qig-a1111-adetailer-opts" style="display:${s.a1111Adetailer ? 'block' : 'none'}">
                             <label>ADetailer Model</label>
                             <select id="qig-a1111-adetailer-model">
                                 <option value="face_yolov8n.pt" ${s.a1111AdetailerModel === "face_yolov8n.pt" ? "selected" : ""}>Face YOLOv8n</option>
                                 <option value="face_yolov8s.pt" ${s.a1111AdetailerModel === "face_yolov8s.pt" ? "selected" : ""}>Face YOLOv8s</option>
                                 <option value="hand_yolov8n.pt" ${s.a1111AdetailerModel === "hand_yolov8n.pt" ? "selected" : ""}>Hand YOLOv8n</option>
                                 <option value="person_yolov8n-seg.pt" ${s.a1111AdetailerModel === "person_yolov8n-seg.pt" ? "selected" : ""}>Person YOLOv8n</option>
                                 <option value="mediapipe_face_full" ${s.a1111AdetailerModel === "mediapipe_face_full" ? "selected" : ""}>MediaPipe Face Full</option>
                                 <option value="mediapipe_face_short" ${s.a1111AdetailerModel === "mediapipe_face_short" ? "selected" : ""}>MediaPipe Face Short</option>
                             </select>
                             <label>ADetailer Prompt (optional)</label>
                             <input id="qig-a1111-ad-prompt" type="text" value="${esc(s.a1111AdetailerPrompt || "")}" placeholder="Leave empty to use main prompt">
                             <label>ADetailer Negative (optional)</label>
                             <input id="qig-a1111-ad-negative" type="text" value="${esc(s.a1111AdetailerNegative || "")}" placeholder="Leave empty to use main negative">
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Denoise</label><input id="qig-a1111-ad-denoise" type="number" value="${esc(s.a1111AdetailerDenoise ?? 0.4)}" min="0" max="1" step="0.05"><small style="opacity:0.6;font-size:10px;">Inpaint strength for detected regions</small></div>
                                 <div><label>Confidence</label><input id="qig-a1111-ad-confidence" type="number" value="${esc(s.a1111AdetailerConfidence ?? 0.3)}" min="0" max="1" step="0.05"><small style="opacity:0.6;font-size:10px;">Detection threshold (lower = more detections)</small></div>
                             </div>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Mask Blur</label><input id="qig-a1111-ad-mask-blur" type="number" value="${esc(s.a1111AdetailerMaskBlur ?? 4)}" min="0" max="64" step="1"></div>
                                 <div><label>Dilate/Erode</label><input id="qig-a1111-ad-dilate" type="number" value="${esc(s.a1111AdetailerDilateErode ?? 4)}" min="-128" max="128" step="1"><small style="opacity:0.6;font-size:10px;">Positive = expand mask, negative = shrink</small></div>
                             </div>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Inpaint Padding</label><input id="qig-a1111-ad-inpaint-padding" type="number" value="${esc(s.a1111AdetailerInpaintPadding ?? 32)}" min="0" max="256" step="4"></div>
                                 <label class="checkbox_label" style="flex:1;margin-top:auto;">
                                     <input id="qig-a1111-ad-inpaint-only" type="checkbox" ${s.a1111AdetailerInpaintOnlyMasked ? "checked" : ""}>
                                     <span>Inpaint Only Masked</span>
                                 </label>
                             </div>
                             <hr style="margin:8px 0;opacity:0.15;">
                             <label class="checkbox_label">
                                 <input id="qig-a1111-ad2-enable" type="checkbox" ${s.a1111Adetailer2 ? "checked" : ""}>
                                 <span>ADetailer Unit 2 (e.g. hands)</span>
                             </label>
                             <div id="qig-a1111-ad2-opts" style="display:${s.a1111Adetailer2 ? 'block' : 'none'}; margin-left:12px; border-left:2px solid rgba(255,255,255,0.1); padding-left:10px;">
                                 <label>Model</label>
                                 <select id="qig-a1111-ad2-model">
                                     <option value="face_yolov8n.pt" ${s.a1111Adetailer2Model === "face_yolov8n.pt" ? "selected" : ""}>Face YOLOv8n</option>
                                     <option value="face_yolov8s.pt" ${s.a1111Adetailer2Model === "face_yolov8s.pt" ? "selected" : ""}>Face YOLOv8s</option>
                                     <option value="hand_yolov8n.pt" ${s.a1111Adetailer2Model === "hand_yolov8n.pt" ? "selected" : ""}>Hand YOLOv8n</option>
                                     <option value="person_yolov8n-seg.pt" ${s.a1111Adetailer2Model === "person_yolov8n-seg.pt" ? "selected" : ""}>Person YOLOv8n</option>
                                     <option value="mediapipe_face_full" ${s.a1111Adetailer2Model === "mediapipe_face_full" ? "selected" : ""}>MediaPipe Face Full</option>
                                     <option value="mediapipe_face_short" ${s.a1111Adetailer2Model === "mediapipe_face_short" ? "selected" : ""}>MediaPipe Face Short</option>
                                 </select>
                                 <label>Prompt (optional)</label>
                                 <input id="qig-a1111-ad2-prompt" type="text" value="${esc(s.a1111Adetailer2Prompt || "")}" placeholder="Leave empty to use main prompt">
                                 <label>Negative (optional)</label>
                                 <input id="qig-a1111-ad2-negative" type="text" value="${esc(s.a1111Adetailer2Negative || "")}" placeholder="Leave empty to use main negative">
                                 <div class="qig-row" style="margin-top:4px;">
                                     <div><label>Denoise</label><input id="qig-a1111-ad2-denoise" type="number" value="${esc(s.a1111Adetailer2Denoise ?? 0.4)}" min="0" max="1" step="0.05"></div>
                                     <div><label>Confidence</label><input id="qig-a1111-ad2-confidence" type="number" value="${esc(s.a1111Adetailer2Confidence ?? 0.3)}" min="0" max="1" step="0.05"></div>
                                 </div>
                                 <div class="qig-row" style="margin-top:4px;">
                                     <div><label>Mask Blur</label><input id="qig-a1111-ad2-mask-blur" type="number" value="${esc(s.a1111Adetailer2MaskBlur ?? 4)}" min="0" max="64" step="1"></div>
                                     <div><label>Dilate/Erode</label><input id="qig-a1111-ad2-dilate" type="number" value="${esc(s.a1111Adetailer2DilateErode ?? 4)}" min="-128" max="128" step="1"></div>
                                 </div>
                                 <div class="qig-row" style="margin-top:4px;">
                                     <div><label>Inpaint Padding</label><input id="qig-a1111-ad2-inpaint-padding" type="number" value="${esc(s.a1111Adetailer2InpaintPadding ?? 32)}" min="0" max="256" step="4"></div>
                                     <label class="checkbox_label" style="flex:1;margin-top:auto;">
                                         <input id="qig-a1111-ad2-inpaint-only" type="checkbox" ${s.a1111Adetailer2InpaintOnlyMasked ? "checked" : ""}>
                                         <span>Inpaint Only Masked</span>
                                     </label>
                                 </div>
                             </div>
                         </div>
                         <label class="checkbox_label" style="margin-top:8px;">
                             <input id="qig-a1111-save-webui" type="checkbox" ${s.a1111SaveToWebUI ? "checked" : ""}>
                             <span>Save images to WebUI output folder</span>
                         </label>
                         <label class="checkbox_label" style="margin-top:8px;">
                             <input id="qig-a1111-ipadapter" type="checkbox" ${s.a1111IpAdapter ? "checked" : ""}>
                             <span>IP-Adapter (use a reference image to guide style/composition)</span>
                         </label>
                         <div id="qig-a1111-ipadapter-opts" style="display:${s.a1111IpAdapter ? 'block' : 'none'}">
                             <label>IP-Adapter Model</label>
                             <select id="qig-a1111-ipadapter-mode">
                                 <option value="ip-adapter-faceid-portrait_sd15" ${s.a1111IpAdapterMode === "ip-adapter-faceid-portrait_sd15" ? "selected" : ""}>FaceID Portrait (SD1.5)</option>
                                 <option value="ip-adapter-faceid-portrait-v11_sd15" ${s.a1111IpAdapterMode === "ip-adapter-faceid-portrait-v11_sd15" ? "selected" : ""}>FaceID Portrait v1.1 (SD1.5)</option>
                                 <option value="ip-adapter-faceid_sd15" ${s.a1111IpAdapterMode === "ip-adapter-faceid_sd15" ? "selected" : ""}>FaceID (SD1.5)</option>
                                 <option value="ip-adapter-faceid-plusv2_sd15" ${s.a1111IpAdapterMode === "ip-adapter-faceid-plusv2_sd15" ? "selected" : ""}>FaceID Plus v2 (SD1.5)</option>
                                 <option value="ip-adapter-faceid-portrait_sdxl" ${s.a1111IpAdapterMode === "ip-adapter-faceid-portrait_sdxl" ? "selected" : ""}>FaceID Portrait (SDXL)</option>
                                 <option value="ip-adapter-faceid-portrait_sdxl_unnorm" ${s.a1111IpAdapterMode === "ip-adapter-faceid-portrait_sdxl_unnorm" ? "selected" : ""}>FaceID Portrait Unnorm (SDXL)</option>
                                 <option value="ip-adapter-faceid_sdxl" ${s.a1111IpAdapterMode === "ip-adapter-faceid_sdxl" ? "selected" : ""}>FaceID (SDXL)</option>
                                 <option value="ip-adapter-faceid-plusv2_sdxl" ${s.a1111IpAdapterMode === "ip-adapter-faceid-plusv2_sdxl" ? "selected" : ""}>FaceID Plus v2 (SDXL)</option>
                             </select>
                             <label>Weight: <span id="qig-a1111-ipadapter-weight-val">${s.a1111IpAdapterWeight || 0.7}</span></label>
                             <input id="qig-a1111-ipadapter-weight" type="range" min="0" max="1.5" step="0.05" value="${esc(s.a1111IpAdapterWeight || 0.7)}">
                             
                             <label class="checkbox_label" style="margin-top:4px;">
                                 <input id="qig-a1111-ipadapter-pixel" type="checkbox" ${s.a1111IpAdapterPixelPerfect ? "checked" : ""}>
                                 <span>Pixel Perfect</span>
                             </label>

                             <div class="qig-row" style="margin-top:4px;">
                                 <div>
                                     <label>Control Mode</label>
                                     <select id="qig-a1111-ipadapter-control">
                                         <option value="Balanced" ${s.a1111IpAdapterControlMode === "Balanced" ? "selected" : ""}>Balanced</option>
                                         <option value="My prompt is more important" ${s.a1111IpAdapterControlMode === "My prompt is more important" ? "selected" : ""}>Prompt Priority</option>
                                         <option value="ControlNet is more important" ${s.a1111IpAdapterControlMode === "ControlNet is more important" ? "selected" : ""}>ControlNet Priority</option>
                                     </select>
                                 </div>
                                 <div>
                                     <label>Resize Mode</label>
                                     <select id="qig-a1111-ipadapter-resize">
                                         <option value="Just Resize" ${s.a1111IpAdapterResizeMode === "Just Resize" ? "selected" : ""}>Just Resize</option>
                                         <option value="Crop and Resize" ${s.a1111IpAdapterResizeMode === "Crop and Resize" ? "selected" : ""}>Crop & Resize</option>
                                         <option value="Resize and Fill" ${s.a1111IpAdapterResizeMode === "Resize and Fill" ? "selected" : ""}>Resize & Fill</option>
                                     </select>
                                 </div>
                             </div>

                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Start Step</label><input id="qig-a1111-ipadapter-start" type="number" min="0" max="1" step="0.05" value="${esc(s.a1111IpAdapterStartStep ?? 0)}"></div>
                                 <div><label>End Step</label><input id="qig-a1111-ipadapter-end" type="number" min="0" max="1" step="0.05" value="${esc(s.a1111IpAdapterEndStep ?? 1)}"></div>
                             </div>
                             <div class="form-hint">Requires ControlNet + IP-Adapter extension with FaceID models</div>
                         </div>
                         <label class="checkbox_label" style="margin-top:8px;">
                             <input id="qig-a1111-controlnet" type="checkbox" ${s.a1111ControlNet ? "checked" : ""}>
                             <span>ControlNet (structural guidance from a control image)</span>
                         </label>
                         <div id="qig-a1111-controlnet-opts" style="display:${s.a1111ControlNet ? 'block' : 'none'}">
                             <label>ControlNet Model</label>
                             <select id="qig-a1111-cn-model">
                                 <option value="">-- Click Refresh to load models --</option>
                             </select>
                             <label>Preprocessor</label>
                             <select id="qig-a1111-cn-module">
                                 <option value="none" ${s.a1111ControlNetModule === "none" ? "selected" : ""}>none</option>
                                 <option value="canny" ${s.a1111ControlNetModule === "canny" ? "selected" : ""}>canny</option>
                                 <option value="depth_midas" ${s.a1111ControlNetModule === "depth_midas" ? "selected" : ""}>depth_midas</option>
                                 <option value="depth_zoe" ${s.a1111ControlNetModule === "depth_zoe" ? "selected" : ""}>depth_zoe</option>
                                 <option value="openpose" ${s.a1111ControlNetModule === "openpose" ? "selected" : ""}>openpose</option>
                                 <option value="openpose_full" ${s.a1111ControlNetModule === "openpose_full" ? "selected" : ""}>openpose_full</option>
                                 <option value="lineart" ${s.a1111ControlNetModule === "lineart" ? "selected" : ""}>lineart</option>
                                 <option value="lineart_anime" ${s.a1111ControlNetModule === "lineart_anime" ? "selected" : ""}>lineart_anime</option>
                                 <option value="softedge_pidinet" ${s.a1111ControlNetModule === "softedge_pidinet" ? "selected" : ""}>softedge_pidinet</option>
                                 <option value="scribble_pidinet" ${s.a1111ControlNetModule === "scribble_pidinet" ? "selected" : ""}>scribble_pidinet</option>
                                 <option value="normal_bae" ${s.a1111ControlNetModule === "normal_bae" ? "selected" : ""}>normal_bae</option>
                                 <option value="shuffle" ${s.a1111ControlNetModule === "shuffle" ? "selected" : ""}>shuffle</option>
                                 <option value="tile_resample" ${s.a1111ControlNetModule === "tile_resample" ? "selected" : ""}>tile_resample</option>
                                 <option value="inpaint_only" ${s.a1111ControlNetModule === "inpaint_only" ? "selected" : ""}>inpaint_only</option>
                             </select>
                             <label>Weight: <span id="qig-a1111-cn-weight-val">${s.a1111ControlNetWeight ?? 1.0}</span></label>
                             <input id="qig-a1111-cn-weight" type="range" min="0" max="2" step="0.05" value="${esc(s.a1111ControlNetWeight ?? 1.0)}">
                             <label class="checkbox_label" style="margin-top:4px;">
                                 <input id="qig-a1111-cn-pixel" type="checkbox" ${s.a1111ControlNetPixelPerfect ? "checked" : ""}>
                                 <span>Pixel Perfect</span>
                             </label>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div>
                                     <label>Control Mode</label>
                                     <select id="qig-a1111-cn-control">
                                         <option value="Balanced" ${s.a1111ControlNetControlMode === "Balanced" ? "selected" : ""}>Balanced</option>
                                         <option value="My prompt is more important" ${s.a1111ControlNetControlMode === "My prompt is more important" ? "selected" : ""}>Prompt Priority</option>
                                         <option value="ControlNet is more important" ${s.a1111ControlNetControlMode === "ControlNet is more important" ? "selected" : ""}>ControlNet Priority</option>
                                     </select>
                                 </div>
                                 <div>
                                     <label>Resize Mode</label>
                                     <select id="qig-a1111-cn-resize">
                                         <option value="Just Resize" ${s.a1111ControlNetResizeMode === "Just Resize" ? "selected" : ""}>Just Resize</option>
                                         <option value="Crop and Resize" ${s.a1111ControlNetResizeMode === "Crop and Resize" ? "selected" : ""}>Crop & Resize</option>
                                         <option value="Resize and Fill" ${s.a1111ControlNetResizeMode === "Resize and Fill" ? "selected" : ""}>Resize & Fill</option>
                                     </select>
                                 </div>
                             </div>
                             <div class="qig-row" style="margin-top:4px;">
                                 <div><label>Guidance Start</label><input id="qig-a1111-cn-start" type="number" min="0" max="1" step="0.05" value="${esc(s.a1111ControlNetGuidanceStart ?? 0)}"></div>
                                 <div><label>Guidance End</label><input id="qig-a1111-cn-end" type="number" min="0" max="1" step="0.05" value="${esc(s.a1111ControlNetGuidanceEnd ?? 1)}"></div>
                             </div>
                             <label>Control Image</label>
                             <div style="display:flex;gap:4px;align-items:center;">
                                 <img id="qig-a1111-cn-preview" src="${esc(s.a1111ControlNetImage || '')}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;display:${s.a1111ControlNetImage ? 'block' : 'none'};background:#333;">
                                 <button id="qig-a1111-cn-upload-btn" class="menu_button" style="flex:1;">📎 Upload Control Image</button>
                                 <button id="qig-a1111-cn-clear-btn" class="menu_button" style="width:30px;color:#e94560;display:${s.a1111ControlNetImage ? 'block' : 'none'};">×</button>
                             </div>
                             <input type="file" id="qig-a1111-cn-upload" accept="image/*" style="display:none">
                             <div class="form-hint">Upload a preprocessed control image (edge map, depth map, pose, etc.) or let the preprocessor extract it</div>
                         </div>
                    </div>
                    <hr style="margin:8px 0;opacity:0.2;">
                    <label>Reference Image</label>
                    <div style="display:flex;gap:4px;align-items:center;">
                        <img id="qig-local-ref-preview" src="${esc(s.localRefImage || '')}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;display:${s.localRefImage ? 'block' : 'none'};background:#333;">
                        <button id="qig-local-ref-btn" class="menu_button" style="flex:1;">📎 Upload Source</button>
                        <button id="qig-local-ref-clear" class="menu_button" style="width:30px;color:#e94560;display:${s.localRefImage ? 'block' : 'none'};">×</button>
                    </div>
                    <input type="file" id="qig-local-ref-input" accept="image/*" style="display:none">
                    <div id="qig-local-denoise-wrap" style="display:${s.localType === "a1111" && s.localRefImage ? "block" : "none"};margin-top:4px;">
                       <label>Denoising Strength: <span id="qig-local-denoise-val">${s.localDenoise}</span></label>
                       <input id="qig-local-denoise" type="range" min="0" max="1" step="0.05" value="${esc(s.localDenoise)}">
                    </div>
                    <div class="form-hint" style="margin-top:4px;">Upload a source image for img2img. ${s.localType === "comfyui" ? "Use the Denoise slider in ComfyUI settings above to control strength." : "Adjust Denoising Strength to control how much the output differs."}</div>
                </div>
                
                <div id="qig-proxy-settings" class="qig-provider-section">
                    <label>Proxy URL</label>
                    <input id="qig-proxy-url" type="text" value="${esc(s.proxyUrl)}" placeholder="https://proxy.com/v1">
                    <label>API Key (optional)</label>
                    <input id="qig-proxy-key" type="password" value="${esc(s.proxyKey)}">
                    <div class="qig-provider-ready">
                        <div>
                            <strong>New-API Chat Image mode</strong>
                            <small>Simple path for providers that generate images through chat/completions. Uses the latest chat message text and attached images.</small>
                        </div>
                        <label class="checkbox_label qig-inline-checkbox">
                            <input id="qig-proxy-chat-mode" type="checkbox" ${s.proxyChatImageMode ? "checked" : ""}>
                            <span>Enable</span>
                        </label>
                    </div>
                    <div id="qig-proxy-chat-image-panel" class="qig-dependent-panel" style="display:${s.proxyChatImageMode ? "block" : "none"}">
                        <div class="qig-action-strip">
                            <button id="qig-proxy-chat-setup" class="menu_button qig-inline-action" title="Apply the recommended New-API chat image defaults"><span class="fa-solid fa-bolt"></span><span>Apply Chat Image Defaults</span></button>
                        </div>
                        <label>Personality / System Prompt</label>
                        <textarea id="qig-proxy-chat-system" rows="3" placeholder="Tell the image model how to behave in chat-image mode.">${esc(s.proxyChatImageSystemPrompt || DEFAULT_PROXY_CHAT_IMAGE_SYSTEM_PROMPT)}</textarea>
                        <label class="checkbox_label qig-switch-row">
                            <input id="qig-proxy-chat-personality" type="checkbox" ${s.proxyChatImageIncludePersonality ? "checked" : ""}>
                            <span>Append active chat character and persona context</span>
                        </label>
                        <small class="qig-muted">Keep this off for predictable provider calls. Turn it on when the image model should preserve the current character card and persona details.</small>
                        <div class="qig-row">
                            <div>
                                <label>Max Tokens</label>
                                <input id="qig-proxy-chat-max-tokens" type="number" value="${esc(getProxyChatMaxTokens(s))}" min="1" max="65536" step="256">
                                <small>Defaults to 16k so chat-image providers can return verbose image payloads.</small>
                            </div>
                            <label class="checkbox_label qig-switch-row">
                                <input id="qig-proxy-chat-allow-images" type="checkbox" ${s.proxyChatImageAllowImagesEndpoint ? "checked" : ""}>
                                <span>Permit /images/generations routing</span>
                            </label>
                        </div>
                        <div id="qig-proxy-chat-route-status" class="form-hint" style="margin-top:4px;"></div>
                    </div>
                    <label class="checkbox_label">
                        <input id="qig-proxy-comfy-mode" type="checkbox" ${s.proxyComfyMode ? "checked" : ""}>
                        <span>ComfyUI Proxy Mode</span>
                    </label>
                    <div id="qig-proxy-comfy-opts" style="display:${s.proxyComfyMode ? "block" : "none"}">
                        <small style="opacity:0.6;font-size:10px;">Connects to a ComfyUI proxy server (GET /prompt/{text}?token=key → PNG). URL and API Key above are reused as the proxy address and token.</small>
                        <label>Timeout (seconds)</label>
                        <input id="qig-proxy-comfy-timeout" type="number" value="${esc(s.proxyComfyTimeout || 300)}" min="10" max="600">
                        <label>Prompt Node ID (optional)</label>
                        <input id="qig-proxy-comfy-node-id" type="text" value="${esc(s.proxyComfyNodeId || "")}" placeholder="e.g. 972">
                        <small style="opacity:0.6;font-size:10px;">Sent as query param if your proxy supports it</small>
                        <label>Workflow JSON (optional)</label>
                        <textarea id="qig-proxy-comfy-workflow" rows="3" placeholder="Paste workflow_api.json or leave empty to use server default">${esc(s.proxyComfyWorkflow || "")}</textarea>
                    </div>
                    <div id="qig-proxy-standard-opts" style="display:${s.proxyComfyMode ? "none" : "block"}">
                    <label>Model</label>
                    <input id="qig-proxy-model" type="text" value="${esc(s.proxyModel)}" placeholder="PixAI model ID">
                    <label>Request Timeout (seconds)</label>
                    <input id="qig-proxy-timeout" type="number" value="${esc(s.proxyTimeout || 600)}" min="30" max="1800">
                    <small style="opacity:0.6;font-size:10px;">Some image proxies keep long jobs open. Use 600 for Link-style slow image generations.</small>
                    <div class="qig-row">
                        <div><label>Endpoint Mode</label>
                            <select id="qig-proxy-endpoint-mode">
                                <option value="auto" ${s.proxyEndpointMode === "auto" ? "selected" : ""}>Auto</option>
                                <option value="chat_completions" ${s.proxyEndpointMode === "chat_completions" ? "selected" : ""}>Chat Completions</option>
                                <option value="images_generations" ${s.proxyEndpointMode === "images_generations" ? "selected" : ""}>Images Generations</option>
                            </select>
                        </div>
                        <div><label>Payload Mode</label>
                            <select id="qig-proxy-payload-mode">
                                <option value="extended" ${s.proxyPayloadMode === "extended" ? "selected" : ""}>Extended</option>
                                <option value="openai_strict" ${s.proxyPayloadMode === "openai_strict" ? "selected" : ""}>OpenAI Strict</option>
                            </select>
                        </div>
                        <div><label>SSE</label>
                            <select id="qig-proxy-sse-mode">
                                <option value="auto" ${s.proxySse === "auto" ? "selected" : ""}>Auto</option>
                                <option value="on" ${s.proxySse === "on" ? "selected" : ""}>Force On</option>
                                <option value="off" ${s.proxySse === "off" ? "selected" : ""}>Force Off</option>
                            </select>
                        </div>
                    </div>
                    <label>Reference Image Mode</label>
                    <select id="qig-proxy-ref-mode">
                        <option value="auto" ${s.proxyRefImageMode === "auto" ? "selected" : ""}>Auto</option>
                        <option value="url_only" ${s.proxyRefImageMode === "url_only" ? "selected" : ""}>Public URLs Only</option>
                        <option value="inline_or_url" ${s.proxyRefImageMode === "inline_or_url" ? "selected" : ""}>Inline Or URL</option>
                    </select>
                    <div id="qig-proxy-compat-hint" class="form-hint" style="margin-top:4px;"></div>
                    <label>LoRAs (id:weight, comma-separated)</label>
                    <small style="opacity:0.6;font-size:10px;">Always applied. For scene-specific LoRAs, use Contextual Filters.</small>
                    <input id="qig-proxy-loras" type="text" value="${esc(s.proxyLoras || "")}" placeholder="123456:0.8, 789012:0.6">
                    <div class="qig-row">
                        <div><label>Steps</label><input id="qig-proxy-steps" type="number" value="${esc(s.proxySteps || 25)}" min="8" max="50"></div>
                        <div><label>CFG</label><input id="qig-proxy-cfg" type="number" value="${esc(s.proxyCfg || 6)}" min="1" max="15" step="0.5"></div>
                        <div><label>Seed</label><input id="qig-proxy-seed" type="number" value="${esc(s.proxySeed ?? -1)}"></div>
                    </div>
                    <label>Sampler</label>
                    <select id="qig-proxy-sampler">
                        <option value="Euler a" ${s.proxySampler === "Euler a" ? "selected" : ""}>Euler a</option>
                        <option value="Euler" ${s.proxySampler === "Euler" ? "selected" : ""}>Euler</option>
                        <option value="DPM++ 2M Karras" ${s.proxySampler === "DPM++ 2M Karras" ? "selected" : ""}>DPM++ 2M Karras</option>
                        <option value="DPM++ SDE Karras" ${s.proxySampler === "DPM++ SDE Karras" ? "selected" : ""}>DPM++ SDE Karras</option>
                        <option value="DPM++ 2M SDE Karras" ${s.proxySampler === "DPM++ 2M SDE Karras" ? "selected" : ""}>DPM++ 2M SDE Karras</option>
                        <option value="DDIM" ${s.proxySampler === "DDIM" ? "selected" : ""}>DDIM</option>
                    </select>
                    <label class="checkbox_label">
                        <input id="qig-proxy-facefix" type="checkbox" ${s.proxyFacefix ? "checked" : ""}>
                        <span>Enable Face Fix (PixAI ADetailer)</span>
                    </label>
                    <label>Extra Instructions</label>
                    <textarea id="qig-proxy-extra" rows="2" placeholder="Additional instructions for the image model...">${esc(s.proxyExtraInstructions || "")}</textarea>
                    <label>Reference Images (up to 15)</label>
                    <div id="qig-proxy-refs" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;"></div>
                    <input type="file" id="qig-proxy-ref-input" accept="image/*" multiple style="display:none">
                    <div style="display:flex;gap:4px;align-items:center;">
                        <button id="qig-proxy-ref-btn" class="menu_button" style="padding:4px 8px;">📎 Files</button>
                        <input id="qig-proxy-ref-url" type="text" placeholder="Paste image URL and press Enter" style="flex:1;font-size:11px;">
                    </div>
                    </div>
                </div>
                        </div>
                    </div>
                </section>

                <section class="qig-menu-section qig-menu-section--prompt" aria-labelledby="qig-prompt-heading">
                    <div class="qig-section-header">
                        <div>
                            <span id="qig-prompt-heading" class="qig-section-kicker">Prompt</span>
                            <p>Write the base idea, save repeatable presets, and decide how chat context is converted.</p>
                        </div>
                    </div>
                    <div class="qig-field">
                        <label for="qig-prompt">Prompt</label>
                        <textarea id="qig-prompt" rows="4" aria-describedby="qig-prompt-help">${esc(s.prompt)}</textarea>
                        <small id="qig-prompt-help">Used for manual generation, or as scene context when LLM prompt is enabled.</small>
                    </div>
                    <div class="qig-action-strip">
                        <button id="qig-chatgpt-nbp-setup" class="menu_button qig-inline-action" title="Set QIG for ChatGPT prompt writing and Nano Banana Pro image rendering"><span class="fa-solid fa-wand-magic-sparkles"></span><span>ChatGPT + NBP</span></button>
                        <button id="qig-plain-desc-btn" class="menu_button" title="Write a plain-language image description and let the AI turn it into a prompt"><span class="fa-solid fa-pen-to-square"></span><span>Plain Description</span></button>
                        <button id="qig-save-preset" class="menu_button" title="Save all generation settings as a preset"><span class="fa-solid fa-bookmark"></span><span>Save Preset</span></button>
                        <button id="qig-export-btn" class="menu_button"><span class="fa-solid fa-file-export"></span><span>Export</span></button>
                        <button id="qig-import-btn" class="menu_button"><span class="fa-solid fa-file-import"></span><span>Import</span></button>
                    </div>
                    <div id="qig-presets" class="qig-presets"></div>
                    <small class="qig-muted">Profiles save provider config. Presets save generation and inject settings. Contextual filters stay managed separately.</small>

                    <button id="qig-prompt-advanced-toggle" type="button" class="qig-collapsible__header qig-inline-collapsible" aria-expanded="${promptAdvancedExpanded}" aria-controls="qig-prompt-advanced-content">
                        <span>
                            <span class="qig-card-title">Advanced Prompt Options</span>
                            <small>Negative prompt, quality tags, chat-message selection, and LLM rewrite controls.</small>
                        </span>
                        <span class="qig-collapsible__icon fa-solid ${collapsed.promptAdvanced ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></span>
                    </button>
                    <div id="qig-prompt-advanced-content" class="qig-collapsible__content" ${promptAdvancedHidden}>
                    <div class="qig-control-grid qig-control-grid--stack">
                        <div class="qig-field">
                            <label>Negative Prompt</label>
                            <textarea id="qig-negative" rows="2">${esc(s.negativePrompt)}</textarea>
                            <small>Things to avoid in the image, for example bad hands, blur, watermarks.</small>
                        </div>
                        <div class="qig-field">
                            <label>Quality Tags</label>
                            <textarea id="qig-quality" rows="2">${esc(s.qualityTags)}</textarea>
                            <small>Tags prepended to every prompt to improve output quality.</small>
                        </div>
                    </div>
                    <label class="checkbox_label qig-switch-row">
                        <input id="qig-append-quality" type="checkbox" ${s.appendQuality ? "checked" : ""}>
                        <span>Prepend quality tags to prompt</span>
                    </label>

                    <div class="qig-subsection">
                        <label class="checkbox_label qig-switch-row">
                            <input id="qig-use-last" type="checkbox" ${s.useLastMessage ? "checked" : ""}>
                            <span>Use chat message as prompt</span>
                        </label>
                        <small class="qig-muted">Feeds the selected chat message to the image generator as scene context.</small>
                        <div id="qig-msg-index-wrap" class="qig-dependent-panel" style="display:${s.useLastMessage ? "block" : "none"}">
                            <label>Message selection</label>
                            <input id="qig-msg-range" type="text" value="${esc(s.messageRange)}" placeholder="-1"
                                   title="-1 (last), 5 (single), 3-7 (range), 3,5,7 (specific), last5 (last N)">
                            <small>-1 = last | 3-7 = range | 3,5,7 = pick | last5 = last N</small>
                            <label class="checkbox_label qig-switch-row">
                                <input id="qig-paragraph-picker" type="checkbox" ${s.enableParagraphPicker ? "checked" : ""}>
                                <span>Show paragraph picker before generation</span>
                            </label>
                        </div>
                    </div>

                    <div class="qig-subsection">
                        <label class="checkbox_label qig-switch-row">
                            <input id="qig-use-llm" type="checkbox" ${s.useLLMPrompt ? "checked" : ""}>
                            <span>Use LLM to create image prompt</span>
                        </label>
                        <small class="qig-muted">Sends the scene to your AI to write an optimized image prompt.</small>
                        <div id="qig-llm-options" class="qig-dependent-panel" style="display:${s.useLLMPrompt ? "block" : "none"};">
                            <label>Prompt Style</label>
                            <select id="qig-llm-style">
                                <option value="tags" ${s.llmPromptStyle === "tags" ? "selected" : ""}>Danbooru Tags (anime)</option>
                                <option value="natural" ${s.llmPromptStyle === "natural" ? "selected" : ""}>Natural Description (realistic)</option>
                                <option value="custom" ${s.llmPromptStyle === "custom" ? "selected" : ""}>Custom Instruction</option>
                            </select>
                            <small>How the AI formats the image prompt.</small>
                            <div class="qig-toggle-list">
                                <label class="checkbox_label qig-switch-row">
                                    <input id="qig-llm-edit" type="checkbox" ${s.llmEditPrompt ? "checked" : ""}>
                                    <span>Edit LLM prompt before generation</span>
                                </label>
                                <label class="checkbox_label qig-switch-row">
                                    <input id="qig-llm-quality" type="checkbox" ${s.llmAddQuality ? "checked" : ""}>
                                    <span>Add enhanced quality tags</span>
                                </label>
                                <label class="checkbox_label qig-switch-row">
                                    <input id="qig-llm-lighting" type="checkbox" ${s.llmAddLighting ? "checked" : ""}>
                                    <span>Add lighting tags</span>
                                </label>
                                <label class="checkbox_label qig-switch-row">
                                    <input id="qig-llm-artist" type="checkbox" ${s.llmAddArtist ? "checked" : ""}>
                                    <span>Add random artist tags</span>
                                </label>
                            </div>
                            <label>Prefill</label>
                            <input id="qig-llm-prefill" type="text" value="${esc(s.llmPrefill || '')}" placeholder="e.g., Image prompt:">
                            <small>Pre-fills the start of the AI response to guide its output format.</small>
                            <div id="qig-llm-custom-wrap" style="display:${s.llmPromptStyle === "custom" ? "block" : "none"};margin-top:8px;">
                                <label>Custom LLM Instruction</label>
                                <textarea id="qig-llm-custom" style="width:100%;height:120px;resize:vertical;" placeholder="Write your custom instruction for the LLM. Use {{scene}} for the current scene text.">${esc(s.llmCustomInstruction || "")}</textarea>
                            </div>
                        </div>
                    </div>
                    </div>
                </section>

                <section class="qig-menu-section" aria-labelledby="qig-context-heading">
                    <div class="qig-section-header">
                        <div>
                            <span id="qig-context-heading" class="qig-section-kicker">Context</span>
                            <p>Apply SillyTavern style data and manage conditional prompt rules.</p>
                        </div>
                    </div>
                    <label class="checkbox_label qig-switch-row">
                        <input id="qig-use-st-style" type="checkbox" ${s.useSTStyle !== false ? "checked" : ""}>
                        <span>Use SillyTavern's Style panel</span>
                    </label>
                    <small class="qig-muted">Applies its prefix, negative prompt, and character-specific settings.</small>
                    <div class="qig-filter-panel">
                        <div class="qig-card-title">Contextual Filters</div>
                        <small class="qig-muted">Open the manager to organize pools, character-scoped filters, and per-filter seed overrides.</small>
                        <div id="qig-contextual-filters"></div>
                    </div>
                </section>

                <section class="qig-menu-section" aria-labelledby="qig-automation-heading">
                    <div class="qig-section-header">
                        <div>
                            <span id="qig-automation-heading" class="qig-section-kicker">Automation</span>
                            <p>Control when images generate and how finished images land in chat.</p>
                        </div>
                    </div>
                    <div class="qig-subsection">
                    <label class="checkbox_label" style="margin-top:6px;">
                        <input id="qig-auto-generate" type="checkbox" ${s.autoGenerate ? "checked" : ""}>
                        <span>Auto-generate after AI response</span>
                    </label>
                    <div class="qig-control-grid" style="margin:6px 0 8px;">
                        <div class="qig-field">
                            <label>Every AI replies</label>
                            <input id="qig-auto-generate-every" type="number" value="${esc(normalizeAutoGenerateEveryMessages(s.autoGenerateEveryMessages))}" min="${AUTO_GENERATE_EVERY_MIN}" max="${AUTO_GENERATE_EVERY_MAX}" step="1">
                        </div>
                        <div class="qig-field">
                            <label>Delay (ms)</label>
                            <input id="qig-auto-generate-delay" type="number" value="${esc(normalizeAutoGenerateDelayMs(s.autoGenerateDelayMs))}" min="${AUTO_GENERATE_DELAY_MIN}" max="${AUTO_GENERATE_DELAY_MAX}" step="100">
                        </div>
                    </div>
                    <small class="qig-muted">1 keeps current behavior; 3 means every third eligible AI reply. Delay applies to normal and inject auto-generation.</small>
                    <label class="checkbox_label" style="margin-top:8px;">
                        <input id="qig-two-step-prompt" type="checkbox" ${s.twoStepPrompt ? "checked" : ""}>
                        <span>Use two-step prompt pipeline for chat scenes</span>
                    </label>
                    <div id="qig-two-step-options" class="qig-dependent-panel" style="display:${s.twoStepPrompt ? "block" : "none"};margin-top:6px;">
                        <small style="opacity:0.6;font-size:10px;">For chat-based direct generation, QIG first asks Text AI for a plain visual scene description, then converts that description through the selected LLM prompt style.</small>
                        <label>Scene description instruction (optional)</label>
                        <textarea id="qig-two-step-instruction" rows="3" style="width:100%;resize:vertical;" placeholder="Leave empty for the default visual summary instruction">${esc(s.twoStepInstruction || "")}</textarea>
                        <small style="opacity:0.6;font-size:10px;">Supports {{scene}}, {{char}}, {{user}}, {{charDesc}}, and {{userDesc}}.</small>
                    </div>
                    <label class="checkbox_label" style="margin-top:8px;">
                        <input id="qig-auto-background" type="checkbox" ${s.autoSetBackground ? "checked" : ""}>
                        <span>Auto-set generated image as chat background</span>
                    </label>
                    <div class="qig-control-grid" style="margin:6px 0 8px;">
                        <div class="qig-field" style="opacity:${s.autoSetBackground ? "1" : "0.6"};">
                            <label>Background mode</label>
                            <select id="qig-background-mode" ${s.autoSetBackground ? "" : "disabled"}>
                                <option value="temporary" ${normalizeBackgroundMode(s.backgroundMode) === "temporary" ? "selected" : ""}>Temporary</option>
                                <option value="locked" ${normalizeBackgroundMode(s.backgroundMode) === "locked" ? "selected" : ""}>Locked to chat</option>
                            </select>
                            <small>Temporary applies until the background changes, reloads, or the chat switches. Locked stores it in this chat metadata.</small>
                        </div>
                    </div>
                    <label class="checkbox_label">
                        <input id="qig-confirm-generate" type="checkbox" ${s.confirmBeforeGenerate ? "checked" : ""}>
                        <span>Confirm before generating</span>
                    </label>
                    <label class="checkbox_label" style="margin-top:8px;">
                        <input id="qig-inject-enabled" type="checkbox" ${s.injectEnabled ? "checked" : ""}>
                        <span>Use AI-written image tags for auto-generation</span>
                    </label>
                    <button id="qig-inject-options-toggle" type="button" class="qig-collapsible__header qig-inline-collapsible qig-inline-collapsible--nested" aria-expanded="${injectOptionsExpanded}" aria-controls="qig-inject-options">
                        <span>
                            <span class="qig-card-title">Inject Configuration</span>
                            <small>Tag format, extraction regex, insertion mode, and detection test.</small>
                        </span>
                        <span class="qig-collapsible__icon fa-solid ${injectOptionsCollapsed ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></span>
                    </button>
                    <div id="qig-inject-options" class="qig-collapsible__content qig-dependent-panel" ${injectOptionsHidden}>
                        <small style="opacity:0.6;font-size:10px;">Active only when Auto-generate is enabled. QIG injects instructions into chat completions, extracts image tags from AI replies, and turns them into images.</small>
                        <label>Tag name</label>
                        <input id="qig-inject-tag-name" type="text" value="${esc(getInjectTagName(s))}" placeholder="image" style="width:100%;text-transform:lowercase;">
                        <small style="opacity:0.6;font-size:10px;">Preview: <code id="qig-inject-tag-preview">${esc(getInjectTagPreview(getInjectTagName(s)))}</code>. Change this if your preset/model tends to swallow &lt;image&gt; tags inside reasoning.</small>
                        <label>Inject prompt template</label>
                        <textarea id="qig-inject-prompt" rows="3" style="width:100%;resize:vertical;">${esc(s.injectPrompt || "")}</textarea>
                        <small style="opacity:0.6;font-size:10px;">Supports {{char}}, {{user}}. Default prompt tells the AI to put the image tag in the final visible reply, not inside reasoning or &lt;think&gt;.</small>
                        <label>Extraction regex</label>
                        <input id="qig-inject-regex" type="text" value="${esc(s.injectRegex || '')}" style="width:100%;font-family:monospace;font-size:11px;">
                        <small style="opacity:0.6;font-size:10px;">Capture groups extract the image prompt. Default matches your custom paired tag plus legacy &lt;pic prompt="..."&gt; tags.</small>
                        <label>Injection position</label>
                        <select id="qig-inject-position">
                            <option value="afterScenario" ${s.injectPosition === "afterScenario" ? "selected" : ""}>After Scenario</option>
                            <option value="inUser" ${s.injectPosition === "inUser" ? "selected" : ""}>Before User Message</option>
                            <option value="atDepth" ${s.injectPosition === "atDepth" ? "selected" : ""}>At Depth</option>
                        </select>
                        <small style="opacity:0.6;font-size:10px;">Before User Message may interfere with thinking/reasoning presets.</small>
                        <div id="qig-inject-depth-wrap" style="display:${s.injectPosition === "atDepth" ? "block" : "none"};">
                            <label>Depth</label>
                            <input id="qig-inject-depth" type="number" value="${esc(s.injectDepth || 0)}" min="0" max="100">
                        </div>
                        <label>Tag handling</label>
                        <select id="qig-inject-insert-mode">
                            <option value="replace" ${s.injectInsertMode === "replace" ? "selected" : ""}>Replace tag with image</option>
                            <option value="inline" ${s.injectInsertMode === "inline" ? "selected" : ""}>Insert image after message</option>
                            <option value="new" ${s.injectInsertMode === "new" ? "selected" : ""}>New message with image</option>
                        </select>
                        <label class="checkbox_label">
                            <input id="qig-inject-autoclean" type="checkbox" ${s.injectAutoClean !== false ? "checked" : ""}>
                            <span>Remove detected image tags from the stored/displayed message</span>
                        </label>
                        <button id="qig-test-inject" class="menu_button qig-inline-action" style="margin-top:8px;">🔍 Test Inject Detection</button>
                    </div>
                    </div>

                <label class="checkbox_label" style="margin-top:4px;">
                    <input id="qig-disable-palette" type="checkbox" ${s.disablePaletteButton ? "checked" : ""}>
                    <span>Hide palette button</span>
                </label>
                <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
                    <label style="font-size:12px;white-space:nowrap;">Palette button mode</label>
                    <select id="qig-palette-mode" style="flex:1;">
                        <option value="direct" ${normalizePaletteMode(s.paletteMode) === "direct" ? "selected" : ""}>Direct (selected scene/manual prompt)</option>
                        <option value="inject" ${normalizePaletteMode(s.paletteMode) === "inject" ? "selected" : ""}>Inject (image tags)</option>
                    </select>
                </div>
                <small style="opacity:0.6;font-size:10px;">Direct uses the selected scene settings. Inject extracts image tags from the latest tagged AI message, or asks the LLM for one tag from the selected scene.</small>

                <div class="qig-dependent-panel">
                    <label class="checkbox_label">
                        <input id="qig-llm-override" type="checkbox" ${s.llmOverrideEnabled ? "checked" : ""}>
                        <span>Use separate AI for image prompts</span>
                    </label>
                    <small style="opacity:0.6;font-size:10px;">Route image prompt generation to a different AI model than your main chat</small>
                    <div id="qig-llm-override-options" style="display:${s.llmOverrideEnabled ? 'block' : 'none'};margin-top:6px;">
                        <label style="font-size:11px;">Connection Profile</label>
                        <select id="qig-llm-override-profile" style="width:100%;"></select>
                        <label style="font-size:11px;margin-top:4px;">Completion Preset (optional)</label>
                        <select id="qig-llm-override-preset-select" style="width:100%;"></select>
                        <label style="font-size:11px;margin-top:4px;">Max Tokens</label>
                        <input id="qig-llm-override-max" type="number" value="${esc(s.llmOverrideMaxTokens || 500)}" min="50" max="4096" style="width:100%;">
                    </div>
                </div>
                </section>

                <section class="qig-menu-section" aria-labelledby="qig-output-heading">
                    <div class="qig-section-header">
                        <div>
                            <span id="qig-output-heading" class="qig-section-kicker">Output</span>
                            <p>Set insertion behavior, saved file handling, image size, and repeat count.</p>
                        </div>
                    </div>
                <label class="checkbox_label">
                    <input id="qig-auto-insert" type="checkbox" ${s.autoInsert ? "checked" : ""}>
                    <span>Auto-insert into chat (skip popup)</span>
                </label>
                <div class="qig-control-grid">
                    <div class="qig-field">
                        <label>Chat insert output</label>
                        <select id="qig-output-mode">
                            <option value="inline" ${normalizeOutputMode(s.outputMode) === "inline" ? "selected" : ""}>Inline data URL</option>
                            <option value="image_url" ${normalizeOutputMode(s.outputMode) === "image_url" ? "selected" : ""}>image_url (URL)</option>
                        </select>
                        <small>Use image_url for URL-based chat media. Inline data can be saved to the ST server automatically.</small>
                    </div>
                    <div class="qig-field">
                        <label>Manual insert target</label>
                        <select id="qig-manual-insert-target">
                            <option value="assistant" ${normalizeManualInsertTarget(s.manualInsertTarget) === "assistant" ? "selected" : ""}>Latest AI / non-user message</option>
                            <option value="user" ${normalizeManualInsertTarget(s.manualInsertTarget) === "user" ? "selected" : ""}>Latest user message</option>
                            <option value="latest" ${normalizeManualInsertTarget(s.manualInsertTarget) === "latest" ? "selected" : ""}>Latest chat message</option>
                        </select>
                        <small>Used when inserting without a specific target message.</small>
                    </div>
                </div>
                <label class="checkbox_label" style="margin-left:16px;opacity:${s.autoInsert ? "1" : "0.6"};">
                    <input id="qig-insert-hidden-reply" type="checkbox" ${s.insertAsHiddenReply ? "checked" : ""} ${s.autoInsert ? "" : "disabled"}>
                    <span>Send as hidden reply (prevents payload errors)</span>
                </label>
                <label class="checkbox_label" style="margin-top:4px;">
                    <input id="qig-save-to-server" type="checkbox" ${s.saveToServer ? "checked" : ""}>
                    <span>Save images to ST server (persistent)</span>
                </label>
                <label class="checkbox_label" style="margin-left:16px;opacity:${s.saveToServer ? "1" : "0.6"};">
                    <input id="qig-save-to-server-meta" type="checkbox" ${s.saveToServerEmbedMetadata ? "checked" : ""} ${s.saveToServer ? "" : "disabled"}>
                    <span>Embed metadata in saved PNGs</span>
                </label>

                <div class="qig-control-grid">
                    <div class="qig-field qig-field--full">
                        <label>Size</label>
                        <small>Output resolution in pixels. Larger images are slower and use more VRAM.</small>
                        <div id="qig-size-custom" class="qig-row qig-size-row">
                            <input id="qig-width" type="number" value="${esc(s.width)}" min="256" max="2048" step="64">
                            <span>×</span>
                            <input id="qig-height" type="number" value="${esc(s.height)}" min="256" max="2048" step="64">
                            <select id="qig-aspect" style="width:70px;margin-left:4px">
                                <option value="">-</option>
                                <option value="1:1">1:1</option>
                                <option value="3:2">3:2</option>
                                <option value="2:3">2:3</option>
                                <option value="16:9">16:9</option>
                                <option value="9:16">9:16</option>
                            </select>
                        </div>
                        <select id="qig-nai-resolution" style="display:none;width:100%">
                            ${NAI_RESOLUTIONS.map(r => `<option value="${r.w}x${r.h}" ${selectedNaiResolution === `${r.w}x${r.h}` ? "selected" : ""}>${r.label}</option>`).join("")}
                            <option value="${NAI_CUSTOM_RESOLUTION_VALUE}" ${selectedNaiResolution === NAI_CUSTOM_RESOLUTION_VALUE ? "selected" : ""}>Custom (${esc(s.width)}×${esc(s.height)})</option>
                        </select>
                    </div>
                    <div class="qig-field">
                        <label>Batch Count</label>
                        <input id="qig-batch" type="number" value="${esc(s.batchCount)}" min="1" max="10">
                        <small>Number of images to generate per click.</small>
                    </div>
                </div>
                <label class="checkbox_label" id="qig-seq-seeds-wrap" style="display:${(s.batchCount || 1) > 1 ? '' : 'none'}">
                    <input id="qig-seq-seeds" type="checkbox" ${s.sequentialSeeds ? "checked" : ""}>
                    <span>Sequential seeds (seed, seed+1, seed+2...)</span>
                </label>
                
                <div class="qig-collapsible qig-advanced-settings-shell">
                    <button id="qig-advanced-settings-toggle" type="button" class="qig-collapsible__header" aria-expanded="${advancedSettingsExpanded}" aria-controls="qig-advanced-settings">
                        <span>
                            <span class="qig-card-title">Advanced Settings</span>
                            <small>Sampler, steps, CFG scale, and seed controls.</small>
                        </span>
                        <span class="qig-collapsible__icon fa-solid ${collapsed.advancedSettings ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></span>
                    </button>
                    <div class="qig-collapsible__content" id="qig-advanced-settings" ${advancedSettingsHidden}>
                    <label>Steps</label>
                    <small style="opacity:0.6;font-size:10px;">More steps = higher quality but slower (20-30 is typical)</small>
                    <input id="qig-steps" type="number" value="${esc(s.steps)}" min="1" max="150">
                    <label>CFG Scale</label>
                    <small style="opacity:0.6;font-size:10px;">How strictly the image follows the prompt — higher = more literal (5-10 typical)</small>
                    <input id="qig-cfg" type="number" value="${esc(s.cfgScale)}" min="1" max="30" step="0.5">
                    <label>Sampler</label>
                    <small style="opacity:0.6;font-size:10px;">Algorithm used to generate the image — euler_a is a good default</small>
                    <select id="qig-sampler">${samplerOpts}</select>
                    <label>Seed (-1 = random)</label>
                    <small style="opacity:0.6;font-size:10px;">Same seed + same prompt = same image. -1 for random each time</small>
                    <input id="qig-seed" type="number" value="${esc(s.seed)}">
                    </div>
                </div>
                </section>
            </div>
        </div>
    </div>`;

    document.getElementById("extensions_settings").insertAdjacentHTML("beforeend", html);

    document.getElementById("qig-generate-btn").onclick = () => runConfiguredPaletteGeneration();
    document.getElementById("qig-logs-btn").onclick = showLogs;
    document.getElementById("qig-save-char-btn").onclick = saveCharSettings;
    document.getElementById("qig-gallery-settings-btn").onclick = showGallery;
    document.getElementById("qig-prompt-history-btn").onclick = showPromptHistory;
    document.getElementById("qig-chatgpt-nbp-setup").onclick = () => {
        applyChatGptNbpWorkflowPreset();
        createUI();
        const promptSection = document.getElementById("qig-prompt");
        promptSection?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    };
    document.getElementById("qig-plain-desc-btn").onclick = generateImageFromPlainDescription;
    document.getElementById("qig-profile-save").onclick = saveConnectionProfile;
    document.getElementById("qig-save-preset").onclick = savePreset;
    document.getElementById("qig-export-btn").onclick = exportAllSettings;
    document.getElementById("qig-import-btn").onclick = importSettings;
    setupQigCollapsibleSection("providerSettings", "qig-provider-settings-toggle", "qig-provider-settings-content");
    setupQigCollapsibleSection("promptAdvanced", "qig-prompt-advanced-toggle", "qig-prompt-advanced-content");
    setupQigCollapsibleSection("injectOptions", "qig-inject-options-toggle", "qig-inject-options");
    setupQigCollapsibleSection("advancedSettings", "qig-advanced-settings-toggle", "qig-advanced-settings");
    bindQigKeyboardShortcuts();
    renderPresets();
    renderProfileSelect();
    renderComfyWorkflowPresets();
    renderContextualFilters();

    document.getElementById("qig-provider").onchange = (e) => {
        getSettings().provider = e.target.value;
        saveSettingsDebounced();
        updateProviderUI();
        renderProfileSelect();
    };
    document.getElementById("qig-style").onchange = (e) => {
        getSettings().style = e.target.value;
        saveSettingsDebounced();
    };

    bind("qig-pollinations-key", "pollinationsKey");
    bind("qig-pollinations-model", "pollinationsModel");
    bind("qig-nai-key", "naiKey");
    bind("qig-nai-model", "naiModel");
    bind("qig-nai-proxy-url", "naiProxyUrl");
    bind("qig-nai-proxy-key", "naiProxyKey");
    bind("qig-gpt-image-key", "gptImageKey");
    bind("qig-gpt-image-model", "gptImageModel");
    bind("qig-gpt-image-proxy-url", "gptImageProxyUrl");
    bind("qig-gpt-image-proxy-key", "gptImageProxyKey");
    bind("qig-gpt-image-quality", "gptImageQuality");
    bind("qig-gpt-image-format", "gptImageFormat");
    bind("qig-gpt-image-background", "gptImageBackground");
    bind("qig-gpt-image-moderation", "gptImageModeration");
    bind("qig-arli-key", "arliKey");
    bind("qig-arli-model", "arliModel");
    bind("qig-routeway-key", "routewayKey");
    bind("qig-routeway-model", "routewayModel");
    bind("qig-navy-key", "navyKey");
    bind("qig-navy-model", "navyModel");
    bind("qig-nanogpt-key", "nanogptKey");
    bind("qig-nanogpt-model", "nanogptModel");
    bind("qig-nanogpt-strength", "nanogptStrength", true);
    bind("qig-chutes-key", "chutesKey");
    bind("qig-chutes-model", "chutesModel");
    bind("qig-civitai-key", "civitaiKey");
    bind("qig-civitai-model", "civitaiModel");
    bind("qig-civitai-scheduler", "civitaiScheduler");
    bind("qig-civitai-loras", "civitaiLoras");
    bind("qig-nanobanana-key", "nanobananaKey");
    bind("qig-nanobanana-model", "nanobananaModel");
    document.getElementById("qig-nanobanana-nbp-mode").onchange = (e) => {
        const enabled = e.target.checked;
        getSettings().nanobananaNbpMode = enabled;
        const opts = document.getElementById("qig-nanobanana-nbp-options");
        if (opts) opts.style.display = enabled ? "block" : "none";
        saveSettingsDebounced();
    };
    const nbpPresetEl = document.getElementById("qig-nanobanana-nbp-preset");
    nbpPresetEl.onchange = (e) => {
        getSettings().nanobananaNbpPreset = normalizeNbpDirectorPreset(e.target.value);
        const customWrap = document.getElementById("qig-nanobanana-custom-director-wrap");
        if (customWrap) customWrap.style.display = getSettings().nanobananaNbpPreset === "custom" ? "block" : "none";
        saveSettingsDebounced();
    };
    bindCheckbox("qig-nanobanana-nbp-negative", "nanobananaNbpUseNegative");
    bind("qig-nanobanana-nbp-custom-director", "nanobananaNbpCustomDirector");
    bind("qig-nanobanana-nbp-custom", "nanobananaNbpCustomPrompt");
    bind("qig-nanobanana-extra", "nanobananaExtraInstructions");
    bind("qig-stability-key", "stabilityKey");
    bind("qig-replicate-key", "replicateKey");
    bind("qig-replicate-model", "replicateModel");
    bind("qig-fal-key", "falKey");
    bind("qig-fal-model", "falModel");
    bind("qig-together-key", "togetherKey");
    bind("qig-together-model", "togetherModel");
    bind("qig-zai-key", "zaiKey");
    bind("qig-zai-model", "zaiModel");
    bind("qig-zai-quality", "zaiQuality");
    bind("qig-local-url", "localUrl");
    bind("qig-local-model", "localModel");
    document.getElementById("qig-local-model").addEventListener("change", (e) => {
        const val = (e.target.value || "").toLowerCase();
        if (/flux|unet|\.gguf/.test(val) && !getSettings().comfySkipNegativePrompt) {
            toastr.warning(
                'This looks like a Flux/UNET model. Enable "Skip Negative Prompt" and set your CLIP/VAE model names for UNET-only models, or paste a custom workflow.',
                "Flux/UNET Model Detected",
                { timeOut: 8000 }
            );
        }
    });
    document.getElementById("qig-comfy-workflow-select").onchange = (e) => {
        selectedComfyWorkflowId = e.target.value || "";
        setComfyWorkflowActionState(!!selectedComfyWorkflowId);
    };
    document.getElementById("qig-comfy-workflow-load").onclick = loadSelectedComfyWorkflowPreset;
    document.getElementById("qig-comfy-workflow-save-as").onclick = saveComfyWorkflowPresetAs;
    document.getElementById("qig-comfy-workflow-update").onclick = updateSelectedComfyWorkflowPreset;
    document.getElementById("qig-comfy-workflow-del").onclick = deleteSelectedComfyWorkflowPreset;
    // ComfyUI model refresh
    document.getElementById("qig-comfy-model-refresh").onclick = async () => {
        const s = getSettings();
        const modelSelect = document.getElementById("qig-local-model");
        modelSelect.innerHTML = '<option value="">Loading...</option>';
        let models;
        try {
            models = await fetchComfyUIModels(s.localUrl, isComfyFluxMode(s));
        } catch (e) {
            if (e.message?.includes("403 Forbidden")) {
                modelSelect.innerHTML = '<option value="">-- 403 Forbidden (see error) --</option>';
                toastr?.error?.(e.message, "ComfyUI Connection Error", { timeOut: 0, extendedTimeOut: 0 });
                return;
            }
            models = [];
        }
        if (models.length > 0) {
            const cur = s.localModel || "";
            modelSelect.innerHTML = models.map(m =>
                `<option value="${m}" ${m === cur ? "selected" : ""}>${m}</option>`
            ).join("");
            if (!cur && models.length > 0) {
                s.localModel = models[0];
                modelSelect.value = models[0];
                saveSettingsDebounced();
            }
        } else {
            modelSelect.innerHTML = '<option value="">-- Failed to load (check if ComfyUI running) --</option>';
        }
    };
    document.getElementById("qig-local-type").onchange = (e) => {
        getSettings().localType = e.target.value;
        syncLocalTypeSections(e.target.value);
        saveSettingsDebounced();
    };
    bind("qig-local-denoise", "localDenoise", true);
    document.getElementById("qig-local-denoise").oninput = (e) => {
        document.getElementById("qig-local-denoise-val").textContent = e.target.value;
    };
    // ComfyUI specific bindings
    bind("qig-comfy-denoise", "comfyDenoise", true);
    bind("qig-comfy-clip", "comfyClipSkip", true);
    bind("qig-comfy-scheduler", "comfyScheduler");
    bind("qig-comfy-timeout", "comfyTimeout", true);
    bindCheckbox("qig-comfy-upscale", "comfyUpscale");
    bind("qig-comfy-upscale-model", "comfyUpscaleModel");
    document.getElementById("qig-comfy-upscale").onchange = (e) => {
        getSettings().comfyUpscale = e.target.checked;
        saveSettingsDebounced();
        document.getElementById("qig-comfy-upscale-opts").style.display = e.target.checked ? "block" : "none";
    };
    bind("qig-comfy-workflow", "comfyWorkflow");
    bind("qig-comfy-loras", "comfyLoras");
    document.getElementById("qig-comfy-skip-neg").onchange = (e) => {
        getSettings().comfySkipNegativePrompt = e.target.checked;
        saveSettingsDebounced();
        const fluxOpts = document.getElementById("qig-comfy-flux-opts");
        if (fluxOpts) fluxOpts.style.display = e.target.checked ? "block" : "none";
    };
    bind("qig-comfy-flux-clip1", "comfyFluxClipModel1");
    bind("qig-comfy-flux-clip2", "comfyFluxClipModel2");
    bind("qig-comfy-flux-vae", "comfyFluxVaeModel");
    bind("qig-comfy-flux-clip-type", "comfyFluxClipType");

    // A1111 specific bindings
    bind("qig-a1111-clip", "a1111ClipSkip", true);
    bind("qig-a1111-scheduler", "a1111Scheduler");
    bindCheckbox("qig-a1111-restore-faces", "a1111RestoreFaces");
    bindCheckbox("qig-a1111-tiling", "a1111Tiling");
    bind("qig-a1111-subseed", "a1111Subseed", true);
    bind("qig-a1111-subseed-strength", "a1111SubseedStrength", true);
    bind("qig-a1111-loras", "a1111Loras");
    bind("qig-a1111-vae", "a1111Vae");

    // Hires Fix bindings
    bindCheckbox("qig-a1111-hires", "a1111HiresFix");
    bind("qig-a1111-hires-upscaler", "a1111HiresUpscaler");
    bind("qig-a1111-hires-steps", "a1111HiresSteps", true);
    bind("qig-a1111-hires-sampler", "a1111HiresSampler");
    bind("qig-a1111-hires-scheduler", "a1111HiresScheduler");
    bind("qig-a1111-hires-prompt", "a1111HiresPrompt");
    bind("qig-a1111-hires-negative", "a1111HiresNegative");
    bind("qig-a1111-hires-resize-x", "a1111HiresResizeX", true);
    bind("qig-a1111-hires-resize-y", "a1111HiresResizeY", true);
    document.getElementById("qig-a1111-hires-scale").onchange = (e) => {
        getSettings().a1111HiresScale = parseFloat(e.target.value);
        saveSettingsDebounced();
    };
    document.getElementById("qig-a1111-hires-denoise").oninput = (e) => {
        document.getElementById("qig-a1111-hires-denoise-val").textContent = e.target.value;
    };
    document.getElementById("qig-a1111-hires-denoise").onchange = (e) => {
        getSettings().a1111HiresDenoise = parseFloat(e.target.value);
        saveSettingsDebounced();
    };
    document.getElementById("qig-a1111-hires").onchange = (e) => {
        getSettings().a1111HiresFix = e.target.checked;
        document.getElementById("qig-a1111-hires-opts").style.display = e.target.checked ? "block" : "none";
        saveSettingsDebounced();
    };

    // ADetailer bindings
    bind("qig-a1111-adetailer-model", "a1111AdetailerModel");
    bind("qig-a1111-ad-prompt", "a1111AdetailerPrompt");
    bind("qig-a1111-ad-negative", "a1111AdetailerNegative");
    bind("qig-a1111-ad-denoise", "a1111AdetailerDenoise", true);
    bind("qig-a1111-ad-confidence", "a1111AdetailerConfidence", true);
    bind("qig-a1111-ad-mask-blur", "a1111AdetailerMaskBlur", true);
    bind("qig-a1111-ad-dilate", "a1111AdetailerDilateErode", true);
    bindCheckbox("qig-a1111-ad-inpaint-only", "a1111AdetailerInpaintOnlyMasked");
    bind("qig-a1111-ad-inpaint-padding", "a1111AdetailerInpaintPadding", true);
    document.getElementById("qig-a1111-adetailer").onchange = (e) => {
        getSettings().a1111Adetailer = e.target.checked;
        saveSettingsDebounced();
        document.getElementById("qig-a1111-adetailer-opts").style.display = e.target.checked ? "block" : "none";
    };

    // ADetailer Unit 2 bindings
    bind("qig-a1111-ad2-model", "a1111Adetailer2Model");
    bind("qig-a1111-ad2-prompt", "a1111Adetailer2Prompt");
    bind("qig-a1111-ad2-negative", "a1111Adetailer2Negative");
    bind("qig-a1111-ad2-denoise", "a1111Adetailer2Denoise", true);
    bind("qig-a1111-ad2-confidence", "a1111Adetailer2Confidence", true);
    bind("qig-a1111-ad2-mask-blur", "a1111Adetailer2MaskBlur", true);
    bind("qig-a1111-ad2-dilate", "a1111Adetailer2DilateErode", true);
    bindCheckbox("qig-a1111-ad2-inpaint-only", "a1111Adetailer2InpaintOnlyMasked");
    bind("qig-a1111-ad2-inpaint-padding", "a1111Adetailer2InpaintPadding", true);
    document.getElementById("qig-a1111-ad2-enable").onchange = (e) => {
        getSettings().a1111Adetailer2 = e.target.checked;
        saveSettingsDebounced();
        document.getElementById("qig-a1111-ad2-opts").style.display = e.target.checked ? "block" : "none";
    };

    // Save to WebUI binding
    bindCheckbox("qig-a1111-save-webui", "a1111SaveToWebUI");

    // IP-Adapter bindings
    bind("qig-a1111-ipadapter-mode", "a1111IpAdapterMode");
    bind("qig-a1111-ipadapter-weight", "a1111IpAdapterWeight", true);
    document.getElementById("qig-a1111-ipadapter").onchange = (e) => {
        getSettings().a1111IpAdapter = e.target.checked;
        saveSettingsDebounced();
        document.getElementById("qig-a1111-ipadapter-opts").style.display = e.target.checked ? "block" : "none";
    };
    document.getElementById("qig-a1111-ipadapter-weight").oninput = (e) => {
        document.getElementById("qig-a1111-ipadapter-weight-val").textContent = e.target.value;
    };
    bindCheckbox("qig-a1111-ipadapter-pixel", "a1111IpAdapterPixelPerfect");
    bind("qig-a1111-ipadapter-resize", "a1111IpAdapterResizeMode");
    bind("qig-a1111-ipadapter-control", "a1111IpAdapterControlMode");
    bind("qig-a1111-ipadapter-start", "a1111IpAdapterStartStep", true);
    bind("qig-a1111-ipadapter-end", "a1111IpAdapterEndStep", true);

    // Generic ControlNet bindings
    bind("qig-a1111-cn-model", "a1111ControlNetModel");
    bind("qig-a1111-cn-module", "a1111ControlNetModule");
    bind("qig-a1111-cn-weight", "a1111ControlNetWeight", true);
    bindCheckbox("qig-a1111-cn-pixel", "a1111ControlNetPixelPerfect");
    bind("qig-a1111-cn-resize", "a1111ControlNetResizeMode");
    bind("qig-a1111-cn-control", "a1111ControlNetControlMode");
    bind("qig-a1111-cn-start", "a1111ControlNetGuidanceStart", true);
    bind("qig-a1111-cn-end", "a1111ControlNetGuidanceEnd", true);
    document.getElementById("qig-a1111-controlnet").onchange = (e) => {
        getSettings().a1111ControlNet = e.target.checked;
        saveSettingsDebounced();
        document.getElementById("qig-a1111-controlnet-opts").style.display = e.target.checked ? "block" : "none";
    };
    document.getElementById("qig-a1111-cn-weight").oninput = (e) => {
        document.getElementById("qig-a1111-cn-weight-val").textContent = e.target.value;
    };
    // ControlNet image upload
    const cnUploadInput = document.getElementById("qig-a1111-cn-upload");
    document.getElementById("qig-a1111-cn-upload-btn").onclick = () => cnUploadInput.click();
    document.getElementById("qig-a1111-cn-clear-btn").onclick = () => {
        getSettings().a1111ControlNetImage = "";
        saveSettingsDebounced();
        document.getElementById("qig-a1111-cn-preview").style.display = "none";
        document.getElementById("qig-a1111-cn-clear-btn").style.display = "none";
    };
    cnUploadInput.onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            getSettings().a1111ControlNetImage = ev.target.result;
            saveSettingsDebounced();
            const preview = document.getElementById("qig-a1111-cn-preview");
            preview.src = ev.target.result;
            preview.style.display = "block";
            document.getElementById("qig-a1111-cn-clear-btn").style.display = "block";
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    };

    // A1111 Model dropdown
    const a1111ModelSelect = document.getElementById("qig-a1111-model");
    const a1111ModelRefresh = document.getElementById("qig-a1111-model-refresh");

    async function populateA1111Models() {
        const s = getSettings();
        a1111ModelSelect.innerHTML = '<option value="">Loading...</option>';

        // Fetch SD Checkpoints
        const models = await fetchA1111Models(s.localUrl);
        const currentModel = s.a1111Model || await getCurrentA1111Model(s.localUrl);

        if (models.length === 0) {
            a1111ModelSelect.innerHTML = '<option value="">-- Failed to load (check if A1111 running) --</option>';
        } else {
            a1111ModelSelect.innerHTML = models.map(m =>
                `<option value="${m.title}" ${m.title === currentModel ? 'selected' : ''}>${m.name}</option>`
            ).join('');

            if (currentModel && !s.a1111Model) {
                s.a1111Model = currentModel;
                saveSettingsDebounced();
            }
        }

        // Fetch ControlNet Models for IP-Adapter
        const cnModels = await fetchControlNetModels(s.localUrl);
        const cnSelect = document.getElementById("qig-a1111-ipadapter-mode");

        // Filter for IP-Adapter/FaceID models
        const ipModels = cnModels.filter(m => m.toLowerCase().includes("ip-adapter") || m.toLowerCase().includes("faceid"));

        if (ipModels.length > 0) {
            // Preserve current selection if possible, otherwise default
            const currentCn = s.a1111IpAdapterMode;

            cnSelect.innerHTML = ipModels.map(m =>
                `<option value="${m}" ${m === currentCn ? 'selected' : ''}>${m}</option>`
            ).join('');

            // Add a separator and the standard presets if they aren't in the list?
            // Actually, best to just show what's available to ensure it works.
            // But maybe keep the standard ones as a reference if list is huge?
            // Let's just stick to detected models to fix the "silent failure" issue.
            cnSelect.insertAdjacentHTML('afterbegin', '<option value="" disabled>-- Detected Models --</option>');
        } else {
            // Fallback to presets if no API or no models found
            console.log("No IP-Adapter models detected via API, using presets.");
            const hasNoModelsOption = Array.from(cnSelect.options || []).some(opt =>
                opt.disabled && opt.textContent.includes("No IP-Adapter models detected")
            );
            if (!hasNoModelsOption) {
                cnSelect.insertAdjacentHTML('beforeend', '<option value="" disabled>-- No IP-Adapter models detected --</option>');
            }
        }

        // Fetch Upscalers for Hires Fix
        const upscalers = await fetchA1111Upscalers(s.localUrl);
        const upscalerSelect = document.getElementById("qig-a1111-hires-upscaler");
        if (upscalers.length > 0 && upscalerSelect) {
            const cur = s.a1111HiresUpscaler || "Latent";
            upscalerSelect.innerHTML = upscalers.map(u =>
                `<option value="${u}" ${u === cur ? 'selected' : ''}>${u}</option>`
            ).join('');
        }

        // Fetch VAEs
        const vaes = await fetchA1111VAEs(s.localUrl);
        const vaeSelect = document.getElementById("qig-a1111-vae");
        if (vaeSelect) {
            const curVae = s.a1111Vae || "";
            vaeSelect.innerHTML = `<option value="" ${!curVae ? "selected" : ""}>Automatic</option>` +
                vaes.map(v => `<option value="${v}" ${v === curVae ? "selected" : ""}>${v}</option>`).join("");
        }

        // Populate generic ControlNet model list (all models, not just IP-Adapter)
        const genericCnSelect = document.getElementById("qig-a1111-cn-model");
        if (genericCnSelect && cnModels.length > 0) {
            const curCn = s.a1111ControlNetModel || "";
            genericCnSelect.innerHTML = `<option value="">-- Select Model --</option>` +
                cnModels.map(m => `<option value="${m}" ${m === curCn ? "selected" : ""}>${m}</option>`).join("");
        } else if (genericCnSelect) {
            genericCnSelect.innerHTML = '<option value="">-- No ControlNet models found --</option>';
        }
    }

    a1111ModelSelect.onchange = async (e) => {
        const s = getSettings();
        const newModel = e.target.value;
        if (!newModel) return;

        a1111ModelSelect.disabled = true;
        const success = await switchA1111Model(s.localUrl, newModel);
        if (success) {
            s.a1111Model = newModel;
            saveSettingsDebounced();
            toastr?.success?.('Model switched');
        } else {
            toastr?.error?.('Failed to switch model');
        }
        a1111ModelSelect.disabled = false;
    };

    a1111ModelRefresh.onclick = () => populateA1111Models();

    // Local Ref Image
    const localRefInput = getOrCacheElement("qig-local-ref-input");
    const localRefBtn = getOrCacheElement("qig-local-ref-btn");
    const localRefClear = getOrCacheElement("qig-local-ref-clear");
    if (localRefBtn) localRefBtn.onclick = () => localRefInput.click();
    if (localRefClear) localRefClear.onclick = () => {
        const s = getSettings();
        s.localRefImage = "";
        saveSettingsDebounced();
        document.getElementById("qig-local-ref-preview").style.display = "none";
        document.getElementById("qig-local-ref-preview").src = "";
        localRefClear.style.display = "none";
        document.getElementById("qig-local-denoise-wrap").style.display = "none";
    };
    localRefInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const s = getSettings();
            s.localRefImage = ev.target.result;
            saveSettingsDebounced();
            document.getElementById("qig-local-ref-preview").src = s.localRefImage;
            document.getElementById("qig-local-ref-preview").style.display = "block";
            localRefClear.style.display = "block";
            document.getElementById("qig-local-denoise-wrap").style.display = s.localType === "a1111" ? "block" : "none";
            localRefInput.value = "";
        };
        reader.readAsDataURL(file);
    };

    bind("qig-proxy-url", "proxyUrl", () => updateProxyCompatibilityUI());
    bind("qig-proxy-key", "proxyKey");
    bind("qig-proxy-model", "proxyModel");
    bind("qig-proxy-timeout", "proxyTimeout", true);
    bind("qig-proxy-endpoint-mode", "proxyEndpointMode", () => updateProxyCompatibilityUI());
    bind("qig-proxy-payload-mode", "proxyPayloadMode", () => updateProxyCompatibilityUI());
    bind("qig-proxy-ref-mode", "proxyRefImageMode", () => {
        renderRefImages();
        updateProxyCompatibilityUI();
    });
    bind("qig-proxy-sse-mode", "proxySse", () => updateProxyCompatibilityUI());
    bind("qig-proxy-loras", "proxyLoras");
    bind("qig-proxy-steps", "proxySteps", true);
    bind("qig-proxy-cfg", "proxyCfg", true);
    bind("qig-proxy-sampler", "proxySampler");
    bind("qig-proxy-seed", "proxySeed", true);
    bindCheckbox("qig-proxy-facefix", "proxyFacefix");
    bind("qig-proxy-extra", "proxyExtraInstructions");
    bind("qig-proxy-chat-system", "proxyChatImageSystemPrompt");
    bind("qig-proxy-chat-max-tokens", "proxyChatImageMaxTokens", (value) => {
        const s = getSettings();
        s.proxyChatImageMaxTokens = value;
        updateProxyCompatibilityUI();
    });
    const chatModeEl = getOrCacheElement("qig-proxy-chat-mode");
    if (chatModeEl) chatModeEl.onchange = (e) => {
        setProxyChatImageCheckboxMode(e.target.checked);
    };
    const chatAllowImagesEl = getOrCacheElement("qig-proxy-chat-allow-images");
    if (chatAllowImagesEl) chatAllowImagesEl.onchange = (e) => {
        const s = getSettings();
        s.proxyChatImageAllowImagesEndpoint = e.target.checked;
        if (!s.proxyChatImageAllowImagesEndpoint) {
            s.proxyEndpointMode = "chat_completions";
        } else if (s.proxyEndpointMode === "chat_completions") {
            s.proxyEndpointMode = "auto";
        }
        saveSettingsDebounced();
        refreshProviderInputs("proxy", { updateProviderVisibility: false });
        updateProxyCompatibilityUI();
    };
    const chatPersonalityEl = getOrCacheElement("qig-proxy-chat-personality");
    if (chatPersonalityEl) chatPersonalityEl.onchange = (e) => {
        getSettings().proxyChatImageIncludePersonality = e.target.checked;
        saveSettingsDebounced();
    };
    const chatSetupEl = getOrCacheElement("qig-proxy-chat-setup");
    if (chatSetupEl) chatSetupEl.onclick = () => applyProxyChatImageSimpleMode({ persist: true, notify: true });
    bind("qig-proxy-comfy-timeout", "proxyComfyTimeout", true);
    bind("qig-proxy-comfy-node-id", "proxyComfyNodeId");
    bind("qig-proxy-comfy-workflow", "proxyComfyWorkflow");
    const comfyModeEl = getOrCacheElement("qig-proxy-comfy-mode");
    if (comfyModeEl) comfyModeEl.onchange = (e) => {
        const s = getSettings();
        s.proxyComfyMode = e.target.checked;
        saveSettingsDebounced();
        updateProxyCompatibilityUI();
    };

    // Reference images handling
    const refInput = getOrCacheElement("qig-proxy-ref-input");
    const refBtn = getOrCacheElement("qig-proxy-ref-btn");
    if (refBtn) refBtn.onclick = () => refInput.click();
    refInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        const s = getSettings();
        if (normalizeProxyRefImageSetting(s.proxyRefImageMode) === "url_only") {
            toastr.warning("This proxy compatibility mode only accepts public image URLs for reference images.");
            refInput.value = "";
            return;
        }
        if (!s.proxyRefImages) s.proxyRefImages = [];
        const remaining = 15 - s.proxyRefImages.length;
        const filesToProcess = files.slice(0, remaining);

        const readPromises = filesToProcess.map(file =>
            new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve(ev.target.result);
                reader.readAsDataURL(file);
            })
        );

        const results = await Promise.all(readPromises);
        s.proxyRefImages.push(...results);
        saveSettingsDebounced();
        renderRefImages();
        updateProxyCompatibilityUI();
        refInput.value = "";
    };
    // URL input for proxy ref images
    const proxyRefUrl = getOrCacheElement("qig-proxy-ref-url");
    if (proxyRefUrl) proxyRefUrl.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const url = proxyRefUrl.value.trim();
        if (!url) return;
        if (addProxyRefImage(url, "Reference image URL added")) {
            proxyRefUrl.value = "";
        }
    };
    renderRefImages();
    updateProxyCompatibilityUI();

    // Nanobanana reference images handling
    const nanoRefInput = getOrCacheElement("qig-nanobanana-ref-input");
    const nanoRefBtn = getOrCacheElement("qig-nanobanana-ref-btn");
    if (nanoRefBtn) nanoRefBtn.onclick = () => nanoRefInput.click();
    nanoRefInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        const s = getSettings();
        if (!s.nanobananaRefImages) s.nanobananaRefImages = [];
        const remaining = 15 - s.nanobananaRefImages.length;
        const filesToProcess = files.slice(0, remaining);

        const readPromises = filesToProcess.map(file =>
            new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve(ev.target.result);
                reader.readAsDataURL(file);
            })
        );

        const results = await Promise.all(readPromises);
        s.nanobananaRefImages.push(...results);
        saveSettingsDebounced();
        renderNanobananaRefImages();
        nanoRefInput.value = "";
    };
    // URL input for nanobanana ref images
    const nanoRefUrl = getOrCacheElement("qig-nanobanana-ref-url");
    if (nanoRefUrl) nanoRefUrl.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const url = nanoRefUrl.value.trim();
        if (!url) return;
        const s = getSettings();
        if (!s.nanobananaRefImages) s.nanobananaRefImages = [];
        if (s.nanobananaRefImages.length >= 15) { toastr.warning("Maximum 15 reference images"); return; }
        s.nanobananaRefImages.push(url);
        saveSettingsDebounced();
        renderNanobananaRefImages();
        nanoRefUrl.value = "";
        toastr.success("Reference image URL added");
    };
    renderNanobananaRefImages();

    // NanoGPT reference images handling
    const nanogptRefInput = getOrCacheElement("qig-nanogpt-ref-input");
    const nanogptRefBtn = getOrCacheElement("qig-nanogpt-ref-btn");
    if (nanogptRefBtn) nanogptRefBtn.onclick = () => nanogptRefInput.click();
    nanogptRefInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        const s = getSettings();
        if (!s.nanogptRefImages) s.nanogptRefImages = [];
        const remaining = 15 - s.nanogptRefImages.length;
        const filesToProcess = files.slice(0, remaining);

        const readPromises = filesToProcess.map(file =>
            new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve(ev.target.result);
                reader.readAsDataURL(file);
            })
        );

        const results = await Promise.all(readPromises);
        s.nanogptRefImages.push(...results);
        saveSettingsDebounced();
        renderNanogptRefImages();
        nanogptRefInput.value = "";
    };
    // URL input for nanogpt ref images
    const nanogptRefUrl = getOrCacheElement("qig-nanogpt-ref-url");
    if (nanogptRefUrl) nanogptRefUrl.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const url = nanogptRefUrl.value.trim();
        if (!url) return;
        const s = getSettings();
        if (!s.nanogptRefImages) s.nanogptRefImages = [];
        if (s.nanogptRefImages.length >= 15) { toastr.warning("Maximum 15 reference images"); return; }
        s.nanogptRefImages.push(url);
        saveSettingsDebounced();
        renderNanogptRefImages();
        nanogptRefUrl.value = "";
        toastr.success("Reference image URL added");
    };
    renderNanogptRefImages();

    bind("qig-prompt", "prompt");
    bind("qig-negative", "negativePrompt");
    bind("qig-quality", "qualityTags");
    bindCheckbox("qig-append-quality", "appendQuality");
    document.getElementById("qig-use-last").onchange = (e) => {
        getSettings().useLastMessage = e.target.checked;
        document.getElementById("qig-msg-index-wrap").style.display = e.target.checked ? "block" : "none";
        saveSettingsDebounced();
    };
    bind("qig-msg-range", "messageRange", false);
    bindCheckbox("qig-paragraph-picker", "enableParagraphPicker");
    document.getElementById("qig-use-llm").onchange = (e) => {
        getSettings().useLLMPrompt = e.target.checked;
        document.getElementById("qig-llm-options").style.display = e.target.checked ? "block" : "none";
        saveSettingsDebounced();
    };
    bind("qig-llm-custom", "llmCustomInstruction");
    bindCheckbox("qig-llm-edit", "llmEditPrompt");
    bindCheckbox("qig-llm-quality", "llmAddQuality");
    bindCheckbox("qig-llm-lighting", "llmAddLighting");
    bindCheckbox("qig-llm-artist", "llmAddArtist");
    bind("qig-llm-prefill", "llmPrefill");
    document.getElementById("qig-llm-style").onchange = e => {
        getSettings().llmPromptStyle = e.target.value;
        saveSettingsDebounced();
        document.getElementById("qig-llm-custom-wrap").style.display = e.target.value === "custom" ? "block" : "none";
    };
    bindAutoGenerateCheckbox("qig-auto-generate");
    bindAutoGenerateNumberInput("qig-auto-generate-every", "autoGenerateEveryMessages", normalizeAutoGenerateEveryMessages);
    bindAutoGenerateNumberInput("qig-auto-generate-delay", "autoGenerateDelayMs", normalizeAutoGenerateDelayMs);
    const twoStepPromptEl = document.getElementById("qig-two-step-prompt");
    if (twoStepPromptEl) {
        twoStepPromptEl.onchange = (e) => {
            const s = getSettings();
            s.twoStepPrompt = e.target.checked;
            syncTwoStepPromptControls(s);
            saveSettingsDebounced();
        };
    }
    bind("qig-two-step-instruction", "twoStepInstruction");
    const autoBackgroundEl = document.getElementById("qig-auto-background");
    if (autoBackgroundEl) {
        autoBackgroundEl.onchange = (e) => {
            const s = getSettings();
            s.autoSetBackground = e.target.checked;
            syncBackgroundControls(s);
            saveSettingsDebounced();
        };
    }
    const backgroundModeEl = document.getElementById("qig-background-mode");
    if (backgroundModeEl) {
        backgroundModeEl.onchange = (e) => {
            const s = getSettings();
            s.backgroundMode = normalizeBackgroundMode(e.target.value);
            e.target.value = s.backgroundMode;
            saveSettingsDebounced();
        };
    }
    bindCheckbox("qig-auto-insert", "autoInsert");
    const outputModeEl = document.getElementById("qig-output-mode");
    if (outputModeEl) {
        outputModeEl.onchange = (e) => {
            getSettings().outputMode = normalizeOutputMode(e.target.value);
            saveSettingsDebounced();
        };
    }
    const manualInsertTargetEl = document.getElementById("qig-manual-insert-target");
    if (manualInsertTargetEl) {
        manualInsertTargetEl.onchange = (e) => {
            getSettings().manualInsertTarget = normalizeManualInsertTarget(e.target.value);
            saveSettingsDebounced();
        };
    }
    const hiddenReplyEl = document.getElementById("qig-insert-hidden-reply");
    bindCheckbox("qig-insert-hidden-reply", "insertAsHiddenReply");
    document.getElementById("qig-auto-insert").addEventListener("change", e => {
        if (hiddenReplyEl) {
            hiddenReplyEl.disabled = !e.target.checked;
            const label = hiddenReplyEl.closest("label");
            if (label) label.style.opacity = e.target.checked ? "1" : "0.6";
        }
    });
    const saveToServerEl = document.getElementById("qig-save-to-server");
    const saveToServerMetaEl = document.getElementById("qig-save-to-server-meta");
    const updateSaveToServerMetaState = () => {
        if (!saveToServerMetaEl) return;
        const enabled = !!saveToServerEl?.checked;
        saveToServerMetaEl.disabled = !enabled;
        const label = saveToServerMetaEl.closest("label");
        if (label) label.style.opacity = enabled ? "1" : "0.6";
    };
    if (saveToServerEl) {
        saveToServerEl.onchange = (e) => {
            getSettings().saveToServer = e.target.checked;
            saveSettingsDebounced();
            updateSaveToServerMetaState();
        };
    }
    if (saveToServerMetaEl) {
        saveToServerMetaEl.onchange = (e) => {
            getSettings().saveToServerEmbedMetadata = e.target.checked;
            saveSettingsDebounced();
        };
    }
    updateSaveToServerMetaState();
    document.getElementById("qig-disable-palette").onchange = (e) => {
        getSettings().disablePaletteButton = e.target.checked;
        saveSettingsDebounced();
        const btn = document.getElementById("qig-input-btn");
        if (e.target.checked) {
            closePalettePresetMenu();
            if (btn) btn.style.display = "none";
        } else {
            if (btn) btn.style.display = "";
            else addInputButton();
        }
    };
    const paletteModeEl = document.getElementById("qig-palette-mode");
    if (paletteModeEl) {
        paletteModeEl.onchange = (e) => {
            getSettings().paletteMode = normalizePaletteMode(e.target.value);
            saveSettingsDebounced();
        };
    }
    document.getElementById("qig-confirm-generate").onchange = (e) => {
        getSettings().confirmBeforeGenerate = e.target.checked;
        saveSettingsDebounced();
    };
    bindCheckbox("qig-use-st-style", "useSTStyle");
    // Inject mode bindings
    document.getElementById("qig-inject-enabled").onchange = (e) => {
        getSettings().injectEnabled = e.target.checked;
        const toggle = document.getElementById("qig-inject-options-toggle");
        const content = document.getElementById("qig-inject-options");
        if (e.target.checked) {
            setCollapsedSection("injectOptions", false);
            if (toggle && content) {
                toggle.setAttribute("aria-expanded", "true");
                content.hidden = false;
            }
        } else {
            setCollapsedSection("injectOptions", true);
            if (toggle && content) {
                toggle.setAttribute("aria-expanded", "false");
                content.hidden = true;
            }
        }
        saveSettingsDebounced();
    };
    document.getElementById("qig-inject-tag-name").onchange = (e) => {
        e.target.value = applyInjectTagNameChange(e.target.value);
        saveSettingsDebounced();
    };
    bind("qig-inject-prompt", "injectPrompt");
    bind("qig-inject-regex", "injectRegex", (value) => {
        try {
            const sampleTag = getInjectTagPreview(getInjectTagName(getSettings()));
            const testMatch = extractInjectMatchesFromText(sampleTag, value);
            if (testMatch.length === 0) {
                toastr.warning("Regex may not capture image descriptions. Test with sample tags.");
            }
        } catch (e) {
            toastr.error("Invalid regex pattern: " + e.message);
        }
    });
    document.getElementById("qig-inject-position").onchange = (e) => {
        getSettings().injectPosition = e.target.value;
        document.getElementById("qig-inject-depth-wrap").style.display = e.target.value === "atDepth" ? "block" : "none";
        saveSettingsDebounced();
    };
    bind("qig-inject-depth", "injectDepth", true);
    bind("qig-inject-insert-mode", "injectInsertMode");
    bindCheckbox("qig-inject-autoclean", "injectAutoClean");

    // Test inject detection button
    document.getElementById("qig-test-inject").onclick = async () => {
        const s = getSettings();
        const ctx = getContext();
        const chat = ctx.chat;

        if (!chat || chat.length === 0) {
            toastr.info("No chat messages to test");
            return;
        }

        // Find last AI message
        const lastAiMessage = findLastInjectCandidateMessage(chat);
        if (!lastAiMessage) {
            toastr.info("No AI messages found");
            return;
        }

        let detection;
        try {
            detection = extractInjectPromptsFromMessage(lastAiMessage.message, s);
        } catch (e) {
            toastr.error("Invalid regex: " + e.message);
            return;
        }

        const sourceSummary = detection.scannedSources.length > 0 ? detection.scannedSources.join(", ") : "none";
        const visiblePreview = detection.sources[0]?.text?.substring(0, 200) || "";
        const result = detection.matches.length > 0
            ? `Found ${detection.matches.length} tag(s):\n${detection.matches.map(match => `[${match.sources.join(", ")}] ${match.prompt}`).join("\n")}`
            : `No tags found in last AI message or reasoning.\n\nScanned sources: ${sourceSummary}\n\nMessage preview:\n${visiblePreview}...\n\nRegex used:\n${detection.regexPattern}`;

        alert(result);
    };

    // LLM Override bindings
    document.getElementById("qig-llm-override").onchange = (e) => {
        getSettings().llmOverrideEnabled = e.target.checked;
        document.getElementById("qig-llm-override-options").style.display = e.target.checked ? "block" : "none";
        if (e.target.checked) {
            populateConnectionProfiles("qig-llm-override-profile", getSettings().llmOverrideProfileId);
            populatePresetList("qig-llm-override-preset-select", getSettings().llmOverridePreset);
        }
        saveSettingsDebounced();
    };
    document.getElementById("qig-llm-override-profile").onchange = (e) => {
        getSettings().llmOverrideProfileId = e.target.value;
        saveSettingsDebounced();
    };
    document.getElementById("qig-llm-override-preset-select").onchange = (e) => {
        getSettings().llmOverridePreset = e.target.value;
        saveSettingsDebounced();
    };
    bind("qig-llm-override-max", "llmOverrideMaxTokens", true);
    const widthEl = document.getElementById("qig-width");
    const heightEl = document.getElementById("qig-height");
    const onSizeChange = () => {
        const s = getSettings();
        const currentWidth = Number.isFinite(s.width) ? s.width : SIZE_DEFAULT;
        const currentHeight = Number.isFinite(s.height) ? s.height : SIZE_DEFAULT;
        s.width = parseIntOr(widthEl?.value, currentWidth);
        s.height = parseIntOr(heightEl?.value, currentHeight);
        if (s.provider === "novelai") {
            normalizeSize(s);
            syncNaiResolutionSelect();
        }
        syncSizeInputs(s.width, s.height);
        saveSettingsDebounced();
    };
    if (widthEl) widthEl.onchange = onSizeChange;
    if (heightEl) heightEl.onchange = onSizeChange;
    document.getElementById("qig-aspect").onchange = (e) => {
        const v = e.target.value;
        if (!v) return;
        const s = getSettings();
        const base = Math.min(s.width, s.height) || 512;
        const [w, h] = v.split(":").map(Number);
        if (isNaN(w) || isNaN(h) || h === 0) return;
        if (w > h) { s.width = Math.round(base * w / h); s.height = base; }
        else { s.width = base; s.height = Math.round(base * h / w); }
        if (s.provider === "novelai") {
            normalizeSize(s);
            syncNaiResolutionSelect();
        }
        syncSizeInputs(s.width, s.height);
        saveSettingsDebounced();
    };
    document.getElementById("qig-nai-resolution").onchange = (e) => {
        if (e.target.value === NAI_CUSTOM_RESOLUTION_VALUE) {
            syncNaiResolutionSelect();
            return;
        }
        const [w, h] = e.target.value.split("x").map(Number);
        if (isNaN(w) || isNaN(h)) return;
        const s = getSettings();
        s.width = w;
        s.height = h;
        normalizeSize(s);
        syncSizeInputs(s.width, s.height);
        syncNaiResolutionSelect();
        saveSettingsDebounced();
    };
    bind("qig-batch", "batchCount", true);
    document.getElementById("qig-batch").addEventListener("input", (e) => {
        const wrap = document.getElementById("qig-seq-seeds-wrap");
        if (wrap) wrap.style.display = parseInt(e.target.value) > 1 ? "" : "none";
    });
    bindCheckbox("qig-seq-seeds", "sequentialSeeds");
    bind("qig-steps", "steps", true);
    bind("qig-cfg", "cfgScale", true);
    bind("qig-sampler", "sampler");
    bind("qig-seed", "seed", true);

    updateProviderUI();

    // Drag and Drop Metadata Listener
    const settingsPanel = document.getElementById("qig-settings");
    if (settingsPanel) {
        settingsPanel.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); };
        settingsPanel.ondrop = handleMetadataDrop;
    }
}

function closePalettePresetMenu() {
    if (typeof _palettePresetMenuCleanup === "function") {
        _palettePresetMenuCleanup();
        _palettePresetMenuCleanup = null;
    }
}

function showPalettePresetMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (isGenerating) return;

    closePalettePresetMenu();
    ensureGenerationPresetIds({ persist: true });
    syncActiveGenerationPresetSetting({ persist: true });

    const anchor = document.getElementById("qig-input-btn");
    const activePresetId = getActiveGenerationPresetId();
    const menu = document.createElement("div");
    menu.id = "qig-palette-preset-menu";
    menu.className = "qig-palette-preset-menu";

    const title = document.createElement("div");
    title.className = "qig-palette-preset-menu__title";
    title.textContent = "Generation Presets";
    menu.appendChild(title);

    if (!generationPresets.length) {
        const emptyState = document.createElement("div");
        emptyState.className = "qig-palette-preset-menu__empty";
        emptyState.textContent = "No presets saved yet.";
        menu.appendChild(emptyState);
    } else {
        for (const [index, preset] of generationPresets.entries()) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `menu_button qig-palette-preset-menu__item${preset?.id === activePresetId ? " qig-palette-preset-menu__item--active" : ""}`;
            button.textContent = `${preset?.id === activePresetId ? "✓ " : ""}${preset?.name || `Preset ${index + 1}`}`;
            button.onclick = (clickEvent) => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                loadPreset(index);
            };
            menu.appendChild(button);
        }
    }

    menu.style.visibility = "hidden";
    document.body.appendChild(menu);

    const placeMenu = () => {
        const margin = 8;
        const rect = menu.getBoundingClientRect();
        let left = event.clientX;
        let top = event.clientY;
        if (left + rect.width + margin > window.innerWidth) {
            left = Math.max(margin, window.innerWidth - rect.width - margin);
        }
        if (top + rect.height + margin > window.innerHeight) {
            top = Math.max(margin, window.innerHeight - rect.height - margin);
        }
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.visibility = "visible";
    };
    placeMenu();

    const closeOnPointerDown = (pointerEvent) => {
        if (menu.contains(pointerEvent.target) || anchor?.contains(pointerEvent.target)) return;
        closePalettePresetMenu();
    };
    const closeOnEscape = (keyEvent) => {
        if (keyEvent.key === "Escape") closePalettePresetMenu();
    };
    const closeOnContextMenu = (contextEvent) => {
        if (menu.contains(contextEvent.target)) return;
        closePalettePresetMenu();
    };

    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape, true);
    document.addEventListener("contextmenu", closeOnContextMenu, true);
    window.addEventListener("resize", closePalettePresetMenu, true);
    window.addEventListener("scroll", closePalettePresetMenu, true);

    _palettePresetMenuCleanup = () => {
        document.removeEventListener("pointerdown", closeOnPointerDown, true);
        document.removeEventListener("keydown", closeOnEscape, true);
        document.removeEventListener("contextmenu", closeOnContextMenu, true);
        window.removeEventListener("resize", closePalettePresetMenu, true);
        window.removeEventListener("scroll", closePalettePresetMenu, true);
        if (menu.parentElement) menu.parentElement.removeChild(menu);
    };
}

function getMessageGenerateActionMount(messageElement) {
    return messageElement?.querySelector?.(".extraMesButtons")
        || messageElement?.querySelector?.(".mes_buttons")
        || messageElement?.querySelector?.(".ch_name")
        || messageElement?.querySelector?.(".mes_block")
        || null;
}

function createMessageGenerateActionButton(messageIndex) {
    const button = document.createElement("div");
    button.className = `mes_button fa-solid fa-palette ${QIG_MESSAGE_ACTION_CLASS}`;
    button.title = "Generate image from this message with Quick Image Gen";
    button.dataset.messageIndex = String(messageIndex);
    return button;
}

function getMessageElementsWithin(root = document) {
    const elements = [];
    if (root instanceof Element && root.matches(".mes[mesid]")) {
        elements.push(root);
    }
    if (root?.querySelectorAll) {
        elements.push(...root.querySelectorAll(".mes[mesid]"));
    }
    return elements;
}

function ensureMessageGenerateAction(messageElement, ctx = getContext?.()) {
    if (!(messageElement instanceof Element)) return;
    if (messageElement.querySelector(`.${QIG_MESSAGE_ACTION_CLASS}`)) return;

    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const messageIndex = clampChatMessageIndex(messageElement.getAttribute("mesid"), chat.length);
    if (!Number.isInteger(messageIndex)) return;

    const message = chat[messageIndex];
    if (!message || message.is_system) return;

    const mount = getMessageGenerateActionMount(messageElement);
    if (!(mount instanceof Element)) return;

    const button = createMessageGenerateActionButton(messageIndex);
    if (!mount.classList.contains("extraMesButtons")) {
        button.classList.add(`${QIG_MESSAGE_ACTION_CLASS}--fallback`);
    }
    mount.appendChild(button);
}

function refreshMessageGenerateActions(root = document) {
    const ctx = getContext?.();
    for (const messageElement of getMessageElementsWithin(root)) {
        ensureMessageGenerateAction(messageElement, ctx);
    }
}

function scheduleRefreshMessageGenerateActions() {
    if (qigMessageActionRefreshQueued) return;
    qigMessageActionRefreshQueued = true;
    const scheduleFn = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (cb) => setTimeout(cb, 0);
    scheduleFn(() => {
        qigMessageActionRefreshQueued = false;
        refreshMessageGenerateActions(document.getElementById("chat") || document);
    });
}

function initMessageGenerateActionObserver() {
    const chatRoot = document.getElementById("chat");
    if (!chatRoot) {
        setTimeout(initMessageGenerateActionObserver, 500);
        return;
    }

    if (qigMessageActionObserver) {
        qigMessageActionObserver.disconnect();
    }
    qigMessageActionObserver = new MutationObserver((mutations) => {
        if (mutations.some(mutation => mutation.type === "childList" && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0))) {
            scheduleRefreshMessageGenerateActions();
        }
    });
    qigMessageActionObserver.observe(chatRoot, { childList: true, subtree: true });
    scheduleRefreshMessageGenerateActions();
}

function bindMessageGenerateActionClicks() {
    if (qigMessageActionClicksBound) return;
    qigMessageActionClicksBound = true;

    $(document).on("click", `.${QIG_MESSAGE_ACTION_CLASS}`, async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (isGenerating) {
            toastr.warning("Generation already in progress");
            return;
        }

        const ctx = getContext?.();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const messageElement = event.currentTarget.closest(".mes[mesid]");
        const messageIndex = clampChatMessageIndex(
            messageElement?.getAttribute?.("mesid") ?? event.currentTarget.dataset.messageIndex,
            chat.length,
        );

        if (!Number.isInteger(messageIndex)) {
            toastr.error("Could not find the target chat message");
            return;
        }

        try {
            setTransientGenerationTarget(messageIndex);
            await generateImage();
        } catch (e) {
            log(`Message action: Generation failed for message ${messageIndex}: ${e.message}`);
            toastr.error("Failed to generate from that message: " + e.message);
        } finally {
            clearTransientGenerationTarget();
        }
    });
}

function runConfiguredPaletteGeneration() {
    const mode = normalizePaletteMode(getSettings()?.paletteMode);
    if (mode === "inject") return generateImageInjectPalette();
    return generateImage();
}

function addInputButton() {
    if (document.getElementById("qig-input-btn")) return;
    if (getSettings().disablePaletteButton) return;

    const btn = document.createElement("div");
    btn.id = "qig-input-btn";
    btn.className = "fa-solid fa-palette interactable";
    btn.title = "Generate Image (right-click for presets)";
    btn.style.cssText = "cursor:pointer;padding:5px;font-size:1.2em;opacity:0.7;";
    btn.onclick = () => {
        closePalettePresetMenu();
        const now = Date.now();
        if (isGenerating) {
            if (!requestGenerationCancel()) return;
            log("User cancelled generation via palette button");
            toastr.warning("Cancelling generation...");
            return;
        }
        if (now < paletteGenerateLockUntil) {
            log("Palette: Ignored rapid duplicate generate click");
            return;
        }
        paletteGenerateLockUntil = now + PALETTE_GENERATE_LOCK_MS;
        resetAutoGenerateCadence({ clearTimer: true });
        runConfiguredPaletteGeneration();
    };
    btn.oncontextmenu = showPalettePresetMenu;

    // Add to left side area (away from send button)
    const leftArea = document.getElementById("leftSendForm") || document.querySelector("#send_form .left_menu_buttons");
    if (leftArea) {
        leftArea.appendChild(btn);
    }
}

async function generateImageInjectPalette() {
    if (isGenerating) return;
    const s = getSettings();
    if (s.confirmBeforeGenerate && !confirm("Generate image?")) return;

    const mySerial = ++_paletteInjectSerial;
    beginGeneration({ disableGenerateButton: true, clearPendingAuto: true });
    _paletteInjectActive = true;
    const cancelCheckpoint = getCancelCheckpoint();
    let sourceInjectMessage = null;
    let sourceMessageIndex = null;
    const consumedMessagePrompts = new Set();

    try {
        checkAborted(cancelCheckpoint);
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        let regexPattern = getInjectRegexPattern(s);
        let initialDetection = null;
        let matches = [];

        const unconsumedCandidate = findLastInjectCandidateMessage(chat, s, { requireMatches: true, includeConsumed: false });
        if (unconsumedCandidate && !hasUserMessageAfterIndex(chat, unconsumedCandidate.index)) {
            initialDetection = unconsumedCandidate.detection;
            matches = [...new Set(unconsumedCandidate.prompts || [])];
            sourceInjectMessage = unconsumedCandidate.message;
            sourceMessageIndex = unconsumedCandidate.index;
        } else {
            const consumedCandidate = findLastInjectCandidateMessage(chat, s, { requireMatches: true, includeConsumed: true });
            if (consumedCandidate?.detectedPrompts?.length && !hasUserMessageAfterIndex(chat, consumedCandidate.index)) {
                initialDetection = consumedCandidate.detection;
                matches = [...new Set(consumedCandidate.detectedPrompts)];
                log(`Palette inject: All ${matches.length} detected tag(s) were already consumed; using them for this manual run only`);
            } else if (unconsumedCandidate || consumedCandidate) {
                log("Palette inject: Ignoring older image tag because a newer user message exists; using selected scene fallback");
            }
        }

        if (matches.length === 0) {
            log("Palette inject: No image tags found, asking LLM for one tag from the selected scene");
            showStatus("🔍 No image tags found; asking LLM for one image tag...");

            const sceneContext = getMessages(s, ctx) || resolvePrompt(s.prompt) || "the current scene";
            const injectInstruction = resolvePrompt(getInjectPromptTemplate(s));
            const timestamp = Date.now();
            const fullInstruction = `${injectInstruction}\n\nBased on this scene context, generate exactly one image tag for the single best visual moment. You must use the exact tag format shown above. Return exactly one tag only. Do not generate multiple tags, lists, moments, or variants.\n\nScene context:\n${sceneContext}\n\nRespond with image tags only.\n\n[${timestamp}]`;

            let llmResponse;
            if (s.llmOverrideEnabled && s.llmOverrideProfileId) {
                log("Using LLM Override for inject palette");
                llmResponse = await callOverrideLLM(fullInstruction);
            } else {
                llmResponse = await callInternalStandaloneLLM(fullInstruction, {
                    signal: currentAbortController?.signal,
                    quietName: `ImageGenInject_${timestamp}`,
                    label: "palette inject tag generation request",
                });
            }
            checkAborted(cancelCheckpoint);

            log(`Palette inject: LLM response: ${(llmResponse || "").substring(0, 200)}...`);
            if (llmResponse) {
                matches = limitInjectFallbackMatches(
                    extractInjectMatchesFromText(llmResponse, regexPattern),
                    "Palette inject fallback"
                );
            }

            if (matches.length === 0) {
                const aiSources = initialDetection?.scannedSources?.join(", ") || "none";
                const aiMsgPreview = initialDetection?.sources?.[0]?.text?.substring(0, 200) || "none";
                const llmPreview = (llmResponse || "none").substring(0, 200);
                const regexPreview = regexPattern.substring(0, 100);
                log(`Palette inject: Regex pattern used: ${regexPattern}`);
                log(`Palette inject: AI sources scanned: ${aiSources}`);
                log(`Palette inject: AI message scanned: ${aiMsgPreview}...`);
                log(`Palette inject: LLM response received: ${llmPreview}...`);
                log(`Palette inject: Full instruction sent: ${fullInstruction.substring(0, 300)}...`);
                toastr.warning("No image tags found. Check console for details.", "Image Generation");
                log(`Palette inject: Diagnostic info - regex ${regexPreview}${regexPattern.length > 100 ? "..." : ""}, sources ${aiSources}`);
                console.warn("QIG Inject Mode Debug:", {
                    regexPattern,
                    aiSources,
                    aiMessage: initialDetection?.sources?.map(source => ({ label: source.label, text: source.text })),
                    llmResponse,
                    instruction: fullInstruction,
                });
                return;
            }

            sourceInjectMessage = null;
            sourceMessageIndex = null;
        }

        log(`Palette inject: Found ${matches.length} image tag(s), generating images...`);
        const baseSceneText = getMessages(s, ctx) || "";
        for (const extractedPrompt of matches) {
            checkAborted(cancelCheckpoint);
            showStatus("🖼️ Generating palette-inject image...");

            const originalSeed = getGenerationSeedValue(s);
            try {
                let prompt = await generateLLMPrompt(s, extractedPrompt, currentAbortController?.signal);
                checkAborted(cancelCheckpoint);

                if (s.useLLMPrompt && s.llmEditPrompt && prompt !== extractedPrompt) {
                    const editedPrompt = await showPromptEditDialog(prompt);
                    if (editedPrompt !== null) prompt = editedPrompt;
                    else continue;
                }
                if (sourceInjectMessage) {
                    consumedMessagePrompts.add(extractedPrompt);
                }

                let negative = resolvePrompt(s.negativePrompt);
                prompt = applyStyle(prompt, s);

                if (s.appendQuality && s.qualityTags) {
                    prompt = `${s.qualityTags}, ${prompt}`;
                }

                if (s.useSTStyle !== false) {
                    const stStyle = getSTStyleSettings();
                    if (stStyle.prefix) prompt = `${stStyle.prefix}, ${prompt}`;
                    if (stStyle.charPositive) prompt = `${prompt}, ${stStyle.charPositive}`;
                    if (stStyle.negative) negative = `${negative}, ${stStyle.negative}`;
                    if (stStyle.charNegative) negative = `${negative}, ${stStyle.charNegative}`;
                }

                const contextualApplied = await applyResolvedContextualFilters(prompt, negative, {
                    matchText: [baseSceneText, extractedPrompt, prompt].filter(Boolean).join("\n\n"),
                    llmSceneText: baseSceneText || extractedPrompt,
                    signal: currentAbortController?.signal,
                });
                checkAborted(cancelCheckpoint);
                prompt = contextualApplied.prompt;
                negative = contextualApplied.negative;

                lastPrompt = prompt;
                lastNegative = negative;
                lastPromptWasLLM = (s.useLLMPrompt && prompt !== extractedPrompt);
                lastProxyContextRefImages = [];

                const batchCount = s.batchCount || 1;
                const results = [];
                const useSequentialSeeds = s.sequentialSeeds && batchCount > 1;
                const baseSeed = getBatchBaseSeed(s, batchCount, contextualApplied.seedOverride);
                for (let i = 0; i < batchCount; i++) {
                    checkAborted(cancelCheckpoint);
                    setGenerationSeedValue(s, useSequentialSeeds ? baseSeed + i : baseSeed);
                    showStatus(`🖼️ Generating palette-inject image ${i + 1}/${batchCount}...`);
                    const expandedPrompt = expandWildcards(prompt);
                    const expandedNegative = expandWildcards(negative);
                    const result = await generateForProvider(expandedPrompt, expandedNegative, s, currentAbortController?.signal);
                    if (result) {
                        const entry = await finalizeGeneratedEntry(result, expandedPrompt, expandedNegative, s, {
                            promptWasLLM: lastPromptWasLLM,
                            sourceMessageIndex: Number.isInteger(sourceMessageIndex) ? sourceMessageIndex : undefined,
                        });
                        if (entry) results.push(entry);
                    }
                }

                if (results.length > 0) {
                    await maybeAutoSetBackground(results, s);
                    if (results.length === 1) {
                        if (s.autoInsert) {
                            addToGallery(results[0]);
                            try {
                                await autoInsertInjectImage(results[0], {
                                    messageIndex: Number.isInteger(sourceMessageIndex) ? sourceMessageIndex : undefined,
                                    insertMode: s.insertAsHiddenReply ? "hidden" : s.injectInsertMode,
                                });
                            } catch (err) {
                                log(`Palette inject: Auto-insert failed: ${err.message}`);
                                displayImage(results[0]);
                            }
                        } else {
                            displayImage(results[0]);
                        }
                    } else {
                        displayBatchResults(results);
                    }
                    toastr.success(`Palette inject: ${results.length} image(s) generated`);
                }
            } finally {
                setGenerationSeedValue(s, originalSeed);
            }
        }
    } catch (e) {
        if (e.name === "AbortError") {
            log("Palette inject: Generation cancelled by user");
            toastr.info("Generation cancelled");
        } else {
            log(`Palette inject: Error: ${e.message}`);
            toastr.error("Palette inject failed: " + e.message, "", { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        }
    } finally {
        if (sourceInjectMessage && consumedMessagePrompts.size > 0) {
            try {
                const persisted = await persistConsumedInjectPrompts(sourceInjectMessage, [...consumedMessagePrompts], s);
                if (persisted.cleaned) {
                    log(`Palette inject: Consumed ${consumedMessagePrompts.size} tag(s) and cleaned them from the source message`);
                } else if (persisted.remembered) {
                    log(`Palette inject: Marked ${consumedMessagePrompts.size} source tag(s) as consumed`);
                }
            } catch (e) {
                log(`Palette inject: Failed to persist consumed tags: ${e.message}`);
            }
        }
        endGeneration({ disableGenerateButton: true });
        if (_paletteInjectSerial === mySerial) {
            _paletteInjectActive = false;
        }
        clearStyleCache();
        log("Palette inject: Cleared caches after generation");
    }
}

async function generateImageFromPlainDescription() {
    if (isGenerating) return;

    const request = await showPlainDescriptionDialog();
    if (!request) return;
    if (getSettings().confirmBeforeGenerate && !confirm("Generate image?")) return;

    beginGeneration({ disableGenerateButton: true, clearPendingAuto: true });
    const baseSettings = getSettings();
    const s = {
        ...baseSettings,
        useLastMessage: false,
        useLLMPrompt: true,
        llmPromptStyle: request.promptStyle || baseSettings.llmPromptStyle || "tags",
    };
    const cancelCheckpoint = getCancelCheckpoint();
    const originalSeed = getGenerationSeedValue(s);
    const basePrompt = request.description;

    try {
        checkAborted(cancelCheckpoint);
        lastGenerationSourceMessageIndex = null;
        lastProxyContextRefImages = [];
        log(`Plain description: Generating AI prompt from ${basePrompt.length} chars`);
        showStatus("🤖 Turning description into image prompt...");

        let prompt = await generateLLMPrompt(s, basePrompt, currentAbortController?.signal, {
            isMultiMessageScene: false,
        });
        checkAborted(cancelCheckpoint);
        lastPromptWasLLM = prompt !== basePrompt;

        if (request.editPrompt) {
            const editedPrompt = await showPromptEditDialog(prompt);
            if (editedPrompt !== null) {
                prompt = editedPrompt;
            } else {
                return;
            }
        }

        prompt = applyStyle(prompt, s);

        if (s.appendQuality && s.qualityTags) {
            prompt = `${s.qualityTags}, ${prompt}`;
        }
        let negative = resolvePrompt(s.negativePrompt);

        if (s.useSTStyle !== false) {
            const stStyle = getSTStyleSettings();
            if (stStyle.prefix) prompt = `${stStyle.prefix}, ${prompt}`;
            if (stStyle.charPositive) prompt = `${prompt}, ${stStyle.charPositive}`;
            if (stStyle.negative) negative = `${negative}, ${stStyle.negative}`;
            if (stStyle.charNegative) negative = `${negative}, ${stStyle.charNegative}`;
        }

        const contextualApplied = await applyResolvedContextualFilters(prompt, negative, {
            matchText: [basePrompt, prompt].filter(Boolean).join("\n\n"),
            llmSceneText: basePrompt,
            signal: currentAbortController?.signal,
        });
        checkAborted(cancelCheckpoint);
        prompt = contextualApplied.prompt;
        negative = contextualApplied.negative;

        lastPrompt = prompt;
        lastNegative = negative;
        promptHistory.unshift({ prompt, negative, time: new Date().toLocaleTimeString() });
        if (promptHistory.length > 50) promptHistory.pop();
        savePromptHistory();

        const batchCount = s.batchCount || 1;
        const results = [];
        const useSequentialSeeds = s.sequentialSeeds && batchCount > 1;
        const baseSeed = getBatchBaseSeed(s, batchCount, contextualApplied.seedOverride);

        log(`Plain description final prompt: ${prompt.substring(0, 100)}...`);
        for (let i = 0; i < batchCount; i++) {
            checkAborted(cancelCheckpoint);
            setGenerationSeedValue(s, useSequentialSeeds ? baseSeed + i : baseSeed);
            showStatus(`🖼️ Generating image ${i + 1}/${batchCount}...`);
            const expandedPrompt = expandWildcards(prompt);
            const expandedNegative = expandWildcards(negative);
            const result = await generateForProvider(expandedPrompt, expandedNegative, s, currentAbortController?.signal);
            if (result) {
                const entry = await finalizeGeneratedEntry(result, expandedPrompt, expandedNegative, s, {
                    promptWasLLM: lastPromptWasLLM,
                });
                if (entry) results.push(entry);
            }
        }

        if (results.length > 0) await maybeAutoSetBackground(results, s);

        if (results.length > 0 && s.autoInsert) {
            const ctx = getContext();
            const chat = ctx?.chat;
            const lastCharIdx = (() => {
                if (!chat) return undefined;
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i]?.is_user) return i;
                }
                return undefined;
            })();
            for (const r of results) {
                addToGallery(r);
                try {
                    if (s.insertAsHiddenReply) {
                        await insertImageAsHiddenReply(r);
                    } else {
                        await insertImageIntoMessage(r, lastCharIdx);
                    }
                } catch (err) {
                    console.error("[Quick Image Gen] Auto-insert failed:", err);
                }
            }
            toastr.success(`Image${results.length > 1 ? "s" : ""} inserted into chat`);
        } else if (results.length === 1) {
            displayImage(results[0]);
        } else if (results.length > 1) {
            displayBatchResults(results);
        }
    } catch (e) {
        if (e.name === "AbortError") {
            log("Plain description generation cancelled by user");
            toastr.info("Generation cancelled");
        } else {
            log(`Plain description error: ${e.message}`);
            toastr.error("Plain description generation failed: " + e.message, "", { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        }
    } finally {
        setGenerationSeedValue(s, originalSeed);
        endGeneration({ disableGenerateButton: true });
        clearStyleCache();
        log("Plain description: Cleared caches after generation");
    }
}

async function generateImage() {
    if (isGenerating) return;
    const usingTransientSettingsOverride = !!transientGenerationSettingsOverride;
    const s = getGenerationSettingsForRun();
    if (s.confirmBeforeGenerate && !confirm("Generate image?")) return;
    beginGeneration({ disableGenerateButton: true, clearPendingAuto: true });
    const cancelCheckpoint = getCancelCheckpoint();
    const originalSeed = getGenerationSeedValue(s);
    const ctx = getContext();
    const activeMessageTarget = getTransientGenerationTarget(ctx);
    const useChatMessageScene = shouldUseChatMessageScene(s);
    const selectedSceneEntries = useChatMessageScene ? getSceneMessageEntries(s, ctx) : [];
    const sceneSelectionMessageIndex = selectedSceneEntries.length > 0 && Number.isInteger(selectedSceneEntries[selectedSceneEntries.length - 1]?.index)
        ? selectedSceneEntries[selectedSceneEntries.length - 1].index
        : null;
    const sceneSelectionIsMultiMessage = selectedSceneEntries.length > 1;
    const sourceMessageIndexForEntries = Number.isInteger(activeMessageTarget?.messageIndex)
        ? activeMessageTarget.messageIndex
        : sceneSelectionMessageIndex;

    try {
    checkAborted(cancelCheckpoint);

    // DEFENSIVE FIX: Check if textarea has unsaved changes
    const promptEl = document.getElementById("qig-prompt");
    if (!usingTransientSettingsOverride && promptEl && promptEl.value !== s.prompt) {
        log(`[Prompt Fix] Textarea value differs from settings - using textarea value`);
        s.prompt = promptEl.value;
        saveSettingsDebounced();
    }

    let basePrompt = resolvePrompt(s.prompt);
    let scenePrompt = "";
    let chatContextProxyRefImages = [];

    lastGenerationSourceMessageIndex = Number.isInteger(sourceMessageIndexForEntries) ? sourceMessageIndexForEntries : null;

    if (Number.isInteger(sourceMessageIndexForEntries)) {
        log(`${Number.isInteger(activeMessageTarget?.messageIndex) ? "Manual message target" : "Scene selection target"}: Generating from chat message ${sourceMessageIndexForEntries}`);
    }

    if (useChatMessageScene) {
        const messages = getMessages(s, ctx, { logDebug: true });
        if (messages) {
            scenePrompt = messages;
            basePrompt = messages;
            if (s.enableParagraphPicker) {
                const filtered = await showParagraphPicker(messages);
                if (filtered === null) {
                    return; // finally block handles cleanup
                }
                scenePrompt = filtered;
                basePrompt = filtered;
            }
        }
    }

    if (s.provider === "proxy" && useChatMessageScene) {
        chatContextProxyRefImages = await collectChatContextProxyRefImages(s, ctx);
        checkAborted(cancelCheckpoint);
    }
    lastProxyContextRefImages = [...chatContextProxyRefImages];
    const providerRuntimeOptions = s.provider === "proxy"
        ? { proxyRefImages: chatContextProxyRefImages }
        : {};

    log(`Base prompt: ${basePrompt.substring(0, 100)}...`);
    const batchCount = s.batchCount || 1;
    showStatus(`🎨 Generating ${batchCount} image(s)...`);

    const originalLLMPromptSource = scenePrompt || basePrompt;
    let llmPromptSource = originalLLMPromptSource;
    let llmPromptSourceIsDescription = false;
    if (s.twoStepPrompt && s.useLLMPrompt && useChatMessageScene && scenePrompt) {
        const sceneDescription = await generateSceneDescription(s, scenePrompt, currentAbortController?.signal, {
            isMultiMessageScene: sceneSelectionIsMultiMessage,
        });
        checkAborted(cancelCheckpoint);
        if (sceneDescription) {
            llmPromptSource = sceneDescription;
            llmPromptSourceIsDescription = true;
            log("Two-step prompt pipeline: using generated scene description as prompt source");
        } else {
            log("Two-step prompt pipeline: scene description empty, falling back to selected scene");
        }
    }

    let prompt = await generateLLMPrompt(s, llmPromptSource, currentAbortController?.signal, {
        isMultiMessageScene: llmPromptSourceIsDescription ? false : sceneSelectionIsMultiMessage,
    });
    checkAborted(cancelCheckpoint);
    lastPromptWasLLM = (s.useLLMPrompt && (prompt !== originalLLMPromptSource || llmPromptSourceIsDescription));

    // Show prompt editing dialog if enabled
    if (s.useLLMPrompt && s.llmEditPrompt) {
        const editedPrompt = await showPromptEditDialog(prompt);
        if (editedPrompt !== null) {
            prompt = editedPrompt;
        } else {
            return; // finally block handles cleanup
        }
    }

    prompt = applyStyle(prompt, s);

    if (s.appendQuality && s.qualityTags) {
        prompt = `${s.qualityTags}, ${prompt}`;
    }
    let negative = resolvePrompt(s.negativePrompt);

    // Apply ST Style panel settings (prefix, char-specific, negative)
    if (s.useSTStyle !== false) {
        const stStyle = getSTStyleSettings();
        if (stStyle.prefix) prompt = `${stStyle.prefix}, ${prompt}`;
        if (stStyle.charPositive) prompt = `${prompt}, ${stStyle.charPositive}`;
        if (stStyle.negative) negative = `${negative}, ${stStyle.negative}`;
        if (stStyle.charNegative) negative = `${negative}, ${stStyle.charNegative}`;
    }

    const llmSceneText = scenePrompt || basePrompt;
    const filterMatchText = [llmSceneText, prompt].filter(Boolean).join("\n\n");
    const contextualApplied = await applyResolvedContextualFilters(prompt, negative, {
        matchText: filterMatchText || prompt,
        llmSceneText,
        signal: currentAbortController?.signal,
    });
    checkAborted(cancelCheckpoint);
    prompt = contextualApplied.prompt;
    negative = contextualApplied.negative;

    lastPrompt = prompt;
    lastNegative = negative;
    promptHistory.unshift({ prompt, negative, time: new Date().toLocaleTimeString() });
    if (promptHistory.length > 50) promptHistory.pop();
    savePromptHistory();

    log(`Final prompt: ${prompt.substring(0, 100)}...`);
    log(`Negative: ${negative.substring(0, 50)}...`);

            const results = [];
            log(`Using provider: ${s.provider}, batch: ${batchCount}`);
            const useSequentialSeeds = s.sequentialSeeds && batchCount > 1;
            const baseSeed = getBatchBaseSeed(s, batchCount, contextualApplied.seedOverride);
        for (let i = 0; i < batchCount; i++) {
            checkAborted(cancelCheckpoint);
            setGenerationSeedValue(s, useSequentialSeeds ? baseSeed + i : baseSeed);
                showStatus(`🖼️ Generating image ${i + 1}/${batchCount}...`);
                const expandedPrompt = expandWildcards(prompt);
                const expandedNegative = expandWildcards(negative);
                const result = await generateForProvider(expandedPrompt, expandedNegative, s, currentAbortController?.signal, providerRuntimeOptions);
                if (result) {
                    const entry = await finalizeGeneratedEntry(result, expandedPrompt, expandedNegative, s, {
                        promptWasLLM: lastPromptWasLLM,
                        sourceMessageIndex: Number.isInteger(sourceMessageIndexForEntries) ? sourceMessageIndexForEntries : undefined,
                    });
                    if (entry) results.push(entry);
                }
            }
            log(`Generated ${results.length} image(s) successfully`);
            await maybeAutoSetBackground(results, s);
            // Find last non-user message for insertion target
            const ctx2 = getContext();
            const lastCharIdx = (() => {
                const chat = ctx2.chat;
                if (!chat) return undefined;
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i]?.is_user) return i;
                }
                return undefined;
            })();
            if (s.autoInsert) {
                const autoInsertTarget = Number.isInteger(sourceMessageIndexForEntries) ? sourceMessageIndexForEntries : lastCharIdx;
                for (const r of results) {
                    addToGallery(r);
                    try {
                        if (s.insertAsHiddenReply) {
                            await insertImageAsHiddenReply(r);
                        } else if (shouldAutoInsertChatImageAsAssistant(s)) {
                            await insertImageAsNewMessage(r);
                        } else {
                            await insertImageIntoMessage(r, autoInsertTarget);
                        }
                    } catch (err) {
                        console.error("[Quick Image Gen] Auto-insert failed:", err);
                    }
                }
            toastr.success(`Image${results.length > 1 ? 's' : ''} inserted into chat`);
        } else if (results.length === 1) {
            displayImage(results[0]);
        } else {
            displayBatchResults(results);
        }
    } catch (e) {
        if (e.name === "AbortError") {
            log("Generation cancelled by user");
            toastr.info("Generation cancelled");
        } else {
            log(`Error: ${e.message}`);
            toastr.error("Generation failed: " + e.message, "", { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        }
    } finally {
        setGenerationSeedValue(s, originalSeed);
        endGeneration({ disableGenerateButton: true });
        // Clear caches after each generation to prevent reusing stale prompts
        clearStyleCache();
        log("Cleared all caches after generation");
    }
}


// === Inject Mode (AI-driven image generation via image tags) ===

function normalizeInjectPromptValue(prompt) {
    return typeof prompt === "string" ? prompt.trim() : "";
}

function getCapturedInjectPrompt(groups) {
    if (!Array.isArray(groups)) return "";
    const captured = groups.find(group => typeof group === "string" && group.trim() !== "");
    return captured ? captured.trim() : "";
}

function ensureMessageExtra(message) {
    if (!message || typeof message !== "object") return null;
    if (!message.extra || typeof message.extra !== "object") {
        message.extra = {};
    }
    return message.extra;
}

function hashString(input) {
    const text = String(input ?? "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function extractInjectMatchesFromText(text, regexPattern) {
    if (typeof text !== "string" || !text.trim()) return [];
    const regex = new RegExp(regexPattern, "gi");
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const captured = getCapturedInjectPrompt(match.slice(1));
        if (captured) matches.push(captured.trim());
        if (match[0] === "") regex.lastIndex++;
    }
    return matches;
}

function limitInjectFallbackMatches(matches, label = "Inject fallback") {
    const normalized = [...new Set((matches || []).map(prompt => String(prompt || "").trim()).filter(Boolean))];
    if (normalized.length <= 1) return normalized;
    log(`${label}: Helper returned ${normalized.length} image tag(s); using only the first to avoid multi-image bursts`);
    return normalized.slice(0, 1);
}

function getInjectCurrentSwipeText(message) {
    return getCurrentMessageSwipeText(message);
}

function getInjectMessageSources(message) {
    if (!message || typeof message !== "object") return [];

    const sources = [];
    const seenTexts = new Set();
    const pushSource = (key, label, text) => {
        if (typeof text !== "string") return;
        const trimmed = text.trim();
        if (!trimmed || seenTexts.has(trimmed)) return;
        seenTexts.add(trimmed);
        sources.push({ key, label, text });
    };

    pushSource("extra.display_text", "display text", message?.extra?.display_text);
    pushSource("mes", "message", message?.mes);
    pushSource("swipes.current", "current swipe", getInjectCurrentSwipeText(message));
    pushSource("extra.reasoning_display_text", "reasoning display", message?.extra?.reasoning_display_text);
    pushSource("extra.reasoning", "reasoning", message?.extra?.reasoning);

    return sources;
}

function getInjectConsumptionSignature(message, settings = getSettings()) {
    const sources = getInjectMessageSources(message);
    const signaturePayload = JSON.stringify({
        regexPattern: getInjectRegexPattern(settings),
        swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
        // Use content hashes instead of full text to survive normalization during chat reload
        sourceHashes: sources.map(source => [source.key, hashString(source.text || '')]),
    });
    return hashString(signaturePayload);
}

function getConsumedInjectPromptSet(message, settings = getSettings()) {
    if (!message || typeof message !== "object") return new Set();
    const signature = getInjectConsumptionSignature(message, settings);
    const stored = message?.extra?.[INJECT_CONSUMED_EXTRA_KEY];
    if (stored?.signature !== signature || !Array.isArray(stored?.prompts)) {
        return new Set();
    }
    return new Set(stored.prompts.map(normalizeInjectPromptValue).filter(Boolean));
}

function filterConsumedInjectPrompts(prompts, message, settings = getSettings()) {
    if (!Array.isArray(prompts)) return [];
    const consumed = getConsumedInjectPromptSet(message, settings);
    return prompts
        .map(normalizeInjectPromptValue)
        .filter(prompt => prompt && !consumed.has(prompt));
}

function rememberConsumedInjectPrompts(message, prompts, settings = getSettings()) {
    if (!message || typeof message !== "object") return false;
    const normalizedPrompts = [...new Set((prompts || []).map(normalizeInjectPromptValue).filter(Boolean))];
    if (normalizedPrompts.length === 0) return false;

    const extra = ensureMessageExtra(message);
    if (!extra) return false;

    const signature = getInjectConsumptionSignature(message, settings);
    const existingPrompts = extra[INJECT_CONSUMED_EXTRA_KEY]?.signature === signature && Array.isArray(extra[INJECT_CONSUMED_EXTRA_KEY]?.prompts)
        ? extra[INJECT_CONSUMED_EXTRA_KEY].prompts.map(normalizeInjectPromptValue).filter(Boolean)
        : [];
    const promptSet = new Set(existingPrompts);
    let changed = false;

    for (const prompt of normalizedPrompts) {
        if (!promptSet.has(prompt)) {
            promptSet.add(prompt);
            changed = true;
        }
    }

    if (!changed) return false;
    extra[INJECT_CONSUMED_EXTRA_KEY] = {
        signature,
        prompts: [...promptSet],
    };
    return true;
}

function stripInjectTagsFromText(text, regexPattern, promptsToRemove = null) {
    if (typeof text !== "string" || !text.trim()) return text;

    const targetPrompts = Array.isArray(promptsToRemove)
        ? new Set(promptsToRemove.map(normalizeInjectPromptValue).filter(Boolean))
        : null;
    if (targetPrompts && targetPrompts.size === 0) return text;

    return text.replace(new RegExp(regexPattern, "gi"), (...args) => {
        if (!targetPrompts) return "";
        const tailSize = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null ? 3 : 2;
        const captured = getCapturedInjectPrompt(args.slice(1, args.length - tailSize));
        return captured && targetPrompts.has(captured) ? "" : args[0];
    }).trim();
}

async function persistConsumedInjectPrompts(message, prompts, settings = getSettings()) {
    if (!message || typeof message !== "object") {
        return { remembered: false, cleaned: false };
    }

    const normalizedPrompts = [...new Set((prompts || []).map(normalizeInjectPromptValue).filter(Boolean))];
    if (normalizedPrompts.length === 0) {
        return { remembered: false, cleaned: false };
    }

    const remembered = rememberConsumedInjectPrompts(message, normalizedPrompts, settings);
    const cleaned = settings.injectAutoClean !== false
        ? cleanInjectTagsFromMessage(message, getInjectRegexPattern(settings), normalizedPrompts)
        : false;

    if (!remembered && !cleaned) {
        return { remembered, cleaned };
    }

    const ctx = getContext();
    if (typeof ctx?.saveChat === "function") {
        await ctx.saveChat();
    }
    if (cleaned && typeof ctx?.reloadCurrentChat === "function") {
        // Defer reload to prevent re-triggering MESSAGE_RECEIVED during processing
        setTimeout(() => ctx.reloadCurrentChat(), 0);
    }

    return { remembered, cleaned };
}

function extractInjectPromptsFromMessage(message, settings = getSettings()) {
    const regexPattern = getInjectRegexPattern(settings);
    const sources = getInjectMessageSources(message);
    const promptMap = new Map();
    const matches = [];

    for (const source of sources) {
        for (const prompt of extractInjectMatchesFromText(source.text, regexPattern)) {
            if (!promptMap.has(prompt)) {
                const entry = { prompt, sources: [source.label] };
                promptMap.set(prompt, entry);
                matches.push(entry);
            } else if (!promptMap.get(prompt).sources.includes(source.label)) {
                promptMap.get(prompt).sources.push(source.label);
            }
        }
    }

    return {
        matches,
        regexPattern,
        sources,
        scannedSources: sources.map(source => source.label),
    };
}

function findLastAssistantMessage(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message?.is_user) continue;
        if (getInjectMessageSources(message).length > 0) {
            return { message, index: i };
        }
    }
    return null;
}

function findLastInjectCandidateMessage(chat, settings = getSettings(), { requireMatches = false, includeConsumed = true } = {}) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message?.is_user) continue;
        let detection;
        try {
            detection = extractInjectPromptsFromMessage(message, settings);
        } catch {
            if (requireMatches) continue;
            const sources = getInjectMessageSources(message);
            if (sources.length > 0) return { message, index: i, detection: null, detectedPrompts: [], prompts: [] };
            continue;
        }
        const detectedPrompts = detection.matches.map(match => match.prompt);
        const prompts = includeConsumed ? detectedPrompts : filterConsumedInjectPrompts(detectedPrompts, message, settings);
        if (prompts.length > 0 || (!requireMatches && detection.sources.length > 0)) {
            return { message, index: i, detection, detectedPrompts, prompts };
        }
    }
    return null;
}

function hasUserMessageAfterIndex(chat, index) {
    if (!Array.isArray(chat) || !Number.isInteger(index)) return false;
    for (let i = index + 1; i < chat.length; i++) {
        if (chat[i]?.is_user) return true;
    }
    return false;
}

function resolveInjectTargetMessage(chat, preferredIndex = null) {
    if (!Array.isArray(chat) || chat.length === 0) return null;

    const explicitIndex = clampChatMessageIndex(preferredIndex, chat.length);
    const explicitMessage = Number.isInteger(explicitIndex) ? chat[explicitIndex] : null;

    if (explicitMessage && !explicitMessage.is_user) {
        return { message: explicitMessage, index: explicitIndex };
    }
    if (Number.isInteger(explicitIndex)) {
        return null;
    }

    return findLastInjectCandidateMessage(chat, getSettings(), { requireMatches: true, includeConsumed: false })
        || findLastInjectCandidateMessage(chat, getSettings(), { requireMatches: true, includeConsumed: true })
        || findLastAssistantMessage(chat);
}

function cleanInjectTagsFromMessage(message, regexPattern, promptsToRemove = null) {
    if (!message || typeof message !== "object") return false;

    let changed = false;
    const replaceInField = (holder, key) => {
        if (!holder || typeof holder[key] !== "string" || !holder[key].trim()) return;
        const nextValue = stripInjectTagsFromText(holder[key], regexPattern, promptsToRemove);
        if (nextValue !== holder[key]) {
            holder[key] = nextValue;
            changed = true;
        }
    };

    replaceInField(message, "mes");
    replaceInField(message?.extra, "display_text");
    replaceInField(message?.extra, "reasoning_display_text");
    replaceInField(message?.extra, "reasoning");

    if (Array.isArray(message.swipes)) {
        const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
        if (typeof message.swipes[swipeId] === "string") {
            const nextValue = stripInjectTagsFromText(message.swipes[swipeId], regexPattern, promptsToRemove);
            if (nextValue !== message.swipes[swipeId]) {
                message.swipes[swipeId] = nextValue;
                changed = true;
            }
        }
    }

    return changed;
}

function onChatCompletionPromptReady(eventData) {
    if (isGenerating) return; // Don't inject into our own internal LLM calls
    const s = getSettings();
    if (!s.injectEnabled || !s.autoGenerate) return;

    const promptText = resolvePrompt(getInjectPromptTemplate(s));
    const position = s.injectPosition || "afterScenario";
    const depth = s.injectDepth || 0;

    try {
        // eventData is the prompt array (array of {role, content} objects)
        const prompts = Array.isArray(eventData) ? eventData : eventData?.chat;
        if (!prompts || !Array.isArray(prompts)) {
            log("Inject: Could not find prompt array in event data");
            return;
        }

        const injectMsg = { role: "system", content: promptText };

        if (position === "afterScenario") {
            // Insert after the first system message (scenario)
            const firstSystemEnd = prompts.findIndex((m, i) => i > 0 && m.role !== "system");
            if (firstSystemEnd > 0) {
                prompts.splice(firstSystemEnd, 0, injectMsg);
            } else {
                prompts.push(injectMsg);
            }
        } else if (position === "inUser") {
            // Insert as system message before the last user message
            for (let i = prompts.length - 1; i >= 0; i--) {
                if (prompts[i].role === "user") {
                    prompts.splice(i, 0, injectMsg);
                    break;
                }
            }
        } else if (position === "atDepth") {
            // Insert at specific depth from the end
            const insertIdx = Math.max(0, prompts.length - depth);
            prompts.splice(insertIdx, 0, injectMsg);
        }

        log(`Inject: Injected prompt at position '${position}'${position === "atDepth" ? ` depth ${depth}` : ""}`);
    } catch (e) {
        log(`Inject: Error injecting prompt: ${e.message}`);
    }
}

async function processInjectMessage(messageText, messageIndex) {
    const cancelCheckpoint = getCancelCheckpoint();
    const shouldReleaseIndex = messageIndex !== undefined;
    let startedGeneration = false;
    let s;
    let sourceMessage = null;
    let sourceMessageIndex = null;
    const consumedMessagePrompts = new Set();

    try {
        _injectProcessingCount++;
        s = getSettings();
        if (!s.injectEnabled) return;

        const ctx = getContext();
        const chat = ctx?.chat;
        const resolvedTarget = resolveInjectTargetMessage(chat, messageIndex);
        const idx = Number.isInteger(resolvedTarget?.index)
            ? resolvedTarget.index
            : (typeof messageIndex === "number" ? messageIndex : (chat ? chat.length - 1 : -1));
        const message = resolvedTarget?.message || (idx >= 0 ? chat?.[idx] : (typeof messageText === "string" ? { mes: messageText } : null));
        if (!message) return;
        sourceMessageIndex = Number.isInteger(resolvedTarget?.index) ? resolvedTarget.index : (idx >= 0 && chat?.[idx] ? idx : null);
        sourceMessage = Number.isInteger(sourceMessageIndex) ? chat?.[sourceMessageIndex] : null;
        lastGenerationSourceMessageIndex = Number.isInteger(sourceMessageIndex) ? sourceMessageIndex : null;

        let detection;
        let matches;
        try {
            // Try extracting from the raw text captured at event time (before ST regex processing)
            const rawMatches = extractInjectMatchesFromText(messageText, getInjectRegexPattern(s));
            if (rawMatches.length > 0) {
                // Use raw text matches — ST regex may have already cleaned the message object
                matches = [...new Set(rawMatches)];
            } else {
                // Fall back to multi-source extraction from the message object
                detection = extractInjectPromptsFromMessage(message, s);
                matches = detection.matches.map(match => match.prompt);
            }
            const unconsumedMatches = filterConsumedInjectPrompts(matches, sourceMessage || message, s);
            const skippedConsumed = matches.length - unconsumedMatches.length;
            matches = unconsumedMatches;
            if (skippedConsumed > 0) {
                log(`Inject: Skipping ${skippedConsumed} previously consumed tag(s) from source message`);
            }
        } catch (e) {
            log(`Inject: Invalid regex: ${e.message}`);
            return;
        }

        if (matches.length === 0) return;

        const sourceSummary = detection ? (detection.scannedSources.join(", ") || "message") : "raw message text";
        log(`Inject: Found ${matches.length} image tag(s) in ${sourceSummary}`);

        // Begin generation once for all tags
        checkAborted(cancelCheckpoint);
        if (isGenerating) {
            log("Inject: Waiting for current generation to finish...");
            await new Promise((resolve, reject) => {
                let elapsed = 0;
                const check = setInterval(() => {
                    elapsed += 500;
                    if (!isGenerating) { clearInterval(check); resolve(); }
                    else if (wasCancelRequestedSince(cancelCheckpoint)) {
                        clearInterval(check);
                        reject(new DOMException("Generation cancelled by user", "AbortError"));
                    }
                    else if (elapsed >= 60000) { clearInterval(check); reject(new Error("Timed out waiting for generation")); }
                }, 500);
            });
        }
        checkAborted(cancelCheckpoint);
        beginGeneration();
        startedGeneration = true;

        // Generate images for each extracted prompt
        const sceneTextForFilters = getMessages() || "";
        for (const extractedPrompt of matches) {
            const originalSeed = getGenerationSeedValue(s);
            try {
                checkAborted(cancelCheckpoint);
                log(`Inject: Generating image for: ${extractedPrompt.substring(0, 80)}...`);
                showStatus("🖼️ Generating inject-mode image...");

                let prompt = await generateLLMPrompt(s, extractedPrompt, currentAbortController?.signal);
                checkAborted(cancelCheckpoint);

                // Show prompt editing dialog if enabled
                if (s.useLLMPrompt && s.llmEditPrompt && prompt !== extractedPrompt) {
                    const editedPrompt = await showPromptEditDialog(prompt);
                    if (editedPrompt !== null) {
                        prompt = editedPrompt;
                    } else {
                        continue;
                    }
                }
                if (sourceMessage) {
                    consumedMessagePrompts.add(extractedPrompt);
                }

                let negative = resolvePrompt(s.negativePrompt);

                // Apply style
                prompt = applyStyle(prompt, s);

                // Apply quality tags
                if (s.appendQuality && s.qualityTags) {
                    prompt = `${s.qualityTags}, ${prompt}`;
                }

                // Apply ST Style
                if (s.useSTStyle !== false) {
                    const stStyle = getSTStyleSettings();
                    if (stStyle.prefix) prompt = `${stStyle.prefix}, ${prompt}`;
                    if (stStyle.charPositive) prompt = `${prompt}, ${stStyle.charPositive}`;
                    if (stStyle.negative) negative = `${negative}, ${stStyle.negative}`;
                    if (stStyle.charNegative) negative = `${negative}, ${stStyle.charNegative}`;
                }

                const contextualApplied = await applyResolvedContextualFilters(prompt, negative, {
                    matchText: sceneTextForFilters || prompt,
                    llmSceneText: sceneTextForFilters || extractedPrompt,
                    signal: currentAbortController?.signal,
                });
                checkAborted(cancelCheckpoint);
                prompt = contextualApplied.prompt;
                negative = contextualApplied.negative;

                lastPrompt = prompt;
                lastNegative = negative;
                lastPromptWasLLM = (s.useLLMPrompt && prompt !== extractedPrompt);
                lastProxyContextRefImages = [];

                const batchCount = s.batchCount || 1;
                const results = [];
                const useSequentialSeeds = s.sequentialSeeds && batchCount > 1;
                const baseSeed = getBatchBaseSeed(s, batchCount, contextualApplied.seedOverride);
                for (let i = 0; i < batchCount; i++) {
                    checkAborted(cancelCheckpoint);
                    setGenerationSeedValue(s, useSequentialSeeds ? baseSeed + i : baseSeed);
                    showStatus(`🖼️ Generating inject image ${i + 1}/${batchCount}...`);
                    const expandedPrompt = expandWildcards(prompt);
                    const expandedNegative = expandWildcards(negative);
                    const result = await generateForProvider(expandedPrompt, expandedNegative, s, currentAbortController?.signal);
                    if (result) {
                        const entry = await finalizeGeneratedEntry(result, expandedPrompt, expandedNegative, s, {
                            promptWasLLM: lastPromptWasLLM,
                            sourceMessageIndex: Number.isInteger(sourceMessageIndex) ? sourceMessageIndex : undefined,
                        });
                        if (entry) results.push(entry);
                    }
                }
                setGenerationSeedValue(s, originalSeed);

                if (results.length > 0) {
                    await maybeAutoSetBackground(results, s);
                    if (results.length === 1) {
                        if (s.autoInsert) {
                            addToGallery(results[0]);
                            try {
                                await autoInsertInjectImage(results[0], {
                                    messageIndex: sourceMessageIndex,
                                    insertMode: s.injectInsertMode,
                                });
                            } catch (err) {
                                log(`Inject: Auto-insert failed: ${err.message}`);
                                displayImage(results[0]);
                            }
                        } else {
                            displayImage(results[0]);
                        }
                    } else {
                        // Always show batch picker for multiple images
                        displayBatchResults(results);
                    }
                    toastr.success(`Inject mode: ${results.length} image(s) generated`);
                }
            } catch (e) {
                if (e.name === "AbortError") {
                    log("Inject: Generation cancelled by user");
                    toastr.info("Generation cancelled");
                    break; // Exit the entire match loop on cancel
                } else {
                    log(`Inject: Generation error: ${e.message}`);
                    toastr.error("Inject generation failed: " + e.message, "", { timeOut: 0, extendedTimeOut: 0, closeButton: true });
                }
            } finally {
                setGenerationSeedValue(s, originalSeed);
            }
        }
    } finally {
        if (s && sourceMessage && consumedMessagePrompts.size > 0) {
            try {
                const persisted = await persistConsumedInjectPrompts(sourceMessage, [...consumedMessagePrompts], s);
                if (persisted.cleaned) {
                    log(`Inject: Consumed ${consumedMessagePrompts.size} tag(s) and cleaned them from the source message`);
                } else if (persisted.remembered) {
                    log(`Inject: Marked ${consumedMessagePrompts.size} source tag(s) as consumed`);
                }
            } catch (e) {
                log(`Inject: Failed to persist consumed tags: ${e.message}`);
            }
        }
        _injectProcessingCount--;
        // End generation once after all tags
        if (startedGeneration || cancelRequested) endGeneration();
        // Expire this index after a delay so future messages at the same index can be processed,
        // even when returning early (invalid regex, no matches, disabled mode, etc).
        if (shouldReleaseIndex) {
            setTimeout(() => _processedInjectIndices.delete(messageIndex), 120000);
        }
    }
}

function stringifySlashCommandArgument(value) {
    if (Array.isArray(value)) return value.map(part => String(part ?? "")).join(" ").trim();
    return String(value ?? "").trim();
}

function hasSlashNamedArgument(args, key) {
    return !!args && Object.prototype.hasOwnProperty.call(args, key);
}

function parseSlashBoolean(value, currentValue = false) {
    const text = stringifySlashCommandArgument(value).toLowerCase();
    if (["true", "on", "1", "yes", "enable", "enabled"].includes(text)) return true;
    if (["false", "off", "0", "no", "disable", "disabled"].includes(text)) return false;
    if (text === "toggle") return !currentValue;
    return null;
}

function normalizeSlashGenerationMode(value) {
    const mode = stringifySlashCommandArgument(value).toLowerCase();
    return ["palette", "direct", "inject"].includes(mode) ? mode : "palette";
}

function getQigAutoStatus(settings = getSettings()) {
    const s = normalizeAutoGenerateSettings(settings);
    const every = s?.autoGenerateEveryMessages ?? AUTO_GENERATE_EVERY_DEFAULT;
    const delay = s?.autoGenerateDelayMs ?? AUTO_GENERATE_DELAY_DEFAULT;
    return `QIG auto: ${s?.autoGenerate ? "on" : "off"}, every ${every} AI ${every === 1 ? "reply" : "replies"}, ${delay}ms delay.`;
}

async function runQigSlashGenerateCommand(args = {}, unnamedPrompt = "") {
    if (isGenerating) return "QIG: generation is already running.";

    const mode = normalizeSlashGenerationMode(args?.mode);
    const oneOffPrompt = stringifySlashCommandArgument(unnamedPrompt);
    const runGeneration = async () => {
        if (mode === "inject") return await generateImageInjectPalette();
        if (mode === "direct" || oneOffPrompt) return await generateImage();
        return await runConfiguredPaletteGeneration();
    };

    try {
        if (oneOffPrompt && mode !== "inject") {
            await withTransientGenerationSettings({ prompt: oneOffPrompt, useLastMessage: false }, runGeneration);
        } else {
            await runGeneration();
        }
        return "QIG: generation complete.";
    } catch (e) {
        const message = e?.message || String(e);
        log(`Slash command generation failed: ${message}`);
        toastr?.error?.("Quick Image Gen failed: " + message);
        return "QIG failed: " + message;
    }
}

function runQigAutoSlashCommand(args = {}) {
    const s = getSettings();
    let changed = false;

    if (hasSlashNamedArgument(args, "state")) {
        const nextState = parseSlashBoolean(args.state, !!s.autoGenerate);
        if (nextState === null) return "QIG auto: state must be true, false, on, off, or toggle.";
        if (s.autoGenerate !== nextState) changed = true;
        setAutoGenerateEnabled(nextState);
    }

    if (hasSlashNamedArgument(args, "every")) {
        const rawEvery = stringifySlashCommandArgument(args.every);
        const numericEvery = Number(rawEvery);
        if (!Number.isFinite(numericEvery)) return "QIG auto: every must be a number.";
        const nextEvery = normalizeAutoGenerateEveryMessages(numericEvery);
        if (s.autoGenerateEveryMessages !== nextEvery) {
            s.autoGenerateEveryMessages = nextEvery;
            changed = true;
            resetAutoGenerateCadence({ clearTimer: true });
        }
    }

    if (hasSlashNamedArgument(args, "delay")) {
        const rawDelay = stringifySlashCommandArgument(args.delay);
        const numericDelay = Number(rawDelay);
        if (!Number.isFinite(numericDelay)) return "QIG auto: delay must be a number of milliseconds.";
        const nextDelay = normalizeAutoGenerateDelayMs(numericDelay);
        if (s.autoGenerateDelayMs !== nextDelay) {
            s.autoGenerateDelayMs = nextDelay;
            changed = true;
            resetAutoGenerateCadence({ clearTimer: true });
        }
    }

    normalizeAutoGenerateSettings(s);
    syncAutoGenerateControls(s);
    if (changed) saveSettingsDebounced();
    return getQigAutoStatus(s);
}

function runQigCancelSlashCommand() {
    if (requestGenerationCancel()) return "QIG: cancellation requested.";
    return "QIG: no active generation.";
}

async function registerQigSlashCommands() {
    if (qigSlashCommandsRegistered) return;

    try {
        const [commandModule, parserModule, argumentModule, enumModule] = await Promise.all([
            import("../../../slash-commands/SlashCommand.js"),
            import("../../../slash-commands/SlashCommandParser.js"),
            import("../../../slash-commands/SlashCommandArgument.js"),
            import("../../../slash-commands/SlashCommandEnumValue.js"),
        ]);
        const { SlashCommand } = commandModule;
        const { SlashCommandParser } = parserModule;
        const { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = argumentModule;
        const { SlashCommandEnumValue } = enumModule;
        const modeEnums = ["palette", "direct", "inject"].map(value => new SlashCommandEnumValue(value));
        const stateEnums = ["true", "false", "on", "off", "toggle"].map(value => new SlashCommandEnumValue(value));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: "qig",
            aliases: ["qig-generate", "quick-image-gen"],
            returns: "Quick Image Gen status text",
            callback: runQigSlashGenerateCommand,
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: "mode",
                    description: "generation mode: palette uses the configured palette-button mode, direct runs normal generation, inject extracts image tags",
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: modeEnums,
                    defaultValue: "palette",
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: "optional one-off direct prompt",
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    acceptsMultiple: true,
                }),
            ],
            helpString: `<div>Generate with Quick Image Gen. Examples: <code>/qig</code>, <code>/qig mode=direct portrait of {{char}}</code>, <code>/qig mode=inject</code>.</div>`,
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: "qig-auto",
            returns: "current Quick Image Gen auto-generation status",
            callback: runQigAutoSlashCommand,
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: "state",
                    description: "enable, disable, or toggle auto-generation",
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: stateEnums,
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "every",
                    description: `generate after every N eligible AI replies (${AUTO_GENERATE_EVERY_MIN}-${AUTO_GENERATE_EVERY_MAX})`,
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "delay",
                    description: `delay after the triggering AI reply in milliseconds (${AUTO_GENERATE_DELAY_MIN}-${AUTO_GENERATE_DELAY_MAX})`,
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    isRequired: false,
                }),
            ],
            helpString: `<div>Get or set Quick Image Gen auto-generation. Examples: <code>/qig-auto</code>, <code>/qig-auto state=on every=3 delay=1000</code>, <code>/qig-auto state=toggle</code>.</div>`,
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: "qig-cancel",
            aliases: ["qig-stop"],
            returns: "cancellation status",
            callback: runQigCancelSlashCommand,
            helpString: `<div>Cancel the active Quick Image Gen request.</div>`,
        }));

        qigSlashCommandsRegistered = true;
        log("Registered Quick Image Gen slash commands");
    } catch (e) {
        console.warn("[Quick Image Gen] Could not register slash commands:", e);
    }
}


jQuery(function () {
    // Non-blocking async initialization
    (async () => {
        try {
            const extensionsModule = await import("../../extensions.js");
            const scriptModule = await import("../../../script.js");
            extension_settings = extensionsModule.extension_settings;
            getContext = extensionsModule.getContext;
            saveSettingsDebounced = scriptModule.saveSettingsDebounced;
            saveSettings = scriptModule.saveSettings;
            generateQuietPrompt = scriptModule.generateQuietPrompt;
            generateRaw = scriptModule.generateRaw;
            generateRawData = scriptModule.generateRawData;
            createRawPrompt = scriptModule.createRawPrompt;
            getRequestHeaders = scriptModule.getRequestHeaders;

            try {
                const openAICompatModule = await import("../../openai.js");
                createGenerationParameters = openAICompatModule.createGenerationParameters;
                getChatCompletionModel = openAICompatModule.getChatCompletionModel;
            } catch (e) {
                console.warn("[ImageGen] Could not import OpenAI helpers:", e.message);
            }

            try {
                const utilsModule = await import("../../utils.js");
                saveBase64AsFile = utilsModule.saveBase64AsFile;
                getSanitizedFilename = utilsModule.getSanitizedFilename;
            } catch (e) {
                console.warn("[ImageGen] Could not import utils module:", e.message);
            }

            try {
                const rossModule = await import("../../RossAscends-mods.js");
                humanizedDateTime = rossModule.humanizedDateTime;
            } catch (e) {
                console.warn("[ImageGen] Could not import RossAscends-mods:", e.message);
            }

            try {
                const secretsModule = await import("../../secrets.js");
                secret_state = secretsModule.secret_state;
                rotateSecret = secretsModule.rotateSecret;
            } catch (e) {
                console.warn("[ImageGen] Could not import secrets module:", e.message);
            }

            await loadSettings();
            createUI();
            addInputButton();
            bindMessageGenerateActionClicks();
            initMessageGenerateActionObserver();
            await registerQigSlashCommands();
            loadCharSettings();

            // Populate LLM override dropdowns if enabled
            const initSettings = getSettings();
            if (initSettings.llmOverrideEnabled) {
                populateConnectionProfiles("qig-llm-override-profile", initSettings.llmOverrideProfileId);
                populatePresetList("qig-llm-override-preset-select", initSettings.llmOverridePreset);
            }

            const { eventSource, event_types } = scriptModule;
            if (eventSource) {
                eventSource.on(event_types.MESSAGE_RECEIVED, (messageIndex) => {
                    scheduleRefreshMessageGenerateActions();
                    if (shouldSuppressAutoGenerateFromInternalLLM(messageIndex)) return;
                    if (_paletteInjectActive || _injectProcessingCount > 0) return;
                    const s = getSettings();
                    if (!s.autoGenerate) return;
                    normalizeAutoGenerateSettings(s);
                    const ctx = getContext();
                    const chat = ctx?.chat;
                    const preferredIdx = typeof messageIndex === "number" ? messageIndex : (chat ? chat.length - 1 : -1);
                    const idx = clampChatMessageIndex(preferredIdx, Array.isArray(chat) ? chat.length : 0);
                    if (!Number.isInteger(idx) || idx < 0) return;
                    const msg = chat?.[idx];
                    if (!msg || msg.is_user || msg.extra?.inline_image) return;
                    if (s.injectEnabled && _processedInjectIndices.has(idx)) return;
                    if (!s.injectEnabled && isGenerating) return;
                    if (!shouldRunAutoGenerateForEligibleMessage(idx, s)) return;
                    const delayMs = normalizeAutoGenerateDelayMs(s.autoGenerateDelayMs);
                    // Inject mode: extract image tags from AI response/reasoning
                    // Checked first — if active, skip autoGenerate to prevent double generation
                    if (s.injectEnabled) {
                        _processedInjectIndices.add(idx);
                        const timeoutId = setTimeout(() => {
                            _autoInjectTimeouts.delete(timeoutId);
                            processInjectMessage(msg.mes || "", idx);
                        }, delayMs);
                        _autoInjectTimeouts.add(timeoutId);
                        return;
                    }
                    // Auto-generate mode (debounced — only one pending timeout at a time)
                    clearPendingAutoGenerateTimer();
                    _autoGenTimeout = setTimeout(() => {
                        _autoGenTimeout = null;
                        if (!isGenerating) generateImage();
                    }, delayMs);
                });
                // Inject mode: inject prompt into chat completion
                if (event_types.CHAT_COMPLETION_PROMPT_READY) {
                    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
                }
                eventSource.on(event_types.CHAT_CHANGED, () => {
                    closePalettePresetMenu();
                    scheduleRefreshMessageGenerateActions();
                    resetAutoGenerateCadence({ clearTimer: true });
                    if (_injectProcessingCount <= 0) {
                        _processedInjectIndices.clear();
                    }
                    loadCharSettings();
                    renderContextualFilters();
                });
            }
        } catch (err) {
            console.error("[Quick Image Gen] Initialization failed:", err);
        }
    })();
});


let _saveToServerToastTs = 0;
function warnSaveToServer(msg) {
    log(msg);
    if (typeof toastr !== "undefined") {
        const now = Date.now();
        if (now - _saveToServerToastTs > 4000) {
            toastr.warning(msg);
            _saveToServerToastTs = now;
        }
    }
}

function getProviderModelId(settings, provider = settings?.provider) {
    switch (provider) {
        case "pollinations": return settings?.pollinationsModel || "flux";
        case "novelai": return settings?.naiModel || null;
        case "gptimage": return settings?.gptImageModel || null;
        case "arliai": return settings?.arliModel || null;
        case "routeway": return settings?.routewayModel || null;
        case "navy": return settings?.navyModel || null;
        case "nanogpt": return settings?.nanogptModel || null;
        case "chutes": return settings?.chutesModel || null;
        case "civitai": return settings?.civitaiModel || null;
        case "nanobanana": return settings?.nanobananaModel || null;
        case "stability": return "stable-diffusion-xl-1024-v1-0";
        case "replicate": return settings?.replicateModel || null;
        case "fal": return settings?.falModel || null;
        case "together": return settings?.togetherModel || null;
        case "local": return settings?.localType === "a1111" ? (settings?.a1111Model || settings?.localModel || null) : (settings?.localModel || null);
        case "proxy": return settings?.proxyModel || null;
        default: return null;
    }
}

function getMetadataSettings(s, options = {}) {
    const provider = options.provider || s.provider;
    const isProxy = provider === "proxy";
    const currentSeed = provider === "gptimage" ? undefined : (isProxy ? (s.proxySeed ?? s.seed) : s.seed);
    const seed = Number.isFinite(options.resolvedSeed)
        ? options.resolvedSeed
        : (Number.isFinite(currentSeed) && currentSeed >= 0 ? currentSeed : undefined);

    const metadata = {
        steps: isProxy ? (s.proxySteps ?? s.steps) : s.steps,
        sampler: isProxy ? (s.proxySampler || s.sampler) : s.sampler,
        cfgScale: isProxy ? (s.proxyCfg ?? s.cfgScale) : s.cfgScale,
        seed,
        width: s.width,
        height: s.height,
        provider,
        model: getProviderModelId(s, provider),
        saveToServer: s.saveToServer,
        saveToServerEmbedMetadata: s.saveToServerEmbedMetadata,
    };

    if (provider === "local") {
        metadata.backend = s.localType || "a1111";
        metadata.scheduler = s.localType === "a1111" ? s.a1111Scheduler : (s.comfyScheduler || undefined);
    } else if (provider === "civitai") {
        metadata.scheduler = s.civitaiScheduler || undefined;
    } else if (provider === "proxy" && s.proxyComfyMode) {
        metadata.backend = "comfyui";
    }

    return metadata;
}

function getServerSubfolder() {
    try {
        const ctx = getContext?.();
        if (!ctx) return "QuickImageGen";
        if (ctx.groupId) {
            const groupKey = Object.keys(ctx.groups || {}).find(k => ctx.groups[k]?.id === ctx.groupId);
            const groupId = groupKey ? ctx.groups[groupKey]?.id : null;
            if (groupId != null) return String(groupId);
        }
        const name = ctx.characters?.[ctx.characterId]?.name;
        if (name) return name;
    } catch (e) {
        log(`SaveToServer: Failed to resolve subfolder: ${e.message}`);
    }
    return "QuickImageGen";
}

async function fetchImageBuffer(url) {
    const isDataLike = url.startsWith("data:") || url.startsWith("blob:");
    const res = isDataLike ? await fetch(url) : await corsFetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
    const contentType = res.headers.get("content-type") || "";
    const buffer = await res.arrayBuffer();
    return { buffer, contentType };
}

function detectImageFormat(buffer, contentType = "", url = "") {
    const bytes = new Uint8Array(buffer);
    const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    if (isPng) return { ext: "png", mime: "image/png", isPng: true };
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    if (isJpeg) return { ext: "jpg", mime: "image/jpeg", isPng: false };
    const isWebp = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (isWebp) return { ext: "webp", mime: "image/webp", isPng: false };
    const isGif = bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
    if (isGif) return { ext: "gif", mime: "image/gif", isPng: false };
    const ct = contentType.toLowerCase();
    if (ct.includes("png")) return { ext: "png", mime: "image/png", isPng: true };
    if (ct.includes("webp")) return { ext: "webp", mime: "image/webp", isPng: false };
    if (ct.includes("jpeg") || ct.includes("jpg")) return { ext: "jpg", mime: "image/jpeg", isPng: false };
    if (ct.includes("gif")) return { ext: "gif", mime: "image/gif", isPng: false };

    let urlPath = "";
    try {
        urlPath = new URL(url, window.location?.href || "http://localhost/").pathname.toLowerCase();
    } catch {
        urlPath = String(url || "").split(/[?#]/, 1)[0].toLowerCase();
    }

    if (urlPath.endsWith(".png")) return { ext: "png", mime: "image/png", isPng: true };
    if (urlPath.endsWith(".webp")) return { ext: "webp", mime: "image/webp", isPng: false };
    if (urlPath.endsWith(".gif")) return { ext: "gif", mime: "image/gif", isPng: false };
    if (urlPath.endsWith(".jpg") || urlPath.endsWith(".jpeg")) return { ext: "jpg", mime: "image/jpeg", isPng: false };
    return { ext: "jpg", mime: "image/jpeg", isPng: false };
}

function replaceFilenameExtension(filename, ext) {
    const safeExt = (ext || "png").replace(/^\./, "");
    if (!filename) return `generated.${safeExt}`;
    return /\.[^./\\]+$/.test(filename)
        ? filename.replace(/\.[^./\\]+$/, `.${safeExt}`)
        : `${filename}.${safeExt}`;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function saveImageToServer(url, prompt, negative, settings) {
    const { buffer, contentType } = await fetchImageBuffer(url);
    const formatInfo = detectImageFormat(buffer, contentType, url);
    let finalBuffer = buffer;

    if (formatInfo.isPng && settings?.saveToServerEmbedMetadata !== false) {
        const metaText = buildMetadataString(prompt, negative, settings || {});
        finalBuffer = embedPNGMetadata(buffer, metaText);
    }

    const base64 = arrayBufferToBase64(finalBuffer);
    const subFolder = getServerSubfolder();
    let filename = `qig_${typeof humanizedDateTime === "function" ? humanizedDateTime() : Date.now()}`;
    if (typeof getSanitizedFilename === "function") {
        try {
            filename = await getSanitizedFilename(filename);
        } catch (e) {
            log(`SaveToServer: filename sanitize failed: ${e.message}`);
        }
    }
    return await saveBase64AsFile(base64, subFolder, filename, formatInfo.ext);
}

async function maybeFinalizeUrl(url, prompt, negative, settings) {
    const s = settings || getSettings();
    if (!s?.saveToServer) return url;
    if (typeof saveBase64AsFile !== "function") {
        warnSaveToServer("Save to server unavailable (missing API)");
        return url;
    }
    try {
        const path = await saveImageToServer(url, prompt, negative, s);
        return path || url;
    } catch (e) {
        warnSaveToServer(`Save to server failed: ${e.message}`);
        return url;
    }
}

// === PNG Metadata Embedding ===
function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildMetadataString(prompt, negative, settings) {
    const parts = [prompt];
    if (negative) parts.push(`Negative prompt: ${negative}`);
    const params = [];
    const steps = Number(settings.steps);
    const cfgScale = Number(settings.cfgScale);
    const width = Number(settings.width);
    const height = Number(settings.height);

    if (Number.isFinite(steps) && steps > 0) params.push(`Steps: ${steps}`);
    if (settings.sampler) params.push(`Sampler: ${SAMPLER_DISPLAY_NAMES[settings.sampler] || settings.sampler}`);
    if (settings.scheduler && settings.scheduler !== "Automatic") params.push(`Scheduler: ${settings.scheduler}`);
    if (Number.isFinite(cfgScale)) params.push(`CFG scale: ${cfgScale}`);
    if (Number.isFinite(settings.seed) && settings.seed >= 0) params.push(`Seed: ${settings.seed}`);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) params.push(`Size: ${width}x${height}`);
    if (settings.provider) params.push(`Provider: ${settings.provider}`);
    if (settings.model) params.push(`Model: ${settings.model}`);
    if (settings.backend) params.push(`Backend: ${settings.backend}`);
    if (params.length) parts.push(params.join(', '));
    return parts.join('\n');
}

function embedPNGMetadata(arrayBuffer, text) {
    const src = new Uint8Array(arrayBuffer);
    // Verify PNG signature
    if (src[0] !== 0x89 || src[1] !== 0x50) return arrayBuffer;

    const keyword = "parameters";
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(keyword);
    const valBytes = encoder.encode(text);
    const dataLen = keyBytes.length + 1 + valBytes.length; // keyword + null separator + value
    const typeBytes = encoder.encode("tEXt");

    // Build chunk: length(4) + type(4) + data + crc(4)
    const chunk = new Uint8Array(12 + dataLen);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, dataLen);
    chunk.set(typeBytes, 4);
    chunk.set(keyBytes, 8);
    chunk[8 + keyBytes.length] = 0; // null separator
    chunk.set(valBytes, 8 + keyBytes.length + 1);

    // CRC over type + data
    const crcData = new Uint8Array(4 + dataLen);
    crcData.set(typeBytes, 0);
    crcData.set(keyBytes, 4);
    crcData[4 + keyBytes.length] = 0;
    crcData.set(valBytes, 4 + keyBytes.length + 1);
    view.setUint32(8 + dataLen, crc32(crcData));

    // Find IEND position
    let iendPos = src.length;
    let offset = 8;
    while (offset < src.length) {
        if (offset + 12 > src.length) break;
        const len = (src[offset] << 24 | src[offset+1] << 16 | src[offset+2] << 8 | src[offset+3]) >>> 0;
        const type = String.fromCharCode(src[offset+4], src[offset+5], src[offset+6], src[offset+7]);
        if (type === 'IEND') { iendPos = offset; break; }
        if (len === 0 && type === '\0\0\0\0' || offset + len + 12 > src.length) break;
        offset += len + 12;
    }

    // Insert chunk before IEND
    const result = new Uint8Array(src.length + chunk.length);
    result.set(src.subarray(0, iendPos), 0);
    result.set(chunk, iendPos);
    result.set(src.subarray(iendPos), iendPos + chunk.length);
    return result.buffer;
}

async function downloadWithMetadata(url, filename, prompt, negative, settings) {
    try {
        const { buffer: arrayBuffer, contentType } = await fetchImageBuffer(url);
        const formatInfo = detectImageFormat(arrayBuffer, contentType, url);
        const metaText = buildMetadataString(prompt, negative, settings || {});
        const finalBuffer = formatInfo.isPng ? embedPNGMetadata(arrayBuffer, metaText) : arrayBuffer;
        const blob = new Blob([finalBuffer], { type: formatInfo.mime });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = replaceFilenameExtension(filename, formatInfo.ext);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
        console.error("Download with metadata failed:", err);
        toastr?.warning?.("Could not embed metadata for this image; opening original file.");
        window.open(url, '_blank');
    }
}

// Metadata Drag and Drop Handlers
async function decompressPngTextData(data) {
    if (typeof DecompressionStream !== "function") return null;
    try {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
        const buffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(buffer);
    } catch {
        return null;
    }
}

async function readPngParametersChunk(type, data) {
    const keywordEnd = data.indexOf(0);
    if (keywordEnd < 0) return null;

    const keyword = new TextDecoder().decode(data.slice(0, keywordEnd));
    if (keyword !== "parameters") return null;

    if (type === "tEXt") {
        return new TextDecoder().decode(data.slice(keywordEnd + 1));
    }

    if (type === "zTXt") {
        const compressionMethod = data[keywordEnd + 1];
        if (compressionMethod !== 0) return null;
        const decompressed = await decompressPngTextData(data.slice(keywordEnd + 2));
        return decompressed ? new TextDecoder().decode(decompressed) : null;
    }

    if (type === "iTXt") {
        let cursor = keywordEnd + 1;
        if (cursor + 2 > data.length) return null;
        const compressionFlag = data[cursor++];
        const compressionMethod = data[cursor++];

        while (cursor < data.length && data[cursor] !== 0) cursor++;
        cursor++;
        while (cursor < data.length && data[cursor] !== 0) cursor++;
        cursor++;

        const textBytes = data.slice(cursor);
        if (compressionFlag === 1) {
            if (compressionMethod !== 0) return null;
            const decompressed = await decompressPngTextData(textBytes);
            return decompressed ? new TextDecoder().decode(decompressed) : null;
        }
        return new TextDecoder().decode(textBytes);
    }

    return null;
}

async function readInfoFromPNG(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const buffer = e.target.result;
            const view = new DataView(buffer);
            let offset = 8; // Skip PNG signature

            while (offset < view.byteLength) {
                if (offset + 12 > view.byteLength) break;
                const length = view.getUint32(offset);
                if (offset + length + 12 > view.byteLength) break;
                const type = String.fromCharCode(
                    view.getUint8(offset + 4),
                    view.getUint8(offset + 5),
                    view.getUint8(offset + 6),
                    view.getUint8(offset + 7)
                );

                if (type === 'IEND') break;

                if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
                    const dataOffset = offset + 8;
                    const data = new Uint8Array(buffer, dataOffset, length);
                    const text = await readPngParametersChunk(type, data);
                    if (text) {
                        resolve(text);
                        return;
                    }
                }

                offset += length + 12; // Length + Type + Data + CRC
            }
            resolve(null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
    });
}

function parseGenerationParameters(text) {
    if (!text) return null;

    // Split into prompt and negative/params
    const parts = text.split(/Negative prompt: /);
    let prompt = parts[0].trim();
    let negative = "";
    let params = "";

    if (parts.length > 1) {
        const remaining = parts[1];
        const lastLineIdx = remaining.lastIndexOf("\nSteps: ");
        if (lastLineIdx !== -1) {
            negative = remaining.substring(0, lastLineIdx).trim();
            params = remaining.substring(lastLineIdx).trim();
        } else {
            // No params line found
            negative = remaining.trim();
        }
    } else {
        // Look for Steps: in the first part if no negative prompt
        const lastLineIdx = text.lastIndexOf("\nSteps: ");
        if (lastLineIdx !== -1) {
            prompt = text.substring(0, lastLineIdx).trim();
            params = text.substring(lastLineIdx).trim();
        }
    }

    const result = { prompt, negativePrompt: negative };

    // Parse key-value params
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const getParam = (key) => {
        const match = params.match(new RegExp(`${escapeRegex(key)}: ([^,\n]+)`));
        return match ? match[1].trim() : null;
    };

    const steps = getParam("Steps");
    const sampler = getParam("Sampler");
    const scheduler = getParam("Scheduler");
    const cfg = getParam("CFG scale");
    const seed = getParam("Seed");
    const size = getParam("Size");
    const provider = getParam("Provider");
    const model = getParam("Model");
    const backend = getParam("Backend");

    if (steps !== null) result.steps = parseInt(steps, 10);
    if (sampler) result.sampler = sampler;
    if (scheduler) result.scheduler = scheduler;
    if (cfg !== null) result.cfgScale = parseFloat(cfg);
    if (seed !== null) result.seed = parseInt(seed, 10);
    if (size) {
        const [w, h] = size.split("x").map(Number);
        result.width = w;
        result.height = h;
    }
    if (provider) result.provider = provider;
    if (model) result.model = model;
    if (backend) result.backend = backend;

    return result;
}

async function handleMetadataDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files[0];
    if (!file) return;
    const fileType = (file.type || "").toLowerCase();
    const fileName = (file.name || "").toLowerCase();
    const isPngMime = fileType.startsWith('image/png');
    const isPngName = fileName.endsWith('.png');
    const hasNoMime = !fileType;
    if (!isPngMime && !(hasNoMime && isPngName)) return;

    showStatus("🔍 Reading metadata...");
    try {
        const info = await readInfoFromPNG(file);
        if (!info) {
            showStatus("❌ No generation parameters found");
            setTimeout(() => showStatus(null), 2000);
            return;
        }

        const params = parseGenerationParameters(info);
        if (params) {
            const s = getSettings();
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el && value !== undefined && value !== null) el.value = value;
            };
            const explicitProvider = params.provider && PROVIDERS[params.provider] ? params.provider : null;
            const legacyProvider = !explicitProvider && params.model && PROVIDERS[params.model] ? params.model : null;
            const importedProvider = explicitProvider || legacyProvider || s.provider;

            if (importedProvider !== s.provider) {
                s.provider = importedProvider;
                setValue("qig-provider", s.provider);
                updateProviderUI();
                renderProfileSelect();
            }

            if (importedProvider === "local" && params.backend) {
                s.localType = params.backend === "comfyui" ? "comfyui" : "a1111";
                setValue("qig-local-type", s.localType);
                syncLocalTypeSections(s.localType);
            }

            if (params.prompt) {
                s.prompt = params.prompt;
                setValue("qig-prompt", s.prompt);
            }
            if (params.negativePrompt) {
                s.negativePrompt = params.negativePrompt;
                setValue("qig-negative", s.negativePrompt);
            }
            if (params.steps !== undefined && !Number.isNaN(params.steps)) {
                if (importedProvider === "proxy") {
                    s.proxySteps = params.steps;
                } else {
                    s.steps = params.steps;
                    setValue("qig-steps", s.steps);
                }
            }
            if (params.cfgScale !== undefined && !Number.isNaN(params.cfgScale)) {
                if (importedProvider === "proxy") {
                    s.proxyCfg = params.cfgScale;
                } else {
                    s.cfgScale = params.cfgScale;
                    setValue("qig-cfg", s.cfgScale);
                }
            }
            if (params.seed !== undefined && !Number.isNaN(params.seed)) {
                if (importedProvider === "proxy") {
                    s.proxySeed = params.seed;
                } else {
                    s.seed = params.seed;
                    setValue("qig-seed", s.seed);
                }
            }
            if (params.width && params.height) {
                s.width = params.width;
                s.height = params.height;
                if (importedProvider === "novelai") normalizeSize(s);
                syncSizeInputs(s.width, s.height);
                if (importedProvider === "novelai") syncNaiResolutionSelect();
            }

            if (explicitProvider && params.model) {
                switch (importedProvider) {
                    case "pollinations":
                        s.pollinationsModel = params.model === "flux" ? "" : params.model;
                        break;
                    case "novelai": s.naiModel = params.model; break;
                    case "gptimage": s.gptImageModel = params.model; break;
                    case "arliai": s.arliModel = params.model; break;
                    case "routeway": s.routewayModel = params.model; break;
                    case "navy": s.navyModel = params.model; break;
                    case "nanogpt": s.nanogptModel = params.model; break;
                    case "chutes": s.chutesModel = params.model; break;
                    case "civitai": s.civitaiModel = params.model; break;
                    case "nanobanana": s.nanobananaModel = params.model; break;
                    case "replicate": s.replicateModel = params.model; break;
                    case "fal": s.falModel = params.model; break;
                    case "together": s.togetherModel = params.model; break;
                    case "local":
                        if ((params.backend || s.localType) === "comfyui") {
                            s.localModel = params.model;
                        } else {
                            s.a1111Model = params.model;
                            if (!s.localModel) s.localModel = params.model;
                        }
                        break;
                    case "proxy": s.proxyModel = params.model; break;
                }
            }

            // Try to map sampler (approximate match)
            if (params.sampler) {
                if (importedProvider === "proxy") {
                    s.proxySampler = params.sampler;
                } else {
                    const samplerMap = {
                    "Euler a": "euler_a", "Euler": "euler",
                    "DPM++ 2M Karras": "dpm++_2m", "DPM++ 2M": "dpm++_2m",
                    "DPM++ SDE Karras": "dpm++_sde", "DPM++ SDE": "dpm++_sde",
                    "DPM++ 2M SDE Karras": "dpm++_2m_sde", "DPM++ 2M SDE": "dpm++_2m_sde",
                    "DPM++ 3M SDE Karras": "dpm++_3m_sde", "DPM++ 3M SDE": "dpm++_3m_sde",
                    "DPM++ 2S a Karras": "dpm++_2s_ancestral", "DPM++ 2S a": "dpm++_2s_ancestral",
                    "DPM2": "dpm_2", "DPM2 a": "dpm_2_ancestral",
                    "DPM2 Karras": "dpm_2", "DPM2 a Karras": "dpm_2_ancestral",
                    "DPM fast": "dpm_fast", "DPM adaptive": "dpm_adaptive",
                    "DDIM": "ddim", "DDPM": "ddpm",
                    "LMS": "lms", "LMS Karras": "lms",
                    "Heun": "heun", "Heun++ 2": "heunpp2",
                    "PLMS": "plms",
                    "UniPC": "uni_pc", "UniPC BH2": "uni_pc_bh2",
                    "LCM": "lcm", "DEIS": "deis", "Restart": "restart"
                };
                    const mapped = samplerMap[params.sampler];
                    if (mapped) {
                        const oldSampler = s.sampler;
                        s.sampler = mapped;
                        setValue("qig-sampler", s.sampler);
                        if (oldSampler !== mapped) {
                            toastr.info(`Sampler changed from "${oldSampler}" to "${mapped}" (from image metadata: "${params.sampler}")`);
                        }
                    }
                }
            }
            // Apply scheduler from metadata
            if (params.scheduler) {
                if (importedProvider === "local") {
                    if ((params.backend || s.localType) === "comfyui") {
                        s.comfyScheduler = params.scheduler;
                    } else {
                        s.a1111Scheduler = params.scheduler;
                    }
                } else if (importedProvider === "civitai") {
                    s.civitaiScheduler = params.scheduler;
                }
            }

            if (importedProvider) refreshProviderInputs(importedProvider);

            saveSettingsDebounced();
            showStatus("✅ Settings updated from image!");
            setTimeout(() => showStatus(null), 2000);
        }
    } catch (err) {
        log("Error reading metadata: " + err);
        showStatus("❌ Error reading metadata");
    }
}

// Export module info for SillyTavern
export { extensionName };

// SillyBunny divergence: minimal helper exports for the Expressions Agent bridge.
// These are kept intentionally small so upstream syncs only need to preserve this
// one export block. The actual sprite-generation logic lives outside QIG in
// public/scripts/extensions/expressions/expression-sprite-bridge.js.
export {
    getSettings,
    getGenerationSettingsForRun,
    generateForProvider,
    finalizeGeneratedEntry,
    withTransientGenerationSettings,
};
