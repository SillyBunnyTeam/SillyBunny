import { afterAll } from 'bun:test';
import { removeTempDirs } from './temp-dir.mjs';

// Runs once, after the last test file of the run.
afterAll(removeTempDirs);
