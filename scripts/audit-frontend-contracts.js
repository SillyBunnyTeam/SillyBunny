#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@adobe/css-tools';
import { decode } from 'html-entities';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

const defaultTargets = Object.freeze({
    html: [
        'public/index.html',
        'public/login.html',
    ],
    css: [
        'public/css/sillybunny-theme.css',
        'public/css/sillybunny-tabs.css',
        'public/css/sillybunny-mobile-shell.css',
    ],
});

const optionalPublicAssets = new Set([
    'css/user.css',
]);

const motionPropertyPattern = /^(?:-webkit-)?(?<family>transition|animation)(?:-(?:duration|delay))?$/;
const reducedMotionQueryPattern = /prefers-reduced-motion\s*:\s*reduce/i;
const disabledMotionValuePattern = /^none(?:\s*!important)?$/i;

function normalizeSource(source) {
    return String(source).replace(/\r\n/g, '\n');
}

function createFinding(severity, code, file, message, line, subject = code, count = 1) {
    return {
        severity,
        code,
        file,
        ...(line ? { line } : {}),
        message,
        key: JSON.stringify([file, code, subject]),
        count,
    };
}

function* htmlTags(source) {
    // Skip comments and raw-text bodies; quoted '>' characters belong to attributes.
    const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(?<name>[a-z][\w:-]*)\b(?<attributes>(?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    let previousOffset = 0;
    let line = 1;
    for (let match; (match = tokens.exec(source));) {
        if (!match.groups?.name) continue;
        const name = match.groups.name.toLowerCase();
        const attributes = new Map();
        const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        for (const attribute of match.groups.attributes.matchAll(attributePattern)) {
            const key = attribute[1].toLowerCase();
            if (!attributes.has(key)) attributes.set(key, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '', { scope: 'attribute' }));
        }
        line += (source.slice(previousOffset, match.index).match(/\n/g) ?? []).length;
        previousOffset = match.index;
        yield { name, attributes, line };
        if (/^(script|style|textarea|title)$/.test(name)) {
            const closingTag = new RegExp(`</${name}\\s*>`, 'gi');
            closingTag.lastIndex = tokens.lastIndex;
            const closing = closingTag.exec(source);
            tokens.lastIndex = closing ? closingTag.lastIndex : source.length;
        }
    }
}

function stripAssetQuery(value) {
    return String(value).split(/[?#]/)[0];
}

function isExternalAsset(value) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}

function resolvePublicAsset(repoRoot, relativePath, reference) {
    const decodedReference = decodeURIComponent(stripAssetQuery(reference));
    const publicRoot = path.join(repoRoot, 'public');
    const assetPath = path.resolve(decodedReference.startsWith('/') ? publicRoot : path.dirname(path.join(repoRoot, relativePath)), decodedReference.replace(/^\/+/, ''));
    const cleanReference = path.relative(publicRoot, assetPath).split(path.sep).join('/');
    const isPublicPath = assetPath === publicRoot || assetPath.startsWith(`${publicRoot}${path.sep}`);

    return {
        cleanReference,
        assetPath,
        isPublicPath,
    };
}

export function extractHtmlAssetReferences(source) {
    const normalizedSource = normalizeSource(source);
    const references = [];

    for (const tag of htmlTags(normalizedSource)) {
        if (tag.name !== 'link' && tag.name !== 'script') continue;
        const attribute = tag.name === 'script' ? 'src' : 'href';
        const value = tag.attributes.get(attribute)?.trim();

        if (!value || isExternalAsset(value)) {
            continue;
        }

        references.push({
            attribute,
            value,
            line: tag.line,
        });
    }

    return references;
}

function auditHtmlSource({ repoRoot, relativePath, source }) {
    const findings = [];
    const normalizedSource = normalizeSource(source);

    for (const reference of extractHtmlAssetReferences(normalizedSource)) {
        let resolved;
        try {
            resolved = resolvePublicAsset(repoRoot, relativePath, reference.value);
        } catch {
            findings.push(createFinding('error', 'invalid-asset-url', relativePath, reference.value, reference.line, reference.value));
            continue;
        }

        if (!resolved.isPublicPath) {
            findings.push(createFinding(
                'error',
                'asset-path-escape',
                relativePath,
                `${reference.attribute} reference escapes public/: ${reference.value}`,
                reference.line,
                reference.value,
            ));
            continue;
        }

        if ((!fs.existsSync(resolved.assetPath) || !fs.statSync(resolved.assetPath).isFile()) && !optionalPublicAssets.has(resolved.cleanReference)) {
            findings.push(createFinding(
                'error',
                'missing-asset',
                relativePath,
                `${reference.attribute} reference does not resolve: ${reference.value}`,
                reference.line,
                reference.value,
            ));
        }
    }

    const ids = new Map();
    for (const tag of htmlTags(normalizedSource)) {
        const id = tag.attributes.get('id');
        if (!id) {
            continue;
        }

        const locations = ids.get(id) ?? [];
        locations.push(tag.line);
        ids.set(id, locations);
    }

    for (const [id, locations] of ids) {
        if (locations.length < 2) {
            continue;
        }

        findings.push(createFinding(
            'warning',
            'duplicate-id',
            relativePath,
            `id="${id}" appears ${locations.length} times (lines ${locations.join(', ')}).`,
            locations[0],
            id,
            locations.length - 1,
        ));
    }

    return findings;
}

function visitCssRules(rules, conditions, visitor) {
    for (const rule of rules ?? []) {
        const nestedConditions = ['media', 'supports', 'container'].includes(rule.type)
            ? [...conditions, `${rule.type}:${rule[rule.type]}`]
            : conditions;

        if (rule.type === 'rule') {
            visitor(rule, nestedConditions);
        }

        if (Array.isArray(rule.rules)) {
            visitCssRules(rule.rules, nestedConditions, visitor);
        }
    }
}

function getRuleSelectors(rule) {
    return Array.isArray(rule.selectors) && rule.selectors.length > 0
        ? rule.selectors
        : ['<anonymous rule>'];
}

function cleanValue(value) {
    return value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
}

function isZeroTime(value) {
    return cleanValue(value).split(',').every(time => /^0(?:\.0+)?(?:ms|s)?$/.test(time.trim()));
}

function isLegacyInstantTime(value) {
    return /^0\.01ms$/i.test(cleanValue(value));
}

function isGuardTime(value) {
    return isZeroTime(value) || isLegacyInstantTime(value);
}

function hasMotionDelay(declarations, family) {
    const delay = declarations.find(item => item.property === `${family}-delay`);
    if (delay && !isZeroTime(delay.value)) return true;

    const shorthand = declarations.find(item => item.property === family)?.value ?? '';
    return shorthand.split(',').some(segment => (
        (segment.match(/-?(?:\d*\.)?\d+m?s\b/g) ?? []).slice(1).some(time => !isZeroTime(time))
    ));
}

function reducedConditions(conditions) {
    // Only accept conjunctive reduce queries. `not` and comma alternatives need browser verification.
    const reduce = conditions.some(condition => condition.startsWith('media:') && reducedMotionQueryPattern.test(condition) && !/\bnot\b|,/i.test(condition));
    return reduce ? conditions.map(condition => condition.replace(/(?:and\s*)?\(prefers-reduced-motion\s*:\s*reduce\)/i, '').replace(/media:\s*(?:only\s+)?(?:screen\s*(?:and)?)?\s*$/, '').trim()).filter(Boolean) : null;
}

function collectMotionGuards(ast) {
    const guards = [];
    visitCssRules(ast.stylesheet?.rules, [], (rule, conditions) => {
        const scope = reducedConditions(conditions);
        if (!scope) return;
        const declarations = new Map((rule.declarations ?? []).filter(item => item.type === 'declaration').map(item => [item.property, item.value]));
        for (const family of ['transition', 'animation']) {
            for (const prefix of ['', '-webkit-']) {
                const shorthand = declarations.get(`${prefix}${family}`) ?? '';
                const duration = declarations.get(`${prefix}${family}-duration`) ?? '';
                const delay = declarations.get(`${prefix}${family}-delay`) ?? '';
                const iterations = declarations.get(`${prefix}animation-iteration-count`) ?? '';
                const instant = isZeroTime(duration) || (isLegacyInstantTime(duration) && (family === 'transition' || cleanValue(iterations) === '1'));
                if (!disabledMotionValuePattern.test(shorthand) && !instant) continue;
                guards.push({
                    family, scope, selectors: getRuleSelectors(rule),
                    important: /!important/i.test(shorthand || duration),
                    clearsDelay: disabledMotionValuePattern.test(shorthand) || isGuardTime(delay),
                    order: (rule.position?.start.line ?? 0) * 1000000 + (rule.position?.start.column ?? 0),
                });
            }
        }
    });
    return guards;
}

function auditCssAst(ast, sharedGuards = []) {
    const motionRequirements = [];
    const reducedMotionGuards = [...collectMotionGuards(ast), ...sharedGuards];
    const compatibilityFindings = [];
    const largeRadiusTokens = [];
    const slowTransitionTokens = [];

    visitCssRules(ast.stylesheet?.rules, [], (rule, conditions) => {
        const isReducedMotion = reducedConditions(conditions) !== null;
        const declarations = (rule.declarations ?? [])
            .filter(declaration => declaration.type === 'declaration');
        const properties = new Set(declarations.map(declaration => declaration.property.toLowerCase()));

        if (properties.has('backdrop-filter') && !properties.has('-webkit-backdrop-filter')) {
            compatibilityFindings.push({
                code: 'missing-webkit-backdrop-filter',
                selectors: getRuleSelectors(rule),
            });
        }

        if (properties.has('appearance') && !properties.has('-webkit-appearance')) {
            compatibilityFindings.push({
                code: 'missing-webkit-appearance',
                selectors: getRuleSelectors(rule),
            });
        }

        if (properties.has('user-select') && !properties.has('-webkit-user-select')) {
            compatibilityFindings.push({
                code: 'missing-webkit-user-select',
                selectors: getRuleSelectors(rule),
            });
        }

        const hasStickyPosition = declarations.some(declaration => (
            declaration.property === 'position' && declaration.value.trim() === 'sticky'
        ));
        const hasWebKitStickyPosition = declarations.some(declaration => (
            declaration.property === 'position' && declaration.value.trim() === '-webkit-sticky'
        ));
        if (hasStickyPosition && !hasWebKitStickyPosition) {
            compatibilityFindings.push({
                code: 'missing-webkit-sticky-position',
                selectors: getRuleSelectors(rule),
            });
        }

        for (const declaration of declarations) {
            const propertyMatch = declaration.property.toLowerCase().match(motionPropertyPattern);
            if (propertyMatch) {
                const family = propertyMatch.groups.family;
                for (const selector of getRuleSelectors(rule)) {
                    if (!isReducedMotion && !disabledMotionValuePattern.test(declaration.value) && !isZeroTime(declaration.value)) {
                        const hasDelay = hasMotionDelay(declarations, family);
                        motionRequirements.push({ family, selector, conditions, hasDelay, order: (rule.position?.start.line ?? 0) * 1000000 + (rule.position?.start.column ?? 0), important: /!important/i.test(declaration.value) });
                    }
                }
            }

            if (declaration.property.toLowerCase().startsWith('--sb-radius-')) {
                const radiusMatch = declaration.value.match(/^(\d+(?:\.\d+)?)px$/i);
                if (radiusMatch && Number(radiusMatch[1]) > 20) {
                    largeRadiusTokens.push(`${declaration.property}: ${declaration.value}`);
                }
            }

            if (declaration.property.toLowerCase() === '--sb-transition-slow' && /(?:\d+(?:\.\d+)?)ms/i.test(declaration.value)) {
                const duration = Number(declaration.value.match(/(\d+(?:\.\d+)?)ms/i)[1]);
                if (duration > 300) {
                    slowTransitionTokens.push(`${declaration.property}: ${declaration.value}`);
                }
            }
        }
    });

    const unguardedMotion = [...new Set(motionRequirements.filter(requirement => !reducedMotionGuards.some(guard => {
        if (guard.family !== requirement.family || guard.scope.some(condition => !requirement.conditions.includes(condition))) return false;
        if (requirement.hasDelay && !guard.clearsDelay) return false;
        if (requirement.important && !guard.important) return false;
        if (!guard.external && guard.order < requirement.order && (requirement.important || !guard.important)) return false;
        if (guard.external && !guard.important) return false;
        const universal = requirement.selector.includes('::before') ? '*::before' : requirement.selector.includes('::after') ? '*::after' : requirement.selector.includes('::') ? null : '*';
        return guard.selectors.includes(requirement.selector) || (!requirement.important && guard.important && guard.selectors.includes(universal));
    })).map(({ family, selector, conditions }) => `${family}: ${selector}${conditions.length ? ` [${conditions.join(' / ')}]` : ''}`))];

    return {
        compatibilityFindings,
        largeRadiusTokens: [...new Set(largeRadiusTokens)],
        slowTransitionTokens: [...new Set(slowTransitionTokens)],
        unguardedMotion,
    };
}

export function auditCssSource(source, sourceName = '<inline CSS>', sharedGuards = []) {
    const normalizedSource = normalizeSource(source);
    let ast;

    try {
        ast = parse(normalizedSource, { source: sourceName });
    } catch (error) {
        return {
            parseError: error,
            ...{
                compatibilityFindings: [],
                largeRadiusTokens: [],
                slowTransitionTokens: [],
                unguardedMotion: [],
            },
        };
    }

    return auditCssAst(ast, sharedGuards);
}

function auditCssFile(relativePath, source, sharedGuards) {
    const audit = auditCssSource(source, relativePath, sharedGuards);
    const findings = [];

    if (audit.parseError) {
        findings.push(createFinding('error', 'css-parse-error', relativePath, audit.parseError.message));
        return findings;
    }

    for (const motion of audit.unguardedMotion) {
        findings.push(createFinding(
            'warning',
            'motion-without-reduced-guard',
            relativePath,
            `No statically verified reduced-motion override for ${motion}.`,
            undefined,
            motion,
        ));
    }

    for (const compatibilityFinding of audit.compatibilityFindings) {
        findings.push(createFinding(
            'warning',
            compatibilityFinding.code,
            relativePath,
            `${compatibilityFinding.code} for ${compatibilityFinding.selectors.slice(0, 3).join(', ')}.`,
            undefined,
            compatibilityFinding.selectors.join(', '),
        ));
    }

    for (const token of audit.largeRadiusTokens) {
        findings.push(createFinding(
            'warning',
            'radius-token-over-limit',
            relativePath,
            `SillyBunny radius token exceeds 20px: ${token}.`,
            undefined,
            token,
        ));
    }

    for (const token of audit.slowTransitionTokens) {
        findings.push(createFinding(
            'warning',
            'slow-transition-token-over-limit',
            relativePath,
            `SillyBunny slow transition token exceeds 300ms: ${token}.`,
            undefined,
            token,
        ));
    }

    return findings;
}

export function auditFrontendContracts({ repoRoot = defaultRepoRoot, targets = defaultTargets } = {}) {
    const findings = [];
    const cssSources = new Map();
    const sharedGuards = [];
    for (const relativePath of targets.css ?? []) {
        try {
            const source = fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8');
            cssSources.set(relativePath, source);
            const ast = parse(source);
            sharedGuards.push(...collectMotionGuards(ast).map(guard => ({ ...guard, external: true, file: relativePath })));
        } catch {
            // The per-file pass reports missing files and parse errors.
        }
    }

    for (const relativePath of targets.html ?? []) {
        const absolutePath = path.resolve(repoRoot, relativePath);
        if (!fs.existsSync(absolutePath)) {
            findings.push(createFinding('error', 'missing-target', relativePath, 'Audit target does not exist.'));
            continue;
        }

        findings.push(...auditHtmlSource({
            repoRoot,
            relativePath,
            source: fs.readFileSync(absolutePath, 'utf8'),
        }));
    }

    for (const relativePath of targets.css ?? []) {
        const absolutePath = path.resolve(repoRoot, relativePath);
        if (!fs.existsSync(absolutePath)) {
            findings.push(createFinding('error', 'missing-target', relativePath, 'Audit target does not exist.'));
            continue;
        }

        findings.push(...auditCssFile(relativePath, cssSources.get(relativePath) ?? fs.readFileSync(absolutePath, 'utf8'), sharedGuards.filter(guard => guard.file !== relativePath)));
    }

    return findings;
}

function formatFinding(finding) {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
    return `[${finding.severity.toUpperCase()}] ${finding.code} ${location} - ${finding.message}`;
}

export function formatAuditReport(findings) {
    if (findings.length === 0) {
        return 'Frontend contract audit passed with no findings.';
    }

    return findings.map(formatFinding).join('\n');
}

function parseArguments(argumentsList) {
    const options = { json: false, strict: false };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--json') options.json = true;
        else if (argument === '--strict') options.strict = true;
        else if (['--baseline', '--root'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
            options[argument.slice(2)] = path.resolve(value);
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

export function compareAuditBaseline(findings, baseline) {
    if (baseline.version !== 1 || !Array.isArray(baseline.warnings)
        || baseline.warnings.some(entry => typeof entry.key !== 'string' || !Number.isSafeInteger(entry.count) || entry.count < 1)
        || new Set(baseline.warnings.map(entry => entry.key)).size !== baseline.warnings.length) {
        throw new Error('Invalid frontend audit baseline');
    }
    const counts = new Map();
    for (const finding of findings.filter(item => item.severity === 'warning')) counts.set(finding.key, (counts.get(finding.key) ?? 0) + finding.count);
    const allowances = new Map(baseline.warnings.map(entry => [entry.key, entry.count]));
    return {
        regressions: findings.filter(finding => finding.severity === 'error' || counts.get(finding.key) > (allowances.get(finding.key) ?? 0)),
        resolved: baseline.warnings.filter(entry => (counts.get(entry.key) ?? 0) < entry.count),
    };
}

function runCli() {
    const { json, strict, baseline, root } = parseArguments(process.argv.slice(2));
    const findings = auditFrontendContracts({ repoRoot: root ?? defaultRepoRoot });
    const comparison = baseline ? compareAuditBaseline(findings, JSON.parse(fs.readFileSync(baseline, 'utf8'))) : undefined;

    if (json) {
        console.log(JSON.stringify({ findings, ...(comparison ? { comparison } : {}) }, null, 4));
    } else {
        console.log(formatAuditReport(findings));
    }

    if (findings.some(finding => finding.severity === 'error') || (strict && findings.length > 0)
        || comparison?.regressions.length || comparison?.resolved.length) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
