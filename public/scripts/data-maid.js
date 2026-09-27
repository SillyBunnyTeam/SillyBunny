import { createDeferredModule } from './deferred-module.js';

const loadDataMaidDialog = createDeferredModule(new URL('./data-maid-dialog.js', import.meta.url));

export function initDataMaid() {
    const dataMaidButton = document.getElementById('data_maid_button');
    if (!dataMaidButton) {
        console.warn('Data Maid button not found');
        return;
    }

    // SillyBunny: cleanup is optional; load its dialog only after an explicit request.
    let opening = false;
    dataMaidButton.addEventListener('click', async () => {
        if (opening) return;
        opening = true;
        dataMaidButton.setAttribute('aria-busy', 'true');
        try {
            const { DataMaidDialog } = await loadDataMaidDialog();
            await new DataMaidDialog().open();
        } catch (error) {
            console.error('Data Maid failed to open:', error);
            toastr.error(String(error.message || error));
        } finally {
            opening = false;
            dataMaidButton.removeAttribute('aria-busy');
        }
    });
}
