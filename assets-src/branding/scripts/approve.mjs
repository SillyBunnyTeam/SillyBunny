#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { approveOutputs, revertSupersede, supersedeOutput } from './lib/approve.mjs';
import { ROOT_DIR } from './lib/cli.mjs';

const USAGE = 'Usage: approve.mjs [--ref] [--dry-run] <file-or-sha256> [<file-or-sha256> ...]\n       approve.mjs --supersede <old-file-or-sha256> --by <new-file-or-sha256> [--in-place] [--dry-run]\n       approve.mjs --revert <new-file-or-sha256> [--to <old-file-or-sha256>] [--dry-run]';

try {
    const { values, positionals } = parseArgs({
        options: {
            ref: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            supersede: { type: 'string' },
            by: { type: 'string' },
            'in-place': { type: 'boolean', default: false },
            revert: { type: 'string' },
            to: { type: 'string' },
        },
        allowPositionals: true,
    });
    const dryRun = values['dry-run'];
    if (values['in-place'] && values.supersede === undefined) {
        throw new Error(USAGE);
    }
    if (values.to !== undefined && values.revert === undefined) {
        throw new Error(USAGE);
    }
    if (values.revert !== undefined) {
        if (!values.revert || values.to === '' || values.supersede !== undefined || values.by !== undefined || values['in-place'] || values.ref || positionals.length > 0) {
            throw new Error(USAGE);
        }
        const done = revertSupersede({ rootDir: ROOT_DIR, newTarget: values.revert, toTarget: values.to, dryRun });
        process.stdout.write(`${dryRun ? 'would revert' : 'reverted'} ${done.new.file} (sha256 ${done.new.sha256.slice(0, 16)}) to ${done.old.file} (sha256 ${done.old.sha256.slice(0, 16)})\n`);
        process.stdout.write(`${dryRun ? 'would write' : 'wrote'} the old file to: ${done.restored.join(', ')}\n`);
        if (done.removed.length > 0) {
            process.stdout.write(`${dryRun ? 'would remove' : 'removed'}: ${done.removed.join(', ')}\n`);
        }
    } else if (values.supersede !== undefined || values.by !== undefined) {
        if (!values.supersede || !values.by || positionals.length > 0 || values.ref) {
            throw new Error(USAGE);
        }
        const done = supersedeOutput({ rootDir: ROOT_DIR, oldTarget: values.supersede, newTarget: values.by, inPlace: values['in-place'], dryRun });
        process.stdout.write(`${dryRun ? 'would supersede' : 'superseded'} ${done.old.file} (sha256 ${done.old.sha256.slice(0, 16)}) by ${done.new.file} (sha256 ${done.new.sha256.slice(0, 16)})\n`);
        if (values['in-place']) {
            if (done.approvedNew) {
                process.stdout.write(`${dryRun ? 'would approve' : 'approved'} ${done.new.file} (it was not approved yet)\n`);
            }
            process.stdout.write(`${dryRun ? 'would write' : 'wrote'} the new file in place of the old copies: ${done.written.join(', ')}\n`);
        } else {
            process.stdout.write(`${dryRun ? 'would remove' : 'removed'}: ${done.removed.join(', ') || '(no copies in approved/ or refs/)'}\n`);
        }
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
