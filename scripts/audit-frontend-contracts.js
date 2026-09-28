#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@adobe/css-tools';

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

const motionPropertyPattern = /^(?:-webkit-)?(?<family>transition|animation)(?:-.+)?$/;
const reducedMotionQueryPattern = /prefers-reduced-motion\s*:\s*reduce/i;
const disabledMotionValuePattern = /^none(?:\s*!important)?$/i;

function normalizeSource(source) {
    return String(source).replace(/\r\n/g, '\n');
}

function lineNumberAt(source, offset) {
    return normalizeSource(source).slice(0, offset).split('\n').length;
}

function createFinding(severity, code, file, message, line) {
    return {
        severity,
        code,
        file,
        ...(line ? { line } : {}),
        message,
    };
}

function getAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
    return match?.[2] ?? '';
}

function stripAssetQuery(value) {
    return String(value).split(/[?#]/)[0];
}

function isExternalAsset(value) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}

function resolvePublicAsset(repoRoot, reference) {
    const cleanReference = stripAssetQuery(reference).replace(/^\/+/, '');
    const publicRoot = path.join(repoRoot, 'public');
    const assetPath = path.resolve(publicRoot, cleanReference);
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

    for (const match of normalizedSource.matchAll(/<(?:link|script)\b[^>]*>/gi)) {
        const tag = match[0];
        const attribute = tag.startsWith('<script') ? 'src' : 'href';
        const value = getAttribute(tag, attribute);

        if (!value || isExternalAsset(value)) {
            continue;
        }

        references.push({
            attribute,
            value,
            line: lineNumberAt(normalizedSource, match.index),
        });
    }

    return references;
}

function auditHtmlSource({ repoRoot, relativePath, source }) {
    const findings = [];
    const normalizedSource = normalizeSource(source);

    for (const reference of extractHtmlAssetReferences(normalizedSource)) {
        const resolved = resolvePublicAsset(repoRoot, reference.value);

        if (!resolved.isPublicPath) {
            findings.push(createFinding(
                'error',
                'asset-path-escape',
                relativePath,
                `${reference.attribute} reference escapes public/: ${reference.value}`,
                reference.line,
            ));
            continue;
        }

        if (!fs.existsSync(resolved.assetPath) && !optionalPublicAssets.has(resolved.cleanReference)) {
            findings.push(createFinding(
                'error',
                'missing-asset',
                relativePath,
                `${reference.attribute} reference does not resolve: ${reference.value}`,
                reference.line,
            ));
        }
    }

    const ids = new Map();
    for (const match of normalizedSource.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)) {
        const id = match[2].trim();
        if (!id) {
            continue;
        }

        const line = lineNumberAt(normalizedSource, match.index);
        const locations = ids.get(id) ?? [];
        locations.push(line);
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
        ));
    }

    return findings;
}

function visitCssRules(rules, isReducedMotion, visitor) {
    for (const rule of rules ?? []) {
        const nestedReducedMotion = isReducedMotion
            || (rule.type === 'media' && reducedMotionQueryPattern.test(rule.media));

        if (rule.type === 'rule') {
            visitor(rule, nestedReducedMotion);
        }

        if (Array.isArray(rule.rules)) {
            visitCssRules(rule.rules, nestedReducedMotion, visitor);
        }
    }
}

function getRuleSelectors(rule) {
    return Array.isArray(rule.selectors) && rule.selectors.length > 0
        ? rule.selectors
        : ['<anonymous rule>'];
}

function auditCssAst(ast) {
    const motionRequirements = new Map();
    const reducedMotionGuards = new Set();
    const compatibilityFindings = [];
    const largeRadiusTokens = [];
    const slowTransitionTokens = [];

    visitCssRules(ast.stylesheet?.rules, false, (rule, isReducedMotion) => {
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
            const propertyMatch = declaration.property.match(motionPropertyPattern);
            if (propertyMatch) {
                const family = propertyMatch.groups.family;
                for (const selector of getRuleSelectors(rule)) {
                    const guardKey = `${family}: ${selector}`;
                    if (isReducedMotion && disabledMotionValuePattern.test(declaration.value)) {
                        reducedMotionGuards.add(guardKey);
                    } else if (!isReducedMotion && !disabledMotionValuePattern.test(declaration.value)) {
                        motionRequirements.set(guardKey, true);
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
                if (duration > 240) {
                    slowTransitionTokens.push(`${declaration.property}: ${declaration.value}`);
                }
            }
        }
    });

    const unguardedMotion = [...motionRequirements.keys()]
        .filter(requirement => !reducedMotionGuards.has(requirement));

    return {
        compatibilityFindings,
        largeRadiusTokens: [...new Set(largeRadiusTokens)],
        slowTransitionTokens: [...new Set(slowTransitionTokens)],
        unguardedMotion,
    };
}

export function auditCssSource(source, sourceName = '<inline CSS>') {
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

    return auditCssAst(ast);
}

function auditCssFile(relativePath, source) {
    const audit = auditCssSource(source, relativePath);
    const findings = [];

    if (audit.parseError) {
        findings.push(createFinding('error', 'css-parse-error', relativePath, audit.parseError.message));
        return findings;
    }

    if (audit.unguardedMotion.length > 0) {
        const examples = audit.unguardedMotion.slice(0, 3).join('; ');
        const suffix = audit.unguardedMotion.length > 3 ? '; ...' : '';
        findings.push(createFinding(
            'warning',
            'motion-without-reduced-guard',
            relativePath,
            `${audit.unguardedMotion.length} transition/animation declarations lack a reduced-motion override (${examples}${suffix}).`,
        ));
    }

    for (const compatibilityFinding of audit.compatibilityFindings) {
        findings.push(createFinding(
            'warning',
            compatibilityFinding.code,
            relativePath,
            `${compatibilityFinding.code} for ${compatibilityFinding.selectors.slice(0, 3).join(', ')}.`,
        ));
    }

    if (audit.largeRadiusTokens.length > 0) {
        findings.push(createFinding(
            'warning',
            'radius-token-over-limit',
            relativePath,
            `SillyBunny radius tokens exceed 20px: ${audit.largeRadiusTokens.join(', ')}.`,
        ));
    }

    if (audit.slowTransitionTokens.length > 0) {
        findings.push(createFinding(
            'warning',
            'slow-transition-token-over-limit',
            relativePath,
            `SillyBunny slow transition tokens exceed 240ms: ${audit.slowTransitionTokens.join(', ')}.`,
        ));
    }

    return findings;
}

export function auditFrontendContracts({ repoRoot = defaultRepoRoot, targets = defaultTargets } = {}) {
    const findings = [];

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

        findings.push(...auditCssFile(relativePath, fs.readFileSync(absolutePath, 'utf8')));
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
    return {
        json: argumentsList.includes('--json'),
        strict: argumentsList.includes('--strict'),
    };
}

function runCli() {
    const { json, strict } = parseArguments(process.argv.slice(2));
    const findings = auditFrontendContracts();

    if (json) {
        console.log(JSON.stringify({ findings }, null, 4));
    } else {
        console.log(formatAuditReport(findings));
    }

    if (findings.some(finding => finding.severity === 'error') || (strict && findings.length > 0)) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli();
}
