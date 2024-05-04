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
    describe('addCustomLoader()', () => {
      const parentURL = 'file:///test/main.mjs';

      it('should call `initialize` hook when provided', async () => {
        const initData = {};
        const hooks = new Hooks();
        const spy = mock.fn();

        await hooks.addCustomLoader(parentURL, { initialize: spy }, initData);

        assert.equal(spy.mock.calls[0].arguments[0], initData);
      });

      // chains are not publically exposed, so verifying they've been added can be done only
      // downstream
      it('should add hooks to their chains', async () => {
        const targetSpecifier = 'file:///test/foo.mjs';
        const spies = {
          resolve: mock.fn(() => ({ shortCircuit: true, url: targetSpecifier })),
          load: mock.fn(() => ({ format: 'module', shortCircuit: true, source: '' })),
        };

        const hooks = new Hooks();

        await hooks.addCustomLoader('file:///test/spies.mjs', spies);

        await hooks.resolve(targetSpecifier, parentURL);
        assert.equal(spies.resolve.mock.callCount(), 1);

        await hooks.load(targetSpecifier);
        assert.equal(spies.load.mock.callCount(), 1);
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

    describe('resolve()', () => {
      it('should pass the happy-path of a default chain (cjs)', async () => {
        const hooks = new Hooks();

        const cjsSpecifier = path.resolve(fixtures.path('/es-modules/cjs.js'));
        const cjsResolution = await hooks.resolve(
          cjsSpecifier,
          undefined,
        );
        assert.deepEqual(cjsResolution, {
          __proto__: null,
          format: 'commonjs',
          importAttributes: undefined,
          url: pathToFileURL(cjsSpecifier).href,
        });
      });

      it('should pass the happy-path of a default chain (esm)', async () => {
        const hooks = new Hooks();

        const esmSpecifier = path.resolve(fixtures.path('/es-modules/import-esm.mjs'));
        const esmResolution = await hooks.resolve(
          esmSpecifier,
          undefined,
        );
        assert.deepEqual(esmResolution, {
          __proto__: null,
          format: 'module',
          importAttributes: undefined,
          url: pathToFileURL(esmSpecifier).href,
        });
      });

      it('should respect a short-circuiting hook', async () => {
        const hooks = new Hooks();
        const format = 'module';
        const url = 'file:///tmp/42.js';

        hooks.addCustomLoader(
          'file:///tmp/short-circuiting-resolve.mjs',
          {
            resolve: async function shortCircuitedResolve(specifier) {
              return {
                __proto__: null,
                shortCircuit: true,
                format,
                url,
              };
            },
          }
        );

        // This specifier would fail if shortCircuit wasn't working: defaulResolve would throw
        // module not found
        const resolution = await hooks.resolve('foo');

        assert.deepEqual(resolution, {
          __proto__: null,
          format,
          importAttributes: undefined,
          url,
        });
      });
    });

    describe('load()', () => {
      it('should pass the happy-path of a default chain (cjs)', async () => {
        const hooks = new Hooks();

        const cjsURL = pathToFileURL(path.resolve(fixtures.path('/es-modules/cjs.js'))).href;
        const cjsLoaded = await hooks.load(cjsURL);

        assert.deepEqual(cjsLoaded, {
          __proto__: null,
          format: 'commonjs',
          responseURL: cjsURL,
          source: null,
        });
      });

      it('should pass the happy-path of a default chain (esm)', async () => {
        const hooks = new Hooks();

        const esmURL = pathToFileURL(path.resolve(fixtures.path('/es-modules/import-esm.mjs'))).href;
        const esmLoaded = await hooks.load(esmURL);

        assert.deepEqual(esmLoaded, {
          __proto__: null,
          format: 'module',
          responseURL: esmURL,
          source: Buffer([105,109,112,111,114,116,32,123,32,104,101,108,108,111,32,125,32,102,114,111,109,32,39,46,47,105,109,112,111,114,116,101,100,45,101,115,109,46,109,106,115,39,59,10,99,111,110,115,111,108,101,46,108,111,103,40,104,101,108,108,111,41,59,10,101,120,112,111,114,116,32,123,32,104,101,108,108,111,32,125,59,10]),
        });
      });

      it('should respect a short-circuiting hook', async () => {
        const hooks = new Hooks();
        const format = 'module';
        const responseURL = 'file:///tmp/42.js';
        const source = '42';

        hooks.addCustomLoader(
          'file:///tmp/short-circuiting-load.mjs',
          {
            load: async function shortCircuitedLoad(url, { format }) {
              return {
                shortCircuit: true,
                format,
                responseURL,
                source,
              };
            },
          }
        );

        // This "url" would fail if shortCircuit wasn't working: defaulLoad would throw invalid URL
        const loaded = await hooks.load('foo', { format })

        assert.deepEqual(loaded, {
          __proto__: null,
          format,
          responseURL,
          source,
        });
      });
    });
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
