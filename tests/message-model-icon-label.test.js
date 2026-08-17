import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const indexHtml = read('public/index.html');
const scriptJs = read('public/script.js');
const powerUserJs = read('public/scripts/power-user.js');

const TOGGLES = [
    ['messageModelNameEnabled', 'timestamp_model_name'],
    ['messageReasoningEffortEnabled', 'timestamp_reasoning_effort'],
];

describe('message model icon label', () => {
    test('both toggles sit with the model icon toggle in Visual Toggles', () => {
        const themeToggles = indexHtml.indexOf('<div name="themeToggles">');
        expect(themeToggles).toBeGreaterThan(-1);

        for (const [id] of TOGGLES) {
            expect(indexHtml).toContain(`<input id="${id}" type="checkbox" />`);
            expect(indexHtml.indexOf(id)).toBeGreaterThan(themeToggles);
        }

        expect(indexHtml).toMatch(/messageModelIconEnabled[\s\S]{0,500}?messageModelNameEnabled[\s\S]{0,500}?messageReasoningEffortEnabled/);
    });

    test('both toggles are wired to the power user settings', () => {
        for (const [id, setting] of TOGGLES) {
            expect(powerUserJs).toContain(`${setting}: false,`);
            expect(powerUserJs).toContain(`$('#${id}').prop('checked', power_user.${setting});`);

            const handler = powerUserJs.match(new RegExp(`\\$\\('#${id}'\\)\\.on\\('input', function \\(\\) \\{([\\s\\S]*?)\\n    \\}\\);`));
            expect(handler?.[1]).toContain(`power_user.${setting} = !!$(this).prop('checked');`);
            // Toggling has to repaint already rendered messages, not just save.
            expect(handler?.[1]).toContain('refreshMessageModelIcons();');
        }
    });

    test('the label is written whether or not model icons are on', () => {
        // Rendering it from inside the icon insert would silently do nothing with icons off.
        expect(scriptJs).toContain(`    if (power_user.timestamp_model_icon && mes.extra?.api) {
        insertSVGIcon(messageElement, mes.extra);
    }

    insertModelLabel(messageElement, mes.extra);`);
        expect(scriptJs).toContain('insertAfter(icon.length ? icon : mes.find(\'.timestamp\'))');
    });

    test('the label is cleared before messages are repainted', () => {
        expect(scriptJs).toContain('.timestamp-icon, .thinking-icon, .timestamp-model\').remove()');
    });

    test('every generated reply records the reasoning effort next to its model', () => {
        // The effort is only known while generating, so a stamp site that forgets it
        // leaves those messages unable to ever show one.
        const modelStamps = [...scriptJs.matchAll(/^([ \t]*)(\w+)\.extra\.model = getGeneratingModel\(\);$/gm)];
        expect(modelStamps.length).toBeGreaterThan(0);

        const missingEffort = modelStamps.filter(([line, indent, target]) =>
            !scriptJs.includes(`${line}\n${indent}${target}.extra.reasoning_effort = getCurrentReasoningEffort();`));

        expect(missingEffort.map(match => match[0].trim())).toEqual([]);
    });
});
