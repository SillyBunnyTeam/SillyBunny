import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test.describe('input history overflow menu', () => {
    test('opens above the composer without adding page scroll below it', async ({ page }) => {
        const inputHistoryCss = await fs.readFile(
            path.join(repoRoot, 'public/scripts/extensions/input-history/style.css'),
            'utf8',
        );
        const historyItems = Array.from({ length: 80 }, (_, index) => (
            `<div class="stih--item"><div class="stih--label"><div class="stih--title">history ${index} prompt text</div></div></div>`
        )).join('');

        await page.setViewportSize({ width: 390, height: 740 });
        await page.setContent(`<!doctype html>
            <html>
            <head>
                <style>
                    html,
                    body {
                        margin: 0;
                        min-height: 100%;
                        --bottomFormIconSize: 20px;
                    }

                    #sheld {
                        position: absolute;
                        inset: 0;
                        height: 100dvh;
                        display: flex;
                        flex-direction: column;
                        overflow-x: hidden;
                    }

                    #chat {
                        flex: 1 1 auto;
                    }

                    #form_sheld {
                        width: 100%;
                        margin-top: auto;
                    }

                    #send_form {
                        display: flex;
                        flex-wrap: wrap;
                        width: 100%;
                        overflow: hidden;
                    }

                    #nonQRFormItems {
                        width: 100%;
                        min-height: 48px;
                    }

                    ${inputHistoryCss}
                </style>
            </head>
            <body>
                <div id="sheld">
                    <div id="chat"></div>
                    <div id="form_sheld">
                        <div id="send_form">
                            <div class="stih--buttons stih--standalone">
                                <button type="button" class="stih--button"></button>
                                <div class="stih--history stih--active">${historyItems}</div>
                            </div>
                            <div id="nonQRFormItems">
                                <textarea id="send_textarea"></textarea>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>`);

        const geometry = await page.evaluate(() => {
            const history = document.querySelector('.stih--history');
            const buttons = document.querySelector('.stih--buttons');
            const form = document.querySelector('#form_sheld');
            const pageScrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

            return {
                buttonsTop: buttons.getBoundingClientRect().top,
                formBottom: form.getBoundingClientRect().bottom,
                historyBottom: history.getBoundingClientRect().bottom,
                historyClientHeight: history.clientHeight,
                historyScrollHeight: history.scrollHeight,
                maxScrollY: pageScrollHeight - window.innerHeight,
            };
        });

        expect(geometry.historyBottom).toBeLessThanOrEqual(geometry.buttonsTop - 3);
        expect(geometry.formBottom).toBeLessThanOrEqual(740);
        expect(geometry.maxScrollY).toBeLessThanOrEqual(1);
        expect(geometry.historyScrollHeight).toBeGreaterThan(geometry.historyClientHeight);
    });
});
