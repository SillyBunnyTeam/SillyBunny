import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stylesheets = [
    {
        name: 'in-chat agents',
        url: new URL('../public/scripts/extensions/in-chat-agents/style.css', import.meta.url),
    },
    {
        name: 'mobile shell',
        url: new URL('../public/css/sillybunny-mobile-shell.css', import.meta.url),
    },
    {
        name: 'input history',
        url: new URL('../public/scripts/extensions/input-history/style.css', import.meta.url),
    },
].map(stylesheet => ({
    ...stylesheet,
    source: readFileSync(fileURLToPath(stylesheet.url), 'utf8').replace(/\r\n/g, '\n'),
}));

const reducedMotionQueryPattern = /prefers-reduced-motion\s*:\s*reduce/i;
const motionPropertyPattern = /^(?:-webkit-)?(?<family>transition|animation)(?:-.+)?$/;
const disabledMotionValuePattern = /^none(?:\s*!important)?$/i;

function visitRules(rules, isReducedMotion, visitor) {
    for (const rule of rules) {
        const nestedReducedMotion = isReducedMotion
            || (rule.type === 'media' && reducedMotionQueryPattern.test(rule.media));

        if (rule.type === 'rule') {
            visitor(rule, nestedReducedMotion);
        }

        if (Array.isArray(rule.rules)) {
            visitRules(rule.rules, nestedReducedMotion, visitor);
        }
    }
}

function auditMotionGuards(source, sourceName) {
    const ast = parse(source, { source: sourceName });
    const motionRequirements = new Set();
    const reducedMotionGuards = new Set();

    visitRules(ast.stylesheet.rules, false, (rule, isReducedMotion) => {
        for (const declaration of rule.declarations ?? []) {
            if (declaration.type !== 'declaration') {
                continue;
            }

            const propertyMatch = declaration.property.match(motionPropertyPattern);
            if (!propertyMatch) {
                continue;
            }

            const family = propertyMatch.groups.family;
            for (const selector of rule.selectors) {
                const guardKey = `${family}: ${selector}`;
                if (isReducedMotion && disabledMotionValuePattern.test(declaration.value)) {
                    reducedMotionGuards.add(guardKey);
                } else if (!isReducedMotion && !disabledMotionValuePattern.test(declaration.value)) {
                    motionRequirements.add(guardKey);
                }
            }
        }
    });

    return [...motionRequirements].filter(requirement => !reducedMotionGuards.has(requirement));
}

describe('audited UI motion CSS', () => {
    for (const { name, source } of stylesheets) {
        test(`${name} guards every transition and animation for reduced motion`, () => {
            expect(auditMotionGuards(source, name)).toEqual([]);
        });
    }

    test('caps the audited mobile sheet radius at the design-system maximum', () => {
        const mobileShellSource = stylesheets.find(stylesheet => stylesheet.name === 'mobile shell').source;

        expect(mobileShellSource).toContain('border-radius: 20px 20px 0 0 !important;');
        expect(mobileShellSource).not.toContain('border-radius: 22px 22px 0 0 !important;');
    });

    test('retains WebKit companions in the audited motion surfaces', () => {
        const inChatAgentsSource = stylesheets.find(stylesheet => stylesheet.name === 'in-chat agents').source;
        const mobileShellSource = stylesheets.find(stylesheet => stylesheet.name === 'mobile shell').source;

        expect(inChatAgentsSource).toContain('transition: -webkit-clip-path 0.25s ease, clip-path 0.25s ease;');
        expect(inChatAgentsSource).toContain('-webkit-clip-path: inset(0 0 0 100%);');
        expect(inChatAgentsSource).toContain('clip-path: inset(0 0 0 100%);');
        expect(mobileShellSource).toContain('-webkit-backdrop-filter: blur(22px);');
        expect(mobileShellSource).toContain('backdrop-filter: blur(22px);');
    });
});
