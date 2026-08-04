// Editable starting points for the built-in Text AI instructions.
// Keep these in sync with the adaptive builders in index.js: they mirror the
// standard single-message case, while toggle-driven blocks (identity rules,
// quality/lighting/artist additions, name requirements) are appended at
// request time by the custom-instruction path.

export const DEFAULT_TAGS_INSTRUCTION_TEMPLATE = `### STANDALONE IMAGE GENERATION TASK ###

CRITICAL - THIS IS NOT A CONTINUATION OF CHAT:
- IGNORE any ambient chat history outside the selected scene below
- Generate a FRESH image prompt based ONLY on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone generation task

### OUTPUT FORMAT (MANDATORY) ###
Output ONLY comma-separated Danbooru/Booru-style tags. No sentences. No descriptions. No paragraphs. No prose. No explanations.
If you write a sentence instead of tags, you have FAILED the task.

CORRECT example output:
1girl, hatsune_miku, vocaloid, long_hair, twintails, blue_hair, blue_eyes, detached_sleeves, thighhighs, sitting, smile, looking_at_viewer, classroom, window, sunlight, masterpiece, best_quality

WRONG (DO NOT do this):
"A girl with long blue twintails sits in a classroom by the window, smiling at the viewer."

### IMAGE GENERATION TASK ###

Create Danbooru/Booru-style tags for this scene: {{scene}}

Character info: {{charDesc}}

{{user}}'s persona: {{userDesc}}

Required tag categories:
- Character name + series name (use recognizable fictional media character tags whenever recognized)
- Physical traits (hair, eyes, body, skin)
- Clothing and accessories
- Pose and expression
- Background/setting
- Quality tags (masterpiece, best quality, etc.)

CRITICAL RESTRICTIONS (MUST FOLLOW):
- NEVER use realistic style tags (e.g., realistic, photorealistic, hyperrealistic, photography, etc.)
- NEVER use realistic artists (e.g., wlop, artgerm, rossdraws, etc.)
- NEVER use common/overused artists (e.g., sakimichan, greg rutkowski, alphonse mucha, etc.)

Tags:`;

export const DEFAULT_NATURAL_INSTRUCTION_TEMPLATE = `[STANDALONE IMAGE PROMPT GENERATION TASK]

CRITICAL INSTRUCTIONS:
- IGNORE any ambient chat history outside the selected scene below
- Generate ONLY a new image prompt based on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone task, not a continuation of chat

[Output ONLY an image generation prompt. No commentary or explanation.]

CHARACTER REFERENCE:
{{charDesc}}

{{user}}'s persona: {{userDesc}}

CURRENT SCENE: {{scene}}

Write a detailed image prompt describing:
- The characters involved with their defining visual traits (hair color, eye color, outfit, distinguishing features)
- Their poses, expressions, and body language
- The setting/background
- Lighting and atmosphere
- High quality visual details (sharp focus, detailed rendering, etc.)

Prompt:`;

export const DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE = `[STANDALONE VISUAL SCENE DESCRIPTION TASK]

Convert the selected chat scene into one concise plain-language visual description for an image generator.

Rules:
- Output ONLY the plain description. No commentary, no markdown, no speaker labels, no tags, no bullet list.
- Describe one coherent visible moment: subjects, identities, poses, expressions, clothing, setting, lighting, mood, and camera framing.
- Preserve explicit species, ages, body traits, names, and non-human details from the scene or reference context.
- Do not continue the roleplay and do not quote dialogue.

REFERENCE CONTEXT:
{{char}}'s appearance/profile: {{charDesc}}
{{user}}'s persona/appearance: {{userDesc}}

SELECTED SCENE:
{{scene}}

Plain visual description:`;

export function getDefaultInstructionTemplate(style) {
    return style === "natural" ? DEFAULT_NATURAL_INSTRUCTION_TEMPLATE : DEFAULT_TAGS_INSTRUCTION_TEMPLATE;
}
