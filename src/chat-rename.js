import fs from 'node:fs';
import process from 'node:process';

export function shouldFallbackChatRename(error, platform = process.platform) {
    return error?.code === 'EXDEV' || (platform === 'win32' && error?.code === 'EPERM');
}

export function renameChatFile(sourcePath, destinationPath, { fsModule = fs, platform = process.platform } = {}) {
    try {
        fsModule.renameSync(sourcePath, destinationPath);
        return { method: 'atomic' };
    } catch (error) {
        if (!shouldFallbackChatRename(error, platform)) {
            throw error;
        }

        fsModule.copyFileSync(sourcePath, destinationPath);

        try {
            fsModule.unlinkSync(sourcePath);
        } catch (unlinkError) {
            try {
                fsModule.unlinkSync(destinationPath);
            } catch (cleanupError) {
                console.warn('Failed to clean up copied chat file after rename fallback failed.', cleanupError);
            }
            throw unlinkError;
        }

        return { method: 'fallback', fallbackCode: error?.code };
    }
}
