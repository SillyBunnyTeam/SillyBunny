#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { approveOutputs, supersedeOutput } from './lib/approve.mjs';
import { ROOT_DIR } from './lib/cli.mjs';

const USAGE = 'Usage: approve.mjs [--ref] [--dry-run] <file-or-sha256> [<file-or-sha256> ...]\n       approve.mjs --supersede <old-file-or-sha256> --by <new-file-or-sha256> [--dry-run]';

try {
    const { values, positionals } = parseArgs({
        options: {
            ref: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            supersede: { type: 'string' },
            by: { type: 'string' },
        },
        allowPositionals: true,
    });
    const dryRun = values['dry-run'];
    if (values.supersede !== undefined || values.by !== undefined) {
        if (!values.supersede || !values.by || positionals.length > 0 || values.ref) {
            throw new Error(USAGE);
        }
        const done = supersedeOutput({ rootDir: ROOT_DIR, oldTarget: values.supersede, newTarget: values.by, dryRun });
        process.stdout.write(`${dryRun ? 'would supersede' : 'superseded'} ${done.old.file} (sha256 ${done.old.sha256.slice(0, 16)}) by ${done.new.file} (sha256 ${done.new.sha256.slice(0, 16)})\n`);
        process.stdout.write(`${dryRun ? 'would remove' : 'removed'}: ${done.removed.join(', ') || '(no copies in approved/ or refs/)'}\n`);
    } else {
        if (positionals.length === 0) {
            throw new Error(USAGE);
        }
        for (const item of approveOutputs({ rootDir: ROOT_DIR, targets: positionals, ref: values.ref, dryRun })) {
            process.stdout.write(`${dryRun ? 'would approve' : 'approved'} ${item.file} (sha256 ${item.sha256.slice(0, 16)}) -> ${item.copiedTo.join(', ')}\n`);
        }
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
