/* global document */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test.describe('Quick Reply button bar layout', () => {
    test('centers popout quick reply buttons against the composer at desktop widths', async ({ page }) => {
        const quickReplyCss = await fs.readFile(
            path.join(repoRoot, 'public/scripts/extensions/quick-reply/style.css'),
            'utf8',
        );

        for (const composerWidth of [900, 1228]) {
            await page.setViewportSize({ width: Math.max(1200, composerWidth + 80), height: 400 });
            await page.setContent(`<!doctype html>
                <html>
                <head>
                    <style>
                        html,
                        body {
                            margin: 0;
                        }

                        body {
                            --SmartThemeBodyColor: #ffffff;
                            --SmartThemeBorderColor: #777777;
                            --animation-duration-2x: 0ms;
                            --sb-control-min-height: 32px;
                            font: 13.333px sans-serif;
                        }

                        #send_form {
                            display: flex;
                            flex-wrap: wrap;
                            align-items: center;
                            box-sizing: border-box;
                            width: ${composerWidth}px;
                            padding: 4px;
                            border: 1px solid var(--SmartThemeBorderColor);
                            overflow: hidden;
                        }

                        #nonQRFormItems {
                            width: 100%;
                            min-height: 48px;
                        }

                        .menu_button {
                            box-sizing: border-box;
                            width: 32px;
                            height: 32px;
                        }

                        ${quickReplyCss}
                    </style>
                </head>
                <body>
                    <div id="send_form">
                        <div id="qr--bar" class="flex-container flexGap5 popoutVisible">
                            <div id="qr--popoutTrigger" class="menu_button"></div>
                            <div class="qr--buttons">
                                <button type="button" class="qr--button">Memory Sharding</button>
                            </div>
                        </div>
                        <div id="nonQRFormItems"></div>
                    </div>
                </body>
                </html>`);

            const geometry = await page.evaluate(() => {
                const composer = document.querySelector('#send_form').getBoundingClientRect();
                const bar = document.querySelector('#qr--bar');
                const button = document.querySelector('.qr--button').getBoundingClientRect();
                const composerCenter = composer.left + composer.width / 2;
                const buttonCenter = button.left + button.width / 2;

                return {
                    buttonOffsetFromComposerCenter: Math.abs(buttonCenter - composerCenter),
                    verticalScrollbarGutter: bar.offsetWidth - bar.clientWidth,
                };
            });

            expect(geometry.buttonOffsetFromComposerCenter).toBeLessThanOrEqual(1);
            expect(geometry.verticalScrollbarGutter).toBeLessThanOrEqual(1);
        }
    });
});
