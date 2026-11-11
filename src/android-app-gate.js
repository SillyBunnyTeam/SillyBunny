import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ANDROID_APP_UPDATE_REQUIRED = 'android_app_update_required';

// The app configures git only through these variables, and simple-git 4 removes each inherited
// GIT_* variable that the allowEnvironment option does not name.
const ANDROID_APP_GIT_ENVIRONMENT = Object.freeze([
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_ATTR_NOSYSTEM',
    'GIT_SSL_CAINFO',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
]);

export function isAndroidApp() {
    return process.env.SILLYBUNNY_ANDROID_APP === '1';
}

export function getAndroidAppGitOptions() {
    return isAndroidApp() ? { allowEnvironment: ANDROID_APP_GIT_ENVIRONMENT } : {};
}

async function updateBlockedStatus(status) {
    const directory = process.env.SILLYBUNNY_ANDROID_STATUS_DIR;
    if (!directory) {
        return;
    }

    const statusPath = path.join(directory, 'update-blocked.json');
    let temporaryPath = null;
    try {
        if (!status) {
            await fs.rm(statusPath, { force: true });
            return;
        }

        await fs.mkdir(directory, { recursive: true });
        temporaryPath = `${statusPath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(status)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporaryPath, statusPath);
        temporaryPath = null;
    } catch (error) {
        console.warn('Failed to update the Android update-blocked status file.', error);
    } finally {
        if (temporaryPath) {
            await fs.rm(temporaryPath, { force: true }).catch(error => console.warn('Failed to remove the temporary Android update-blocked status file.', error));
        }
    }
}

export async function checkAndroidAppGate(git, { ref, branch }) {
    if (!isAndroidApp()) {
        return { blocked: false };
    }

    const installedVersion = process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE ?? '';
    const installedInteger = /^\d+$/.test(installedVersion) ? BigInt(installedVersion) : 0n;
    const installed = Number(installedInteger);
    let required = null;
    let reason = null;
    let commit = null;

    try {
        commit = (await git.revparse([ref])).trim();
        const value = (await git.show([`${commit}:android/min-app-version`])).trim();
        if (/^\d+$/.test(value)) {
            required = Number(value);
            // Compare before numeric serialization so rounding cannot allow newer code.
            if (BigInt(value) > installedInteger) {
                reason = 'newer';
            }
        } else {
            reason = 'invalid';
        }
    } catch {
        // Branches without this file predate the APK launch-token and update gates.
        reason = 'missing';
    }

    if (!reason) {
        await updateBlockedStatus(null);
        return { blocked: false, commit };
    }

    await updateBlockedStatus({ required, installed, reason, upstream: commit, branch });
    return { blocked: true, required, installed, reason, upstream: commit };
}
