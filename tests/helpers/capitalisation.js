// The capitalisation rule of DESIGN.md (The Capitalisation Rule) and the writing-style rules of its Do's, as pure functions.
// A computer cannot tell nouns from verbs, so a word of three letters or fewer is capitalised unless it is an article, a
// conjunction or a short preposition (FUNCTION_WORDS). A name in brackets, a Handlebars helper, a file extension, a
// command-line flag and a template hole are code, not words, and stay as written.

const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'as', 'at', 'by', 'in', 'of', 'to', 'per', 'via', 'vs', 'if']);
// Ambiguous short words (particles and pronouns) that stay as written inside a phrase.
const LEAVE_WORDS = new Set(['on', 'up', 'off', 'out', 'so', 'yet', 'it', 'its', 'my', 'me', 'we', 'us', 'our', 'you']);
const UNIT_WORDS = new Set(['px', 'em', 'rem', 'ms', 'kb', 'mb', 'gb', 'tb', 'hz', 'khz', 'fps', 'dpi', 'ppi', 'vh', 'vw', 'pt']);
// Names that keep their capitals inside a sentence-case string. DESIGN.md writes them as titles.
const PROTECTED_PHRASES = [
    'World Info', 'Quick Replies', 'Quick Reply', 'Chat Completion', 'Text Completion', 'Author\'s Note', 'Data Bank', 'Data & Security',
    'Persona Management', 'Connection Profile', 'Connection Profiles', 'Prompt Manager', 'Group Chat', 'Group Chats', 'Conversation Mode',
    'Quick Access', 'Show More', 'Open Router', 'Character Cards', 'Character Card', 'Lexicon', 'Home', 'Backend', 'Customize', 'Extensions',
    'Characters', 'Personas', 'Agents', 'Assistants', 'Help', 'Advanced', 'Appearance', 'Connections', 'Presets', 'Formatting', 'Interface',
    'Desktop', 'Mobile', 'Typing', 'Welcome', 'Getting Started', 'Keyboard Shortcuts', 'No Results Found',
    'Pathfinder', 'In-Chat Agents', 'Connection Manager', 'Prompt Inspector', 'Quick Image Gen',
    'Guided Swipe', 'Guided Generations', 'Guided Response', 'Guided Correction', 'Guided Impersonate', 'Simple Send', 'Flush Guides',
];

export const HEADER_ROLES = new Set(['heading', 'button', 'menu item', 'tooltip', 'accessible name', 'tab', 'row title', 'field label', 'dialog response']);
// A toast title is an informal heading (HIG Toasts): a short sentence in sentence capitalisation, so it is read strictly: every word
// after the first that is not a protected name or code is lower case.
export const SENTENCE_ROLES = new Set(['row subtitle', 'caption', 'placeholder', 'check or radio label', 'drop-down item', 'body', 'toast title']);

const norm = text => text.replace(/\s+/g, ' ').trim();
const wordCount = text => text.split(/\s+/).filter(token => /\p{L}/u.test(token)).length;

function splitToken(token) {
    const match = token.match(/^([^\p{L}\p{N}$]*)(.*?)([^\p{L}\p{N}]*)$/su);
    return match ? [match[1], match[2], match[3]] : ['', token, ''];
}
const isAlphaWord = core => /^[\p{L}][\p{L}'’]*(?:[-/][\p{L}][\p{L}'’]*)*$/u.test(core);
const capitalize = word => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A token in brackets (a command such as `([selfie])`), with a leading dot (a file extension such as `.md`) or with leading dashes
 * (a flag such as `--api`) is code, not a word.
 */
const isCodeToken = (lead, trail) => lead.includes('[') || trail.includes(']') || lead.endsWith('.') || /--?$/.test(lead);

function headerCaseWord(core, isEdge) {
    const parts = core.split(/([-/])/);
    // Every part of a hyphenated word is capitalised ("Middle-Out", "Per-Model"), so the short-word exceptions apply to single words only.
    const hyphenated = parts.includes('-');
    return parts.map(part => {
        if (part === '-' || part === '/' || !part) return part;
        const lower = part.toLowerCase();
        if (/\p{Lu}/u.test(part.slice(1))) return part;
        if (part.length > 1 && part === part.toUpperCase()) return part;
        if (UNIT_WORDS.has(lower)) return part;
        if (!hyphenated && FUNCTION_WORDS.has(lower) && !isEdge) return lower;
        if (!hyphenated && LEAVE_WORDS.has(lower) && !isEdge) return part;
        return capitalize(part);
    }).join('');
}

/** Header capitalisation: first and last word, nouns, verbs, hyphenated words and every word of four or more letters. */
export function headerCase(text) {
    if (text.includes('{{')) return text;
    const tokens = text.split(/(\s+)/);
    const wordIndexes = tokens.map((token, index) => (/\s/.test(token) || !token ? -1 : index)).filter(index => index >= 0);
    const first = wordIndexes[0];
    const last = wordIndexes[wordIndexes.length - 1];
    return tokens.map((token, index) => {
        if (/^\s*$/.test(token)) return token;
        const [lead, core, trail] = splitToken(token);
        // A plural marker in brackets, "character(s)", is part of the word.
        const plural = token.match(/^([^\p{L}]*)(\p{L}[\p{L}'’-]*)\(s\)([^\p{L}]*)$/u);
        if (plural && index === last) return `${plural[1]}${headerCaseWord(plural[2], true)}(s)${plural[3]}`;
        if (!core || /[${}\\@_.#=<>0-9]/.test(core) || !isAlphaWord(core) || isCodeToken(lead, trail)) return token;
        return lead + headerCaseWord(core, index === first || index === last) + trail;
    }).join('');
}

function maskProtected(text) {
    const masks = [];
    let out = text;
    // The longest phrase first, so "In-Chat Agents" is masked whole before "Agents" is.
    for (const phrase of [...PROTECTED_PHRASES].sort((a, b) => b.length - a.length)) {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
        out = out.replace(pattern, match => {
            masks.push(match);
            return `\u0001${masks.length - 1}\u0002`;
        });
    }
    return { out, masks };
}

/** Sentence capitalisation: the first word and the protected names keep their capitals. */
export function sentenceCase(text) {
    if (text.includes('{{')) return text;
    const { out, masks } = maskProtected(text);
    let seenWord = false;
    const result = out.split(/(\s+)/).map(token => {
        if (/^\s*$/.test(token)) return token;
        const [lead, core, trail] = splitToken(token);
        const isFirst = !seenWord;
        seenWord = true;
        if (!core || /\u0001/.test(core) || /[${}\\@_.#=<>0-9]/.test(core) || !isAlphaWord(core) || isCodeToken(lead, trail)) return token;
        const lowered = core.split('-').map((part, index) => {
            if (index === 0 && isFirst) return part;
            if (index === 0) return /\p{Lu}/u.test(part.slice(1)) || (part.length > 1 && part === part.toUpperCase()) ? part : part.toLowerCase();
            return /^\p{Lu}\p{Ll}*$/u.test(part) ? part.toLowerCase() : part;
        });
        return lead + lowered.join('-') + trail;
    }).join('');
    return result.replace(/\u0001(\d+)\u0002/g, (_, index) => masks[Number(index)]);
}

/** True when the text reads as header capitalised: two or more words of four letters or more, after the first, start with a capital. */
function looksHeaderCased(text) {
    // Several sentences need a human reading, because each sentence start keeps its capital.
    if (/[.!?]\s+\S/.test(text)) return false;
    const tokens = maskProtected(text).out.split(/\s+/).slice(1);
    let capitalised = 0;
    for (const token of tokens) {
        const [, core] = splitToken(token);
        if (!core || /\u0001/.test(core) || !isAlphaWord(core) || core.length < 4) continue;
        if (/\p{Ll}/u.test(core[0])) return false;
        if (core === core.toUpperCase() || /\p{Lu}/u.test(core.slice(1))) continue;
        capitalised++;
    }
    return capitalised >= 2;
}

/** True when a word after the first, of four letters or more and not a protected name, starts with a capital: "Delete Folder?". */
function hasInnerCapitals(text) {
    return maskProtected(text).out.split(/\s+/).slice(1).some(token => {
        const [, core] = splitToken(token);
        return core && !/\u0001/.test(core) && isAlphaWord(core) && core.length >= 4 && /^\p{Lu}/u.test(core) && core !== core.toUpperCase() && !/\p{Lu}/u.test(core.slice(1));
    });
}

// Only auxiliaries and modals make a clause finite. A lexical verb such as "failed" is also a participle ("Failed Uploads").
const FINITE_VERBS = new Set(['is', 'are', 'was', 'were', 'am', 'be', 'been', 'can', 'cannot', 'could', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would',
    'shall', 'should', 'must', 'may', 'might',
    'can\'t', 'couldn\'t', 'doesn\'t', 'don\'t', 'didn\'t', 'isn\'t', 'aren\'t', 'wasn\'t', 'weren\'t', 'won\'t', 'hasn\'t', 'haven\'t']);
const INTERROGATIVES = new Set(['what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'when', 'where']);
const AUXILIARY_STARTS = new Set(['is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'have', 'has', 'had']);
const SUBJECT_PRONOUNS = new Set(['you', 'we', 'i', 'they', 'it', 'he', 'she', 'there']);
const DETERMINERS = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those']);
// A confirmation question of this many words or more reads as a sentence.
const SENTENCE_QUESTION_WORDS = 6;
// A heading or tooltip of this many words is a sentence in a label's place, which needs new wording rather than a recase.
const SENTENCE_LENGTH_WORDS = 7;
const LONG_PHRASE_ROLES = new Set(['heading', 'tooltip', 'toast title']);
// A row title of this many words, or four with a comma, is a sentence in a title's place.
const SENTENCE_LENGTH_ROW_TITLE_WORDS = 9;

/**
 * The branch of a question heading (DESIGN.md line 372): "sentence" for a full question, "heading" for a verb and its object.
 * An interrogative or auxiliary first word, an article, possessive, demonstrative or subject pronoun anywhere, or six words
 * or more make a sentence.
 */
export function questionBranch(text) {
    const words = norm(text).replace(/’/g, '\'').replace(/\?$/, '').split(/\s+/).map(word => word.toLowerCase().replace(/^[^\p{L}$]+|[^\p{L}'}]+$/gu, ''));
    if (!words.length) return 'heading';
    if (INTERROGATIVES.has(words[0]) || AUXILIARY_STARTS.has(words[0])) return 'sentence';
    if (words.some(word => DETERMINERS.has(word) || SUBJECT_PRONOUNS.has(word))) return 'sentence';
    if (wordCount(text) >= SENTENCE_QUESTION_WORDS) return 'sentence';
    return 'heading';
}

/** A full sentence (DESIGN.md line 372): a full question, or three words or more with a finite verb after the first word. */
export function isFullSentence(text) {
    const flat = norm(text).replace(/\$\{\}/g, 'x').replace(/’/g, '\'');
    if (/[.!?]\s+\p{Lu}/u.test(flat)) return false;
    if (/\?$/.test(flat)) return questionBranch(text) === 'sentence';
    const words = flat.replace(/[.!]+$/, '').split(/\s+/).filter(word => /\p{L}/u.test(word));
    if (words.length < 3) return false;
    return words.slice(1).some(word => FINITE_VERBS.has(word.toLowerCase().replace(/[^\p{L}']/gu, '')));
}

const LATIN = [
    [/\be\.g\.(,?)/gi, (_match, comma) => `for example${comma}`, 'e.g.'],
    [/\bi\.e\.(,?)/gi, (_match, comma) => `that is${comma}`, 'i.e.'],
    [/\bvs\./gi, () => 'versus', 'vs.'],
    [/\betc\.(?=\s*$|[)\],;])/gi, () => 'and so on', 'etc.'],
];
// An ellipsis inside brackets or quotes is literal syntax, such as <think>...</think> or ((...)).
const PROSE_ELLIPSIS = /(?<![([{<>"'])\.{3}(?![)\]}<>"'])/g;
const SEVERAL_SENTENCES = /[.!?]\s+\p{Lu}/u;

/**
 * The writing-style faults of a label: a three-dot ellipsis, a Latin abbreviation and a trailing period.
 * @param {string} text
 * @param {{ period?: boolean }} [options] `period: false` for body text, which ends in a period.
 * @returns {string[]}
 */
export function styleFaults(text, { period = true } = {}) {
    const flat = norm(text);
    const faults = [];
    const hasEllipsis = new RegExp(PROSE_ELLIPSIS.source).test(flat);
    if (hasEllipsis) faults.push('three-dot ellipsis');
    for (const [pattern, , name] of LATIN) {
        if (new RegExp(pattern.source, 'i').test(flat)) faults.push(`Latin abbreviation ${name}`);
    }
    if (period && /\.$/.test(flat.replace(PROSE_ELLIPSIS, '…')) && !SEVERAL_SENTENCES.test(flat)) faults.push('trailing period');
    return faults;
}

function fixStyle(text, { period }) {
    let fixed = norm(text).replace(PROSE_ELLIPSIS, '…');
    for (const [pattern, replace] of LATIN) fixed = fixed.replace(pattern, replace).replace(/^for example/, 'For example').replace(/^that is/, 'That is');
    if (period && /\.$/.test(fixed) && !/…$/.test(fixed) && !SEVERAL_SENTENCES.test(fixed)) fixed = fixed.slice(0, -1);
    return fixed;
}

/**
 * Checks one label against the rule for its role.
 * @param {string} role A member of HEADER_ROLES or SENTENCE_ROLES.
 * @param {string} text The string as written; a `${...}` hole is read as `${}`.
 * @param {{ style?: boolean }} [options] `style: false` leaves the ellipsis, Latin abbreviation and period faults to another test.
 * @returns {{ ok: true, skipped?: string } | { ok: false, expected: string, why: string }}
 */
export function checkLabel(role, text, { style = true } = {}) {
    if (text.includes('{{')) return { ok: true, skipped: 'template' };
    const flat = norm(text);
    const header = HEADER_ROLES.has(role);
    const period = header;
    const styled = style ? fixStyle(flat, { period }) : flat;
    const faults = style ? styleFaults(flat, { period }) : [];

    let family = header ? 'header' : 'sentence';
    if (header && role === 'heading' && isFullSentence(styled)) family = 'sentence-heading';
    // Text with two sentences, or a heading, tooltip or toast title as long as a sentence, needs new wording rather than a recase.
    if ((header && family === 'header') || role === 'toast title') {
        const count = wordCount(styled);
        const longPhrase = LONG_PHRASE_ROLES.has(role) && (count >= SENTENCE_LENGTH_WORDS || (count >= 4 && /[,;]/.test(styled)));
        // A label that ends like a sentence and has four words or more is a sentence in a label's place.
        const endsSentence = /[.!?]$/.test(flat.replace(PROSE_ELLIPSIS, '…')) && !/…$/.test(flat) && !/\?$/.test(flat) && count >= 4;
        const longTitle = role === 'row title' && (count >= SENTENCE_LENGTH_ROW_TITLE_WORDS || (count >= 4 && /[,;]/.test(styled)));
        if (SEVERAL_SENTENCES.test(styled) || (/\?$/.test(styled) && count >= 3) || endsSentence || longPhrase || longTitle) return { ok: true, skipped: 'sentence-length' };
    }

    let expected = styled;
    let rule = null;
    if (family === 'header') {
        const cased = headerCase(styled);
        if (cased !== styled) [expected, rule] = [cased, 'header capitalisation'];
    } else if (family === 'sentence-heading') {
        // A statement that is already in header capitalisation is the HIG's own form ("Document Cannot Be Found"), so only a mixed form fails.
        if (hasInnerCapitals(styled) && (/\?$/.test(styled) || headerCase(styled) !== styled)) {
            const cased = sentenceCase(styled);
            if (cased !== styled) [expected, rule] = [cased, 'sentence capitalisation'];
        }
    } else if (role === 'toast title' ? sentenceCase(styled) !== styled : looksHeaderCased(styled)) {
        const cased = sentenceCase(styled);
        if (cased !== styled) [expected, rule] = [cased, 'sentence capitalisation'];
    }
    if (!rule && !faults.length) return { ok: true };
    return { ok: false, expected, why: [rule, ...faults].filter(Boolean).join(', ') };
}
