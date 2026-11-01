import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const TEMPLATE_KEYS = new Set(['status', 'style', 'characters', 'constraints', 'require']);
const CONDITIONAL_SECTIONS = new Set(['references', 'style-reference', 'sheet-order', 'pixel-reference']);

/** @param {string} value */
function parseList(value) {
    if (value.trim() === 'none') {
        return [];
    }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/** @param {string} text */
function parseConstraintSections(text) {
    const sections = new Map();
    let current = null;
    for (const line of text.split('\n')) {
        const heading = /^##\s+(\S+)\s*$/.exec(line);
        if (heading) {
            current = heading[1];
            sections.set(current, []);
        } else if (current && line.trim()) {
            sections.get(current).push(line.trim());
        }
    }
    return new Map([...sections].map(([name, lines]) => [name, lines.join('\n')]));
}

/**
 * Parses one template file. Front matter is `key: value` lines between `---` fences;
 * `var.<name>: <default>` declares an optional variable (empty default means the line is dropped when unset).
 * `lookup.<name>: <file>:<variable>` fills <name> from prompts/<file>.md, a `## key` table, using the value of <variable>
 * as the key; an explicit value for <name> wins.
 * @param {string} id
 * @param {string} text
 */
function parseTemplate(id, text) {
    const match = /^---\n([^]*?)\n---\n([^]*)$/.exec(text.replace(/\r\n/g, '\n'));
    if (!match) {
        throw new Error(`Template "${id}" must start with a --- front matter block.`);
    }
    const meta = { id, defaults: new Map(), lookups: new Map(), required: [], status: '', style: '', characters: [], constraints: [], body: match[2].trim() };
    let hasCharacters = false;
    for (const line of match[1].split('\n')) {
        const pair = /^([\w.]+):[ \t]*(.*)$/.exec(line);
        if (!pair) {
            throw new Error(`Template "${id}": cannot read front matter line "${line}".`);
        }
        const [, key, value] = pair;
        if (key.startsWith('var.')) {
            meta.defaults.set(key.slice(4), value.trim());
        } else if (key.startsWith('lookup.')) {
            const source = /^([a-z][a-z0-9-]*):([a-z][a-z0-9_]*)$/.exec(value.trim());
            if (!source) {
                throw new Error(`Template "${id}": ${key} must read <lookup-file>:<variable>.`);
            }
            meta.lookups.set(key.slice(7), { file: source[1], keyVar: source[2] });
        } else if (TEMPLATE_KEYS.has(key)) {
            hasCharacters ||= key === 'characters';
            if (key === 'require' || key === 'characters' || key === 'constraints') {
                meta[key === 'require' ? 'required' : key] = parseList(value);
            } else {
                meta[key] = value.trim();
            }
        } else {
            throw new Error(`Template "${id}": unknown front matter key "${key}".`);
        }
    }
    if (!['ready', 'stub'].includes(meta.status)) {
        throw new Error(`Template "${id}": status must be "ready" or "stub".`);
    }
    if (!meta.style || !hasCharacters) {
        throw new Error(`Template "${id}": style and characters are required (use "none" for neither).`);
    }
    return meta;
}

/**
 * Loads and validates the whole prompt kit so a typo fails before any money is spent.
 * @param {string} promptsDir
 */
export function loadPromptKit(promptsDir) {
    const read = (name) => readFileSync(join(promptsDir, name), 'utf8').trim();
    const files = readdirSync(promptsDir);
    const styles = new Map(files.filter((f) => f.startsWith('style-')).map((f) => [f.slice(6, -3), read(f)]));
    const characters = new Map(files.filter((f) => f.startsWith('character-')).map((f) => [f.slice(10, -3), read(f)]));
    const constraints = parseConstraintSections(read('constraints.md'));
    const lookups = new Map();

    const templates = new Map();
    const templatesDir = join(promptsDir, 'templates');
    for (const file of existsSync(templatesDir) ? readdirSync(templatesDir) : []) {
        const id = basename(file, '.md');
        const template = parseTemplate(id, readFileSync(join(templatesDir, file), 'utf8'));
        for (const { file: lookupFile } of template.lookups.values()) {
            if (!lookups.has(lookupFile)) {
                lookups.set(lookupFile, parseConstraintSections(read(`${lookupFile}.md`)));
            }
        }
        validateTemplate(template, { styles, characters, constraints });
        templates.set(id, template);
    }
    return { styles, characters, constraints, lookups, templates };
}

function validateTemplate(template, { styles, characters, constraints }) {
    const { id } = template;
    if (template.style !== 'none' && !styles.has(template.style)) {
        throw new Error(`Template "${id}": style "${template.style}" has no style-${template.style}.md.`);
    }
    for (const character of template.characters) {
        if (!characters.has(character)) {
            throw new Error(`Template "${id}": character "${character}" has no character file.`);
        }
    }
    for (const section of template.constraints) {
        if (!constraints.has(section)) {
            throw new Error(`Template "${id}": constraint section "${section}" is not in constraints.md.`);
        }
    }
    for (const [name, { keyVar }] of template.lookups) {
        if (!template.defaults.has(keyVar) && !template.required.includes(keyVar)) {
            throw new Error(`Template "${id}": lookup "${name}" is keyed by undeclared variable "${keyVar}".`);
        }
    }
    const known = new Set([...template.defaults.keys(), ...template.required, ...template.lookups.keys()]);
    const used = new Set([...template.body.matchAll(PLACEHOLDER)].map((m) => m[1]));
    for (const name of used) {
        if (!known.has(name)) {
            throw new Error(`Template "${id}": placeholder {${name}} is not declared.`);
        }
    }
    const lookupKeys = new Set([...template.lookups.values()].map(({ keyVar }) => keyVar));
    for (const name of known) {
        if (!used.has(name) && !lookupKeys.has(name)) {
            throw new Error(`Template "${id}": variable "${name}" is declared but never used.`);
        }
    }
}

/** Replaces placeholders per line and drops any line whose placeholder resolved to nothing. */
function renderBody(body, values) {
    return body.split('\n').flatMap((line) => {
        const names = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
        if (names.some((name) => !values[name])) {
            return [];
        }
        return [line.replace(PLACEHOLDER, (_, name) => values[name])];
    }).join('\n');
}

/**
 * @param {ReturnType<typeof loadPromptKit>} kit
 * @param {string} templateId
 * @param {{ vars: Record<string, string>, characters?: string[], refCount: number }} request
 */
export function composePrompt(kit, templateId, { vars, characters, refCount }) {
    const template = kit.templates.get(templateId);
    if (!template) {
        throw new Error(`Unknown template "${templateId}". Known: ${[...kit.templates.keys()].join(', ')}.`);
    }
    for (const name of Object.keys(vars)) {
        if (!template.defaults.has(name) && !template.required.includes(name) && !template.lookups.has(name)) {
            throw new Error(`Template "${templateId}" has no variable "${name}".`);
        }
    }
    for (const name of template.required) {
        if (!vars[name]) {
            throw new Error(`Template "${templateId}" needs --vars ${name}=<value>.`);
        }
    }
    const chosenCharacters = characters ?? template.characters;
    for (const character of chosenCharacters) {
        if (!kit.characters.has(character)) {
            throw new Error(`Unknown character "${character}". Known: ${[...kit.characters.keys()].join(', ')}.`);
        }
    }

    const resolvedVars = { ...Object.fromEntries(template.defaults), ...vars };
    for (const [name, { file, keyVar }] of template.lookups) {
        if (resolvedVars[name]) {
            continue;
        }
        const found = kit.lookups.get(file).get(resolvedVars[keyVar]);
        if (!found) {
            throw new Error(`Template "${templateId}": ${file}.md has no entry for ${keyVar} "${resolvedVars[keyVar]}". Pass --vars ${name}=<text>.`);
        }
        resolvedVars[name] = found;
    }
    const characterBlocks = chosenCharacters.length > 1
        ? chosenCharacters.map((c, i) => `Character ${i + 1}:\n${kit.characters.get(c)}`)
        : chosenCharacters.map((c) => kit.characters.get(c));
    const constraintBlocks = template.constraints
        .filter((section) => refCount > 0 || !CONDITIONAL_SECTIONS.has(section))
        .map((section) => kit.constraints.get(section));

    const parts = [
        template.style === 'none' ? '' : kit.styles.get(template.style),
        ...characterBlocks,
        renderBody(template.body, resolvedVars),
        constraintBlocks.join('\n'),
    ];
    return {
        prompt: parts.filter(Boolean).join('\n\n'),
        status: template.status,
        characters: chosenCharacters,
        resolvedVars,
    };
}
