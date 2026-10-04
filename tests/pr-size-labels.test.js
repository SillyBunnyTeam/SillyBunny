import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/pr-auto-manager.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['label-by-size'].steps.find(step => step.name === 'Label PR Size');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sizeLabels = ['🟩 ⬤○○○○', '🟩 ⬤⬤○○○', '🟨 ⬤⬤⬤○○', '🟧 ⬤⬤⬤⬤○', '🟥 ⬤⬤⬤⬤⬤'];

async function labelPullRequest({ files, labels = [], afterSnapshot = () => {}, removeError }) {
    const currentLabels = new Set(labels);
    const github = {
        rest: {
            pulls: { listFiles: Symbol('listFiles') },
            issues: {
                listLabelsOnIssue: Symbol('listLabelsOnIssue'),
                addLabels: async ({ labels }) => {
                    for (const label of labels) {
                        currentLabels.add(label);
                    }
                },
                removeLabel: async ({ name }) => {
                    if (removeError) {
                        throw removeError;
                    }
                    if (!currentLabels.delete(name)) {
                        throw Object.assign(new Error('Label not found'), { status: 404 });
                    }
                },
            },
        },
        paginate: async (route) => {
            if (route === github.rest.pulls.listFiles) {
                return files;
            }
            if (route === github.rest.issues.listLabelsOnIssue) {
                const snapshot = [...currentLabels].map(name => ({ name }));
                afterSnapshot(currentLabels);
                return snapshot;
            }
            throw new Error('Unexpected API route');
        },
    };
    const context = { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 889 } };
    await new AsyncFunction('github', 'context', step.with.script)(github, context);
    return currentLabels;
}

const changedFile = changes => ({ filename: 'src/example.js', additions: changes, deletions: 0 });

describe('PR size label updates', () => {
    test('replaces stale size labels without losing concurrent unrelated additions or restoring removals', async () => {
        const labels = await labelPullRequest({
            files: [changedFile(150)],
            labels: [sizeLabels[0], sizeLabels[1], '📥 Dependencies', 'obsolete'],
            afterSnapshot: labels => {
                labels.add('🚫 Merge Conflicts');
                labels.add('⛔ Don\'t Merge');
                labels.delete('obsolete');
            },
        });

        expect(labels).toEqual(new Set([sizeLabels[2], '📥 Dependencies', '🚫 Merge Conflicts', '⛔ Don\'t Merge']));
    });

    for (const [changes, index] of [
        [0, 0], [19, 0], [20, 1], [99, 1], [100, 2],
        [499, 2], [500, 3], [999, 3], [1000, 4],
    ]) {
        test(`assigns the expected size at ${changes} changed lines`, async () => {
            expect(await labelPullRequest({ files: [changedFile(changes)] })).toEqual(new Set([sizeLabels[index]]));
        });
    }

    test('ignores the lockfile and vendored library subtree while counting additions and deletions elsewhere', async () => {
        const labels = await labelPullRequest({
            files: [
                { filename: 'package-lock.json', additions: 2000, deletions: 2000 },
                { filename: 'public/lib/nested/library.js', additions: 2000, deletions: 2000 },
                { filename: 'public/library.js', additions: 10, deletions: 10 },
                { filename: 'src/example.js', additions: 30, deletions: 50 },
            ],
        });

        expect(labels).toEqual(new Set([sizeLabels[2]]));
    });

    test('keeps the current size label and removes accumulated older sizes', async () => {
        expect(await labelPullRequest({
            files: [changedFile(150)],
            labels: [sizeLabels[0], sizeLabels[2], sizeLabels[4], '📥 Dependencies'],
        })).toEqual(new Set([sizeLabels[2], '📥 Dependencies']));
    });

    test('tolerates an obsolete size label already removed by another writer', async () => {
        expect(await labelPullRequest({
            files: [changedFile(150)],
            labels: [sizeLabels[0], '📥 Dependencies'],
            afterSnapshot: labels => labels.delete(sizeLabels[0]),
        })).toEqual(new Set([sizeLabels[2], '📥 Dependencies']));
    });

    test('surfaces API failures other than an already-absent label', async () => {
        const error = Object.assign(new Error('Forbidden'), { status: 403 });
        await expect(labelPullRequest({
            files: [changedFile(150)],
            labels: [sizeLabels[0]],
            removeError: error,
        })).rejects.toBe(error);
    });
});
