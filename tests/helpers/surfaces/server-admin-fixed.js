/**
 * Fixed answers for the reads that the Data & Security page builds itself from. What the real ones say depends on the git state
 * of the checkout that the server runs from (the branch, whether an update is ready, how many files are changed) and on its
 * config.yaml, so a page that shows them would differ between two checkouts and between two moments of one. No Playwright
 * import, so Jest can load it.
 */
export const SERVER_ADMIN_FIXED = Object.freeze({
    '/api/server-admin/status': {
        runtime: 'Node.js',
        configPath: 'config.yaml',
        installType: 'git',
        version: { pkgVersion: '0.0.0', gitBranch: 'staging', gitRevision: 'aaaaaaa' },
        repository: {
            supported: true, isRepo: true, branch: 'staging', displayBranch: 'staging', currentCommit: 'aaaaaaa', trackingBranch: 'origin/staging',
            ahead: 0, behind: 1, canUpdate: true, hasLocalChanges: false, autoStash: false, changedFilesCount: 0, changedFiles: [], message: 'An update is ready.',
        },
    },
    '/api/server-admin/branches': { branches: ['release', 'staging'] },
    '/api/server-admin/config/get': { path: 'config.yaml', content: 'listen: false\n', lastModifiedMs: 1 },
});

/** The requests that `SERVER_ADMIN_FIXED` answers. */
export const SERVER_ADMIN_FIXED_ROUTE = /\/api\/server-admin\/(?:status|branches|config\/get)$/;
