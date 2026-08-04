/* global document */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test.describe('Welcome starter pack action layout', () => {
    test('wraps action buttons before their label words fragment', async ({ page }) => {
        const [baseCss, themeCss, welcomeCss] = await Promise.all([
            fs.readFile(path.join(repoRoot, 'public/style.css'), 'utf8'),
            fs.readFile(path.join(repoRoot, 'public/css/sillybunny-theme.css'), 'utf8'),
            fs.readFile(path.join(repoRoot, 'public/css/welcome.css'), 'utf8'),
        ]);

        for (const mainFontSize of [12.75, 18]) {
            await page.setContent(`<!doctype html>
                <html>
                <head>
                    <style>
                        ${baseCss}
                        ${themeCss}
                        ${welcomeCss}

                        :root {
                            --mainFontSize: ${mainFontSize}px;
                            --sb-type-control: calc(var(--mainFontSize) * 0.86);
                            --sb-line-compact: 1.2;
                            --sb-control-min-height: 30px;
                            --sb-radius-button: 14px;
                            --SmartThemeBodyColor: #f0f0f0;
                            --SmartThemeBorderColor: #777777;
                            --SmartThemeBlurTintColor: #202020;
                            --sb-button-bg: #262626;
                        }

                        body {
                            margin: 0;
                        }

                        .welcomeStarterPackCard {
                            box-sizing: border-box;
                            width: 272.5px;
                        }
                    </style>
                </head>
                <body>
                    <article class="welcomeGuideCard welcomeStarterPackCard">
                        <div class="welcomeStarterPackActions">
                            <button class="menu_button menu_button_icon welcomeActionButton">
                                <i class="fa-solid" aria-hidden="true"></i>
                                <span>Apply preset</span>
                            </button>
                            <button class="menu_button menu_button_icon welcomeActionButton">
                                <i class="fa-solid" aria-hidden="true"></i>
                                <span>Visit site</span>
                            </button>
                            <button class="menu_button menu_button_icon welcomeActionButton">
                                <i class="fa-solid" aria-hidden="true"></i>
                                <span>Discord Pals</span>
                            </button>
                        </div>
                    </article>
                </body>
                </html>`);

            const layout = await page.evaluate(() => Array.from(document.querySelectorAll('.welcomeActionButton')).map(button => {
                const label = button.querySelector('span');
                const textNode = label.firstChild;
                const fragmentedWords = Array.from(textNode.textContent.matchAll(/\S+/g))
                    .filter(match => {
                        const range = document.createRange();
                        range.setStart(textNode, match.index);
                        range.setEnd(textNode, match.index + match[0].length);
                        const linePositions = new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top)));
                        return linePositions.size > 1;
                    })
                    .map(match => match[0]);

                return {
                    label: label.textContent.trim(),
                    fragmentedWords,
                    overflows: button.scrollWidth > button.clientWidth + 1,
                };
            }));

            expect(layout, `main font size: ${mainFontSize}px`).toEqual([
                { label: 'Apply preset', fragmentedWords: [], overflows: false },
                { label: 'Visit site', fragmentedWords: [], overflows: false },
                { label: 'Discord Pals', fragmentedWords: [], overflows: false },
            ]);
        }
    });
});
