// Flags: --expose-internals

import '../common/index.mjs';
import fixtures from '../common/fixtures.js';

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import hooksModule from 'internal/modules/esm/hooks';


const { Chain, Hook, Hooks } = hooksModule;

describe('Loader Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
  const type = 'resolve';
  function firstResolve() { return {} }
  const urlResolve1 = 'test/resolve/1';
  function secondResolve() {}
  const urlResolve2 = 'test/resolve/2';
  function thirdResolve() {}
  const urlResolve3 = 'test/resolve/3';

  describe('Hooks', { concurrency: !process.env.TEST_PARALLEL }, () => {
    it.todo('should initialise with default hooks');

    describe.todo('addCustomLoader()', () => {
      it('should call `initialize` hook when provided', () => {
        const initData = {};
        const hooks = new Hooks();
        const spy = mock.fn();

        hooks.addCustomLoader('file:///test/foo.mjs', { initialize: spy }, initData);

        assert.equal(spy.mock.calls[0].arguments[0], initData);
      });
    });

    describe('register()', () => {
      it('should pluck hooks & add them to chains', async () => {
        const regSpecifier = pathToFileURL(
          path.resolve(fixtures.path('/es-module-loaders/loader-resolve-42.mjs'))
        ).href;
        const regData = { foo: 'bar' };
        const hooks = new Hooks();

        const spy = mock.method(hooks, 'addCustomLoader');

        await hooks.register(regSpecifier, 'test/main.mjs', regData);

        const {
          0: specifierArg,
          // 1: keyedExportsArg,
          2: dataArg,
        } = spy.mock.calls[0].arguments;

        assert.equal(specifierArg, regSpecifier);
        assert.equal(dataArg, regData);
      });
    });

    describe('resolve()', () => {});

    describe('load()', () => {});
  });

  describe('Chain', { concurrency: !process.env.TEST_PARALLEL }, () => {
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

  describe('Hook', { concurrency: !process.env.TEST_PARALLEL }, () => {
    it('should instantiate with supplied config', () => {
      const hook = new Hook(firstResolve, { type, url: urlResolve1 });

      assert.equal(hook.fn, firstResolve);
      assert.equal(hook.errIdentifier, `${urlResolve1} 'nextResolve' hook`);
      assert.equal(hook.type, type);
    });

    describe('run()', () => {
      function mock_validateArgs(errId) {
        throw new Error(`${errId} provided invalid 'context'`);
      }

      it('should NOT try to validate `context` when there is no previous hook', async () => {
        const validateArgs = mock.fn(mock_validateArgs);
        const hook = new Hook(firstResolve, { type, url: urlResolve1 }, validateArgs);

        let err = '';
        try { await hook.run(urlResolve1, {}, {}) }
        catch (e) { err = e?.message }

        assert.equal(validateArgs.mock.callCount(), 0);
        assert.doesNotMatch(err, /ERR_INVALID_RETURN_VALUE/);
      });

      it('should validate `context` when there IS a previous hook', () => {
        const validateArgs = mock.fn(mock_validateArgs);
        const prevHook = new Hook(firstResolve, { type, url: urlResolve1 });
        const thisHook = new Hook(secondResolve, { type, url: urlResolve2 }, validateArgs);

        prevHook.next = thisHook;
        thisHook.prev = prevHook;

        return assert.rejects(async () => thisHook.run(urlResolve1, Array(), {}), (err) => {
          assert.equal(validateArgs.mock.callCount(), 1);
          assert.match(err.message, new RegExp(urlResolve1));
          assert.match(err.message, /'context'/);

          return true; // because reasons
        });
      });

      it('should mark the chain finished when there is no `next`', async () => {
        const hook = new Hook(firstResolve, { type, url: urlResolve1 });
        const meta = { chainFinished: false };

        await hook.run(urlResolve1, null, meta);

        assert.equal(meta.chainFinished, true);
      });

      it('should prefer context values provided by hook', async () => {
        const hook = new Hook(firstResolve, { type, url: urlResolve1 });
        const ctx = { foo: 'bar' };
        const meta = { context: {} };

        await hook.run(urlResolve1, ctx, meta);

        assert.deepEqual(meta.context, ctx);
      });

      it('should NOT throw on valid hook output', async () => {
        const hook = new Hook(firstResolve, { type, url: urlResolve1 });

        return assert.doesNotReject(async() => await hook.run(urlResolve1, null, {}));
      });

      it('should throw on invalid hook output', async () => {
        const hook = new Hook(secondResolve, { type, url: urlResolve2 });

        return assert.rejects(async() => await hook.run(urlResolve1, null, {}), (err) => {
          assert.match(err.message, /an object/);
          assert.match(err.message, new RegExp(hook.errIdentifier));

          return true; // reasons
        });
      });

      it('should mark the chain short-circuited when the hook signals a shortcircuit', async () => {
        const hook = new Hook(() => ({ shortCircuit: true }), { type, url: urlResolve1 });
        const meta = {};

        await hook.run(urlResolve1, null, meta);

        assert.equal(meta.shortCircuited, true);
      });
    });
  });
});
