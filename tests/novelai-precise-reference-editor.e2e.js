import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('NovelAI Precise Reference editor', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
    });

    test('locks every control while it prepares an image and keeps the image for a host that stores copies', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { mountNovelAIPreciseReferenceEditor } = await import('/scripts/novelai-precise-reference-ui.js');
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 48;
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            let state = { enabled: true, references: [{ image: 'RVhJU1RJTkc=', type: 'style', strength: 0.5, fidelity: 0.5 }] };
            const container = document.createElement('div');
            document.body.append(container);
            mountNovelAIPreciseReferenceEditor(container, {
                getState: () => state,
                onChange: next => { state = structuredClone(next); },
                getModel: () => 'nai-diffusion-4-5-full',
            });
            const controls = () => [...container.querySelectorAll('input, select, button')];
            const describe = control => control.getAttribute('aria-label') || control.textContent || `${control.localName}[${control.type}]`;

            const upload = container.querySelector('input[type="file"]');
            const files = new DataTransfer();
            files.items.add(new File([blob], 'reference.png', { type: 'image/png' }));
            upload.files = files.files;
            upload.dispatchEvent(new Event('change'));
            const enabledWhilePreparing = controls().filter(control => !control.disabled).map(describe);

            const deadline = Date.now() + 10_000;
            while (state.references.length < 2 && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const disabledAfterPreparing = controls().filter(control => control.disabled).map(describe);
            container.remove();
            return { enabledWhilePreparing, references: state.references.map(reference => reference.type), disabledAfterPreparing };
        });

        expect(result.enabledWhilePreparing).toEqual([]);
        expect(result.references).toEqual(['style', 'character']);
        expect(result.disabledAfterPreparing).toEqual([]);
    });
});
