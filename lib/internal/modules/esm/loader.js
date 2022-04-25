'use strict';

// This is needed to avoid cycles in esm/resolve <-> cjs/loader
require('internal/modules/cjs/loader');

const {
  Array,
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  ObjectAssign,
  ObjectCreate,
  ObjectSetPrototypeOf,
  PromiseAll,
  RegExpPrototypeExec,
  SafeArrayIterator,
  SafeWeakMap,
  StringPrototypeStartsWith,
  globalThis,
} = primordials;
const { MessageChannel } = require('internal/worker/io');

const {
  ERR_LOADER_CHAIN_INCOMPLETE,
  ERR_INTERNAL_ASSERTION,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_RETURN_PROPERTY_VALUE,
  ERR_INVALID_RETURN_VALUE,
  ERR_UNKNOWN_MODULE_FORMAT,
} = require('internal/errors').codes;
const { pathToFileURL, isURLInstance, URL } = require('internal/url');
const { emitExperimentalWarning } = require('internal/util');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
} = require('internal/util/types');
const {
  validateObject,
  validateString,
} = require('internal/validators');
const ModuleMap = require('internal/modules/esm/module_map');
const ModuleJob = require('internal/modules/esm/module_job');

const {
  defaultResolve,
  DEFAULT_CONDITIONS,
} = require('internal/modules/esm/resolve');
const {
  initializeImportMeta
} = require('internal/modules/esm/initialize_import_meta');
const { defaultLoad } = require('internal/modules/esm/load');
const { translators } = require(
  'internal/modules/esm/translators');
const { getOptionValue } = require('internal/options');
const {
  fetchModule,
} = require('internal/modules/esm/fetch_module');


/**
 * Prevent the specifier resolution warning from being printed twice
 */
let emittedSpecifierResolutionWarning = false;

/**
 * @typedef {object} ExportedHooks
 * @property {Function} globalPreload
 * @property {Function} resolve
 * @property {Function} load
 */

/**
 * @typedef {object} KeyedExports
 * @property {ExportedHooks} exports
 * @property {URL['href']} url
 */

/**
 * @typedef {object} KeyedHook
 * @property {Function} fn
 * @property {URL['href']} url
 */

/**
 * @typedef {'builtin'|'commonjs'|'json'|'module'|'wasm'} ModuleFormat
 */

/**
 * @typedef {ArrayBuffer|TypedArray|string} ModuleSource
 */

// [2] `validate...()`s throw the wrong error

/**
 * An ESMLoader instance is used as the main entry point for loading ES modules.
 * Currently, this is a singleton -- there is only one used for loading
 * the main module and everything in its dependency graph.
 */
class ESMLoader {
  /**
   * Prior to ESM loading. These are called once before any modules are started.
   * @private
   * @property {KeyedHook[]} globalPreloaders Last-in-first-out
   *  list of preload hooks.
   */
  #globalPreloaders = [];

  /**
   * Phase 2 of 2 in ESM loading.
   * @private
   * @property {KeyedHook[]} loaders Last-in-first-out
   *  collection of loader hooks.
   */
  #loaders = [
    {
      fn: defaultLoad,
      url: 'node:lib/internal/modules/esm/load.js',
    },
  ];

  /**
   * Phase 1 of 2 in ESM loading.
   * @private
   * @property {KeyedHook[]} resolvers Last-in-first-out
   *  collection of resolver hooks.
   */
  #resolvers = [
    {
      fn: defaultResolve,
      url: 'node:lib/internal/modules/esm/resolve.js',
    },
  ];

  #importMetaInitializer = initializeImportMeta;

  /**
   * Map of already-loaded CJS modules to use
   */
  cjsCache = new SafeWeakMap();

  /**
   * The index for assigning unique URLs to anonymous module evaluation
   */
  evalIndex = 0;

  /**
   * Registry of loaded modules, akin to `require.cache`
   */
  moduleMap = new ModuleMap();

  /**
   * Methods which translate input code or other information into ES modules
   */
  translators = translators;

  constructor() {
    if (getOptionValue('--experimental-loader')) {
      emitExperimentalWarning('Custom ESM Loaders');
    }
    if (getOptionValue('--experimental-network-imports')) {
      emitExperimentalWarning('Network Imports');
    }
    if (getOptionValue('--experimental-specifier-resolution') === 'node' && !emittedSpecifierResolutionWarning) {
      process.emitWarning(
        'The Node.js specifier resolution flag is experimental. It could change or be removed at any time.',
        'ExperimentalWarning'
      );
      emittedSpecifierResolutionWarning = true;
    }
  }

  /**
   *
   * @param {Record<string, any>} exports
   * @returns {ExportedHooks}
   */
  static pluckHooks({
    globalPreload,
    resolve,
    load,
    // obsolete hooks:
    dynamicInstantiate,
    getFormat,
    getGlobalPreloadCode,
    getSource,
    transformSource,
  }) {
    const obsoleteHooks = [];
    const acceptedHooks = ObjectCreate(null);

    if (getGlobalPreloadCode) {
      globalPreload ??= getGlobalPreloadCode;

      process.emitWarning(
        'Loader hook "getGlobalPreloadCode" has been renamed to "globalPreload"'
      );
    }
    if (dynamicInstantiate) ArrayPrototypePush(
      obsoleteHooks,
      'dynamicInstantiate'
    );
    if (getFormat) ArrayPrototypePush(
      obsoleteHooks,
      'getFormat',
    );
    if (getSource) ArrayPrototypePush(
      obsoleteHooks,
      'getSource',
    );
    if (transformSource) ArrayPrototypePush(
      obsoleteHooks,
      'transformSource',
    );

    if (obsoleteHooks.length) process.emitWarning(
      `Obsolete loader hook(s) supplied and will be ignored: ${
        ArrayPrototypeJoin(obsoleteHooks, ', ')
      }`,
      'DeprecationWarning',
    );

    // Use .bind() to avoid giving access to the Loader instance when called.
    if (globalPreload) {
      acceptedHooks.globalPreloader =
        FunctionPrototypeBind(globalPreload, null);
    }
    if (resolve) {
      acceptedHooks.resolver = FunctionPrototypeBind(resolve, null);
    }
    if (load) {
      acceptedHooks.loader = FunctionPrototypeBind(load, null);
    }

    return acceptedHooks;
  }

  /**
   * Collect custom/user-defined hook(s). After all hooks have been collected,
   * calls global preload hook(s).
   * @param {KeyedExports} customLoaders
   *  A list of exports from user-defined loaders (as returned by
   *  ESMLoader.import()).
   */
  async addCustomLoaders(
    customLoaders = [],
  ) {
    for (let i = 0; i < customLoaders.length; i++) {
      const {
        exports,
        url,
      } = customLoaders[i];
      const {
        globalPreloader,
        resolver,
        loader,
      } = ESMLoader.pluckHooks(exports);

      if (globalPreloader) {
        ArrayPrototypePush(
          this.#globalPreloaders,
          {
            fn: FunctionPrototypeBind(globalPreloader), // [1]
            url,
          },
        );
      }
      if (resolver) {
        ArrayPrototypePush(
          this.#resolvers,
          {
            fn: FunctionPrototypeBind(resolver), // [1]
            url,
          },
        );
      }
      if (loader) {
        ArrayPrototypePush(
          this.#loaders,
          {
            fn: FunctionPrototypeBind(loader), // [1]
            url,
          },
        );
      }
    }

    // [1] ensure hook function is not bound to ESMLoader instance

    this.preload();
  }

  async eval(
    source,
    url = pathToFileURL(`${process.cwd()}/[eval${++this.evalIndex}]`).href
  ) {
    const evalInstance = (url) => {
      const { ModuleWrap, callbackMap } = internalBinding('module_wrap');
      const module = new ModuleWrap(url, undefined, source, 0, 0);
      callbackMap.set(module, {
        importModuleDynamically: (specifier, { url }, importAssertions) => {
          return this.import(specifier,
                             this.getBaseURL(url),
                             importAssertions);
        }
      });

      return module;
    };
    const job = new ModuleJob(
      this, url, undefined, evalInstance, false, false);
    this.moduleMap.set(url, undefined, job);
    const { module } = await job.run();

    return {
      namespace: module.getNamespace(),
    };
  }

  /**
   * Returns the url to use for the resolution of a given cache key url
   * These are not guaranteed to be the same.
   *
   * In WHATWG HTTP spec for ESM the cache key is the non-I/O bound
   * synchronous resolution using only string operations
   *   ~= resolveImportMap(new URL(specifier, importerHREF))
   *
   * The url used for subsequent resolution is the response URL after
   * all redirects have been resolved.
   *
   * https://example.com/foo redirecting to https://example.com/bar
   * would have a cache key of https://example.com/foo and baseURL
   * of https://example.com/bar
   *
   * MUST BE SYNCHRONOUS for import.meta initialization
   * MUST BE CALLED AFTER receiving the url body due to I/O
   * @param {string} url
   * @returns {string}
   */
  getBaseURL(url) {
    if (
      StringPrototypeStartsWith(url, 'http:') ||
      StringPrototypeStartsWith(url, 'https:')
    ) {
      // The request & response have already settled, so they are in
      // fetchModule's cache, in which case, fetchModule returns
      // immediately and synchronously
      url = fetchModule(new URL(url), { parentURL: url }).resolvedHREF;
      // This should only occur if the module hasn't been fetched yet
      if (typeof url !== 'string') { // [2]
        throw new ERR_INTERNAL_ASSERTION(`Base url for module ${url} not loaded.`);
      }
    }
    return url;
  }

  /**
   * Get a (possibly still pending) module job from the cache,
   * or create one and return its Promise.
   * @param {string} specifier The string after `from` in an `import` statement,
   *                           or the first parameter of an `import()`
   *                           expression
   * @param {string | undefined} parentURL The URL of the module importing this
   *                                     one, unless this is the Node.js entry
   *                                     point.
   * @param {Record<string, string>} importAssertions Validations for the
   *                                                  module import.
   * @returns {Promise<ModuleJob>} The (possibly pending) module job
   */
  async getModuleJob(specifier, parentURL, importAssertions) {
    let importAssertionsForResolve;

    if (this.#loaders.length !== 1) {
      // We can skip cloning if there are no user-provided loaders because
      // the Node.js default resolve hook does not use import assertions.
      importAssertionsForResolve = ObjectAssign(
        ObjectCreate(null),
        importAssertions,
      );
    }

    const { format, url } =
      await this.resolve(specifier, parentURL, importAssertionsForResolve);

    let job = this.moduleMap.get(url, importAssertions.type);

    // CommonJS will set functions for lazy job evaluation.
    if (typeof job === 'function') {
      this.moduleMap.set(url, undefined, job = job());
    }

    if (job === undefined) {
      job = this.#createModuleJob(url, importAssertions, parentURL, format);
    }

    return job;
  }

  /**
   * Create and cache an object representing a loaded module.
   * @param {string} url The absolute URL that was resolved for this module
   * @param {Record<string, string>} importAssertions Validations for the
   *                                                  module import.
   * @param {string} [parentURL] The absolute URL of the module importing this
   *                             one, unless this is the Node.js entry point
   * @param {string} [format] The format hint possibly returned by the
   *                          `resolve` hook
   * @returns {Promise<ModuleJob>} The (possibly pending) module job
   */
  #createModuleJob(url, importAssertions, parentURL, format) {
    const moduleProvider = async (url, isMain) => {
      const {
        format: finalFormat,
        source,
      } = await this.load(url, {
        format,
        importAssertions,
      });

      const translator = translators.get(finalFormat);

      if (!translator) {
        throw new ERR_UNKNOWN_MODULE_FORMAT(finalFormat, url);
      }

      return FunctionPrototypeCall(translator, this, url, source, isMain);
    };

    const inspectBrk = (
      parentURL === undefined &&
      getOptionValue('--inspect-brk')
    );

    const job = new ModuleJob(
      this,
      url,
      importAssertions,
      moduleProvider,
      parentURL === undefined,
      inspectBrk
    );

    this.moduleMap.set(url, importAssertions.type, job);

    return job;
  }

  /**
   * This method is usually called indirectly as part of the loading processes.
   * Internally, it is used directly to add loaders. Use directly with caution.
   *
   * This method must NOT be renamed: it functions as a dynamic import on a
   * loader module.
   *
   * @param {string | string[]} specifiers Path(s) to the module.
   * @param {string} parentURL Path of the parent importing the module.
   * @param {Record<string, string>} importAssertions Validations for the
   *                                                  module import.
   * @returns {Promise<ExportedHooks | KeyedExports[]>}
   *  A collection of module export(s).
   */
  async import(specifiers, parentURL, importAssertions) {
    const wasArr = ArrayIsArray(specifiers);
    if (!wasArr) specifiers = [specifiers];

    const count = specifiers.length;
    const jobs = new Array(count);

    for (let i = 0; i < count; i++) {
      jobs[i] = this.getModuleJob(specifiers[i], parentURL, importAssertions)
        .then((job) => job.run())
        .then(({ module }) => module.getNamespace());
    }

    const namespaces = await PromiseAll(new SafeArrayIterator(jobs));

    if (!wasArr) return namespaces[0];

    for (let i = 0; i < count; i++) {
      const namespace = ObjectCreate(null);
      namespace.url = specifiers[i];
      namespace.exports = namespaces[i];

      namespaces[i] = namespace;
    }

    return namespaces;
  }

  /**
   * Provide source that is understood by one of Node's translators.
   *
   * @param {URL['href']} url The URL/path of the module to be loaded
   * @param {object} context Metadata about the module
   * @returns {{ format: ModuleFormat, source: ModuleSource }}
   */
  async load(url, context = {}) {
    const loaders = this.#loaders;
    let i = loaders.length - 1;
    let {
      fn: loader,
      url: loaderFilePath,
    } = loaders[i];
    let chainFinished = i === 0;

    function next(nextUrl, ctx = context) {
      ({
        fn: loader,
        url: loaderFilePath,
      } = loaders[--i]);

      if (i === 0) chainFinished = true;

      const hookErrIdentifier = `${loaderFilePath} "load"`;

      if (typeof nextUrl !== 'string') {
        // non-strings can be coerced to a url string
        // validateString() throws a less-specific error
        throw new ERR_INVALID_ARG_TYPE(
          `${hookErrIdentifier} next(url)`,
          'a url string',
          nextUrl,
        );
      }

      try {
        new URL(nextUrl);
      } catch {
        throw new ERR_INVALID_ARG_VALUE(
          `${hookErrIdentifier} next(url)`,
          nextUrl,
          'should be a url string',
        );
      }

      validateObject(ctx, `${hookErrIdentifier} next(, context)`);

      return loader(nextUrl, ctx, next);
    }

    const loaded = await loader(
      url,
      context,
      next,
    );

    const hookErrIdentifier = `${loaderFilePath} load`;

    if (typeof loaded !== 'object') { // [2]
      throw new ERR_INVALID_RETURN_VALUE(
        'an object',
        hookErrIdentifier,
        loaded,
      );
    }

    const {
      format,
      shortCircuit,
      source,
    } = loaded;

    if (!chainFinished && !shortCircuit) {
      throw new ERR_LOADER_CHAIN_INCOMPLETE('load', loaderFilePath);
    }

    if (format == null) {
      const dataUrl = RegExpPrototypeExec(
        /^data:([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,/,
        url,
      );

      throw new ERR_UNKNOWN_MODULE_FORMAT(
        dataUrl ? dataUrl[1] : format,
        url);
    }

    if (typeof format !== 'string') { // [2]
      throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'a string',
        hookErrIdentifier,
        'format',
        format,
      );
    }

    if (
      source != null &&
      typeof source !== 'string' &&
      !isAnyArrayBuffer(source) &&
      !isArrayBufferView(source)
    ) throw ERR_INVALID_RETURN_PROPERTY_VALUE(
      'a string, an ArrayBuffer, or a TypedArray',
      hookErrIdentifier,
      'source',
      source
    );

    return {
      format,
      source,
    };
  }

  preload() {
    for (let i = this.#globalPreloaders.length - 1; i > -1; i--) {
      const channel = new MessageChannel();
      const {
        port1: insidePreload,
        port2: insideLoader,
      } = channel;

      insidePreload.unref();
      insideLoader.unref();

      const {
        fn: preloader,
        url: specifier,
      } = this.#globalPreloaders[i];

      const preload = preloader({
        port: insideLoader,
      });

      if (preload == null) return;

      const hookErrIdentifier = `${specifier} globalPreload`;

      if (typeof preload !== 'string') { // [2]
        throw new ERR_INVALID_RETURN_VALUE(
          'a string',
          hookErrIdentifier,
          preload,
        );
      }
      const { compileFunction } = require('vm');
      const preloadInit = compileFunction(
        preload,
        ['getBuiltin', 'port', 'setImportMetaCallback'],
        {
          filename: '<preload>',
        }
      );
      const { NativeModule } = require('internal/bootstrap/loaders');
      // We only allow replacing the importMetaInitializer during preload,
      // after preload is finished, we disable the ability to replace it
      //
      // This exposes accidentally setting the initializer too late by
      // throwing an error.
      let finished = false;
      let replacedImportMetaInitializer = false;
      let next = this.#importMetaInitializer;
      try {
        // Calls the compiled preload source text gotten from the hook
        // Since the parameters are named we use positional parameters
        // see compileFunction above to cross reference the names
        FunctionPrototypeCall(
          preloadInit,
          globalThis,
          // Param getBuiltin
          (builtinName) => {
            if (NativeModule.canBeRequiredByUsers(builtinName)) {
              return require(builtinName);
            }
            throw new ERR_INVALID_ARG_VALUE('builtinName', builtinName);
          },
          // Param port
          insidePreload,
          // Param setImportMetaCallback
          (fn) => {
            if (finished || typeof fn !== 'function') {
              throw new ERR_INVALID_ARG_TYPE('fn', fn);
            }
            replacedImportMetaInitializer = true;
            const parent = next;
            next = (meta, context) => {
              return fn(meta, context, parent);
            };
          });
      } finally {
        finished = true;
        if (replacedImportMetaInitializer) {
          this.#importMetaInitializer = next;
        }
      }
    }
  }

  importMetaInitialize(meta, context) {
    this.#importMetaInitializer(meta, context);
  }

  /**
   * Resolve the location of the module.
   *
   * The internals of this WILL change when chaining is implemented,
   * depending on the resolution/consensus from #36954.
   * @param {string} originalSpecifier The specified URL path of the module to
   *                                   be resolved.
   * @param {string} [parentURL] The URL path of the module's parent.
   * @param {ImportAssertions} [importAssertions] Assertions from the import
   *                                              statement or expression.
   * @returns {{ format: string, url: URL['href'] }}
   */
  async resolve(
    originalSpecifier,
    parentURL,
    importAssertions = ObjectCreate(null)
  ) {
    const isMain = parentURL === undefined;

    if (
      !isMain &&
      typeof parentURL !== 'string' &&
      !isURLInstance(parentURL)
    ) throw new ERR_INVALID_ARG_TYPE(
      'parentURL',
      ['string', 'URL'],
      parentURL,
    );
    const resolvers = this.#resolvers;

    let i = resolvers.length - 1;
    let {
      url: resolverFilePath,
      fn: resolver,
    } = resolvers[i];
    let chainFinished = i === 0;

    const context = {
      conditions: DEFAULT_CONDITIONS,
      importAssertions,
      parentURL,
    };

    function next(suppliedSpecifier, ctx = context) {
      ({
        fn: resolver,
        url: resolverFilePath,
      } = resolvers[--i]);

      if (i === 0) chainFinished = true;

      const hookErrIdentifier = `${resolverFilePath} "resolve"`;

      validateString(
        suppliedSpecifier,
        `${hookErrIdentifier} next(specifier)`,
      ); // non-strings can be coerced to a url string

      validateObject(ctx, `${hookErrIdentifier} next(, context)`);

      return resolver(suppliedSpecifier, ctx, next);
    }

    const resolution = await resolver(
      originalSpecifier,
      context,
      next,
    );

    const hookErrIdentifier = `${resolverFilePath} resolve`;

    if (typeof resolution !== 'object') { // [2]
      throw new ERR_INVALID_RETURN_VALUE(
        'an object',
        hookErrIdentifier,
        resolution,
      );
    }

    const {
      format,
      shortCircuit,
      url,
    } = resolution;

    if (!chainFinished && !shortCircuit) {
      throw new ERR_LOADER_CHAIN_INCOMPLETE('resolve', resolverFilePath);
    }

    if (
      format != null &&
      typeof format !== 'string' // [2]
    ) {
      throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'a string',
        hookErrIdentifier,
        'format',
        format,
      );
    }

    if (typeof url !== 'string') {
      // non-strings can be coerced to a url string
      // validateString() throws a less-specific error
      throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'a url string',
        hookErrIdentifier,
        'url',
        url,
      );
    }

    try {
      new URL(url);
    } catch (err) { // eslint-disable-line no-unused-vars
      throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'a url string',
        hookErrIdentifier,
        'url',
        url,
      );
    }

    return {
      format,
      url,
    };
  }
}

ObjectSetPrototypeOf(ESMLoader.prototype, null);

exports.ESMLoader = ESMLoader;
