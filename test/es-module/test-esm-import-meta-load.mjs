import { spawnPromisified } from '../common/index.mjs';
import { fileURL as fixturesFileURL } from '../common/fixtures.mjs';

import assert from 'node:assert/strict';
// import { spawn } from 'node:child_process';
// import { execPath } from 'node:process';
import { describe, it } from 'node:test';


describe('import.meta.load', () => {
	it('should synchronously load the provided url', () => {
    const url = fixturesFileURL('baz.js'); // cjs
    const result = import.meta.load(url);

    assert.strictEqual(result, "module.exports = 'perhaps I work';\n");
	});
});
