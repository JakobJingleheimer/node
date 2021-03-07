'use strict';

// This is needed to avoid cycles in esm/resolve <-> cjs/loader
require('internal/modules/cjs/loader');

const {
  ArrayPrototypePush,
  FunctionPrototypeBind,
  ObjectSetPrototypeOf,
  SafeWeakMap,
  StringPrototypeStartsWith,
} = primordials;

const {
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_RETURN_PROPERTY,
  ERR_INVALID_RETURN_PROPERTY_VALUE,
  ERR_INVALID_RETURN_VALUE,
  ERR_UNKNOWN_MODULE_FORMAT
} = require('internal/errors').codes;
const { pathToFileURL } = require('internal/url');
const { validateString } = require('internal/validators');
const ModuleMap = require('internal/modules/esm/module_map');
const ModuleJob = require('internal/modules/esm/module_job');

const {
  defaultResolve,
  DEFAULT_CONDITIONS,
} = require('internal/modules/esm/resolve');
const { defaultLoad } = require('internal/modules/esm/load');
const { translators } = require(
  'internal/modules/esm/translators');
const { getOptionValue } = require('internal/options');

/**
 * An ESMLoader instance is used as the main entry point for loading ES modules.
 * Currently, this is a singleton -- there is only one used for loading
 * the main module and everything in its dependency graph.
 */
class ESMLoader {
  /**
   * Phase 0 of 2 in ESM loading. These are called once before any modules are
   * started.
   * @property {function[]} - A last-first list of pre-loading hooks.
   */
  #globalPreloaders = [];

  /**
   * Phase 2 of 2 in ESM loading.
   * @property {function[]} - A last-first list of loader hooks.
   */
  #loaders = [
    defaultLoad,
  ];

  /**
   * Phase 1 of 2 in ESM loading.
   * @property {function[]} - A last-first list of resolver hooks.
   */
  #resolvers = [
    defaultResolve,
  ];

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
   * Methods which translate input code or other information into es modules
   */
  translators = translators;

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
    const acceptedHooks = Object.create(null);

    if (getGlobalPreloadCode) {
      globalPreload ??= getGlobalPreloadCode;

      process.emitWarning(
        'Loader hook "getGlobalPreloadCode" has been renamed to "globalPreload"'
      );
    }
    if (dynamicInstantiate) obsoleteHooks.push('dynamicInstantiate');
    if (getFormat) obsoleteHooks.push('getFormat');
    if (getSource) obsoleteHooks.push('getSource');
    if (transformSource) obsoleteHooks.push('transformSource');

    if (obsoleteHooks.length) process.emitWarning(
      `Obsolete loader hook(s) supplied: ${obsoleteHooks.join(', ')}`
    );

    // Use .bind() to avoid giving access to the Loader instance when called.
    if (globalPreload) {
      acceptedHooks.globalPreloaders =
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

  constructor(
    userLoaders = Array(0),
    parentURL = process.cwd(),
  ) {
    for (let i = userLoaders.length - 1; i > -1; i--)
    {
      const exports = this.import(userLoaders[i], parentURL);
      const {
        globalPreloader,
        resolver,
        loader,
      } = ESMLoader.pluckHooks(exports);

      if (globalPreloader) ArrayPrototypePush(
        this.#globalPreloaders,
        globalPreloader,
      );
      if (resolver) ArrayPrototypePush(
        this.#resolvers,
        resolver,
      );
      if (loader) ArrayPrototypePush(
        this.#loaders,
        loader,
      );
    }

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
        importModuleDynamically: (specifier, { url }) => {
          return this.import(specifier, url);
        }
      });

      return module;
    };
    const job = new ModuleJob(this, url, evalInstance, false, false);
    this.moduleMap.set(url, job);
    const { module } = await job.run();

    return {
      namespace: module.getNamespace(),
    };
  }

  async getModuleJob(specifier, parentURL) {
    const {
      format,
      url,
    } = await this.resolve(specifier, parentURL);
    let job = this.moduleMap.get(url);
    // CommonJS will set functions for lazy job evaluation.
    if (typeof job === 'function') this.moduleMap.set(url, job = job());

    if (job !== undefined) return job;

    if (!translators.has(format)) throw new ERR_UNKNOWN_MODULE_FORMAT(format);

    const loaderInstance = translators.get(format);

    const inspectBrk = (
      parentURL === undefined
      && format === 'module'
      && getOptionValue('--inspect-brk')
    );
    job = new ModuleJob(
      this,
      url,
      loaderInstance,
      parentURL === undefined,
      inspectBrk
    );
    this.moduleMap.set(url, job);

    return job;
  }

  /**
   *
   * @param {string} specifier - Path to the module
   * @param {string?} parent - Path of the parent importing the module
   * @returns - The module's exports
   */
  async import(specifier, parent) {
    const job = await this.getModuleJob(specifier, parent);
    const { module } = await job.run();

    return module.getNamespace();
  }

  /**
   *
   * @param {string} url - The URL/path of the module to be loaded
   * @param {Object} context - Metadata about the module
   * @returns {Object}
   */
  async load(url, { parentURL }) {
    let format;
    let source;

    for (let i = this.#loaders.length; i > -1; i--) {
      const loaded = await this.#loaders[i](
        url,
        {
          format,
          parentURL,
          source,
        },
      );

      if (typeof loaded !== 'object') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'object',
        'loader load',
        loaded,
      );

      ({
        format,
        source,
      } = loaded);

      if (typeof format !== 'string') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'string',
        'loader resolve',
        'format',
        format,
      );

      if (
        typeof source !== 'string'
        && !(source instanceof SharedArrayBuffer)
        && !(source instanceof Uint8Array)
      ) throw ERR_INVALID_RETURN_VALUE(
        'string or SharedArrayBuffer or Uint8Array',
        'loader load',
        source
      );
    }

    return {
      format,
      source,
    };
  }

  preload() {
    const count = this.#globalPreloaders.length;
    if (!count) return;

    for (let i = count - 1; i > -1; i--) {
      const preloadCode = this.#globalPreloaders[i]();
      if (preloadCode === null) return;

      if (typeof preloadCode !== 'string') {
        throw new ERR_INVALID_RETURN_VALUE(
          'string',
          'loader globalPreloadCode',
          preloadCode,
        );
      }
      const { compileFunction } = require('vm');
      const preloadInit = compileFunction(
        preloadCode,
        ['getBuiltin'],
        {
          filename: '<preload>',
        }
      );
      const { NativeModule } = require('internal/bootstrap/loaders');

      preloadInit.call(globalThis, (builtinName) => {
        if (NativeModule.canBeRequiredByUsers(builtinName)) {
          return require(builtinName);
        }
        throw new ERR_INVALID_ARG_VALUE('builtinName', builtinName);
      });
    }
  }

  /**
   * Resolve the location of the module
   * @param {*} specifier - The specified URL path of the module to be resolved
   * @param {String} parentURL - The URL path of the module's parent
   * @returns {{ url: String }}
   */
  async resolve(specifier, parentURL) {
    let conditions = DEFAULT_CONDITIONS;
    let url = specifier;

    for (let i = this.#resolvers.length; i > -1; i--) {
      const resolution = await this.#resolvers[i](
        url,
        { parentURL },
        conditions,
      );

      if (typeof resolution !== 'object') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'object',
        'loader resolve',
        resolution,
      );

      ({ url } = resolution);

      if (typeof url !== 'string') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'string',
        'loader resolve',
        'url',
        url,
      );
    }

    return {
      url,
    };
  }
}

ObjectSetPrototypeOf(ESMLoader.prototype, null);

exports.Loader = ESMLoader;
