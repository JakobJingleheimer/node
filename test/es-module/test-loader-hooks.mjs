// Flags: --expose-internals

import '../common/index.mjs'

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import hooksModule from 'internal/modules/esm/hooks';


const { Chain, Hook, Hooks } = hooksModule;

describe('Loader Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
  describe('Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
    it.todo('should initialise with default hooks');
  });

  describe('Chain', { concurrency: !process.env.TEST_PARALLEL }, () => {
    const type = 'resolve';
    function firstResolve() {}
    const urlResolve1 = 'test/resolve/1';
    function secondResolve() {}
    const urlResolve2 = 'test/resolve/2';
    function thirdResolve() {}
    const urlResolve3 = 'test/resolve/3';

    it('should instantiate with provided options', () => {
      const chain = new Chain(type, () => {}, {
        fn: firstResolve,
        url: urlResolve1,
      });

      assert.equal(chain.type, type);
      assert.equal(chain.end.fn, firstResolve);
      assert.equal(chain.end.type, type);
      assert.equal(chain.end.next, undefined);
      assert.equal(chain.end.prev, undefined);
    });

    it('should instantiate with provided options (multiple initial hooks)', () => {
      const chain = new Chain(type, () => {}, {
        fn: firstResolve,
        url: urlResolve1,
      }, {
        fn: secondResolve,
        url: urlResolve2,
      });

      assert.equal(chain.end.type, type);
      assert.equal(chain.end.fn, secondResolve);

      assert.equal(chain.end.next.fn, firstResolve);
      assert.equal(chain.end.next.type, type);
      assert.equal(chain.end.next.prev.fn, secondResolve);

      assert.equal(chain.end.prev, undefined);
    });

    describe('append()', () => {
      it('should add a new item to the chain', () => {
        const chain = new Chain(type, () => {}, {
          fn: firstResolve,
          url: urlResolve1,
        });

        assert.equal(chain.end.fn, firstResolve);

        chain.append({
          fn: secondResolve,
          url: urlResolve2,
        });

        assert.equal(chain.end.prev, undefined);
        assert.equal(chain.end.fn, secondResolve);

        assert.equal(chain.end.next.fn, firstResolve);
        assert.equal(chain.end.next.prev.fn, secondResolve);
      });

      it('should add a new item to a long chain', () => {
        const chain = new Chain(type, () => {}, {
          fn: firstResolve,
          url: urlResolve1,
        }, {
          fn: secondResolve,
          url: urlResolve2,
        });

        chain.append({
          fn: thirdResolve,
          url: urlResolve3,
        });

        assert.equal(chain.end.fn, thirdResolve);
        assert.equal(chain.end.prev, undefined);

        assert.equal(chain.end.next.fn, secondResolve);
        assert.equal(chain.end.next.prev.fn, thirdResolve);

        assert.equal(chain.end.next.next.fn, firstResolve);
        assert.equal(chain.end.next.next.prev.fn, secondResolve);
      });
    });
  });
});
