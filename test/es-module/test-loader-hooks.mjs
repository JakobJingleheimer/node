// Flags: --expose-internals

import '../common/index.mjs'

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import hooksModule from 'internal/modules/esm/hooks';


const { Chain, Hook, Hooks } = hooksModule;

console.log('hooksModule:', hooksModule);
console.log('Chain:', Chain);

describe('Loader Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
  describe('Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
    it.todo('should initialise with default hooks');
  });

  describe('Chain', { concurrency: !process.env.TEST_PARALLEL }, () => {
    it('should instantiate with provided options', () => {
      function resolve() {}
      const type = 'resolve';
      const chain = new Chain(type, () => {}, {
        fn: resolve,
        url: 'test/resolve',
      });

      assert.equal(chain.end.fn, resolve);
      assert.equal(chain.end.type, type);
      assert.equal(chain.end.next, undefined);
      assert.equal(chain.end.prev, undefined);
      assert.equal(chain.type, type);
    });

    describe('append()', () => {
      it('should add a new item to the chain', () => {
        function resolve() {}
        const type = 'resolve';
        const chain = new Chain(type, () => {}, {
          fn: resolve,
          url: 'test/resolve',
        });

        assert.equal(chain.end.fn, resolve);
        assert.equal(chain.type, type);
      });
    });
  });
});
