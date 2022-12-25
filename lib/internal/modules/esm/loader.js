'use strict';

// This is needed to avoid cycles in esm/resolve <-> cjs/loader
require('internal/modules/cjs/loader');

const {
  Array,
  ArrayIsArray,
  FunctionPrototypeCall,
  ObjectCreate,
  ObjectSetPrototypeOf,
  SafePromiseAllReturnArrayLike,
  SafeWeakMap,
} = primordials;

const {
  ERR_UNKNOWN_MODULE_FORMAT,
} = require('internal/errors').codes;
const { getOptionValue } = require('internal/options');
const { pathToFileURL } = require('internal/url');
const { emitExperimentalWarning } = require('internal/util');
const {
  getDefaultConditions,
} = require('internal/modules/esm/utils');

function newModuleMap() {
  const ModuleMap = require('internal/modules/esm/module_map');
  return new ModuleMap();
}

function getTranslators() {
  const { translators } = require('internal/modules/esm/translators');
  return translators;
}

// [1] lazy-load to avoid sandbagging node startup

/**
 * @typedef {object} ExportedHooks
 * @property {Function} globalPreload Global preload hook.
 * @property {Function} resolve Resolve hook.
 * @property {Function} load Load hook.
 */

/**
 * @typedef {Record<string, any>} ModuleExports
 */

/**
 * @typedef {object} KeyedExports
 * @property {ModuleExports} exports The contents of the module.
 * @property {URL['href']} url The URL of the module.
 */

/**
 * @typedef {'builtin'|'commonjs'|'json'|'module'|'wasm'} ModuleFormat
 */

/**
 * @typedef {ArrayBuffer|TypedArray|string} ModuleSource
 */


/**
 * An ESMLoader instance is used as the main entry point for loading ES modules.
 * Currently, this is a singleton -- there is only one used for loading
 * the main module and everything in its dependency graph.
 */

class BaseESMLoader {
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
  moduleMap = newModuleMap();

  /**
   * Methods which translate input code or other information into ES modules
   */
  translators = getTranslators();

  constructor() {
    if (getOptionValue('--experimental-loader').length > 0) {
      emitExperimentalWarning('Custom ESM Loaders');
    }
    if (getOptionValue('--experimental-network-imports')) {
      emitExperimentalWarning('Network Imports');
    }
  }

  async eval(
    source,
    url = pathToFileURL(`${process.cwd()}/[eval${++this.evalIndex}]`).href
  ) {
    const evalInstance = (url) => {
      const { ModuleWrap } = internalBinding('module_wrap');
      const { setCallbackForWrap } = require('internal/modules/esm/utils');
      const module = new ModuleWrap(url, undefined, source, 0, 0);
      setCallbackForWrap(module, {
        importModuleDynamically: (specifier, { url }, importAssertions) => {
          return this.import(specifier, url, importAssertions);
        }
      });

      return module;
    };
    const ModuleJob = require('internal/modules/esm/module_job');
    const job = new ModuleJob(
      this, url, undefined, evalInstance, false, false);
    this.moduleMap.set(url, undefined, job);
    const { module } = await job.run();

    return {
      __proto__: null,
      namespace: module.getNamespace(),
    };
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
  getModuleJob(url, parentURL, importAssertions, format) {
    const job = (
      this.moduleMap.get(url, importAssertions.type) ??
      this.#createModuleJob(url, importAssertions, parentURL, format)
    );

    // CommonJS will set functions for lazy job evaluation.
    if (typeof job === 'function') {
      this.moduleMap.set(url, undefined, job = job());
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
        responseURL,
        source,
      } = await this.load(url, {
        format,
        importAssertions,
      });

      const translator = getTranslators().get(finalFormat);

      if (!translator) {
        throw new ERR_UNKNOWN_MODULE_FORMAT(finalFormat, responseURL);
      }

      return FunctionPrototypeCall(translator, this, responseURL, source, isMain);
    };

    const inspectBrk = (
      parentURL === undefined &&
      getOptionValue('--inspect-brk')
    );

    if (process.env.WATCH_REPORT_DEPENDENCIES && process.send) {
      process.send({ 'watch:import': [url] });
    }
    const ModuleJob = require('internal/modules/esm/module_job');
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
   *  A collection of module export(s) or a list of collections of module
   *  export(s).
   */
  async import(specifiers, parentURL, importAssertions) {
    // For loaders, `import` is passed multiple things to process, it returns a
    // list pairing the url and exports collected. This is especially useful for
    // error messaging, to identity from where an export came. But, in most
    // cases, only a single url is being "imported" (ex `import()`), so there is
    // only 1 possible url from which the exports were collected and it is
    // already known to the caller. Nesting that in a list would only ever
    // create redundant work for the caller, so it is later popped off the
    // internal list.
    const wasArr = ArrayIsArray(specifiers);
    if (!wasArr) { specifiers = [specifiers]; }

    const count = specifiers.length;
    const jobs = new Array(count);

    for (let i = 0; i < count; i++) {
      jobs[i] = this.runModuleJob(specifiers[i], parentURL, importAssertions)
        .run()
        .then(({ module }) => module.getNamespace());
    }

    const namespaces = await SafePromiseAllReturnArrayLike(jobs);

    if (!wasArr) { return namespaces[0]; } // We can skip the pairing below

    for (let i = 0; i < count; i++) {
      namespaces[i] = {
        __proto__: null,
        url: specifiers[i],
        exports: namespaces[i],
      };
    }

    return namespaces;
  }
}
ObjectSetPrototypeOf(BaseESMLoader.prototype, null);

/**
 * The ESMLoader to use either when no custom hooks are supplied.
 */
class DefaultESMLoader extends BaseESMLoader {
  #hooks;

  constructor() {
    super();

    // There are no chains in this scenario, but there is a lot of functionality in Hooks not worth
    // the complexity of extracting. In order to avoid diverting branches & logic, just take the
    // tiny perf hit and instantiate Hooks as an orchestrator to do what it already understands.
    const { Hooks } = require('internal/modules/esm/hooks');
    this.#hooks = new Hooks();
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
  getModuleJob(specifier, parentURL, importAssertions) {
    const { format, url } = this.resolve(specifier, parentURL);

    return super.getModuleJob(url, parentURL, importAssertions, format);
  }

  runModuleJob(specifier, parentURL, importAssertions) {
    return this
      .getModuleJob(specifier, parentURL, importAssertions)
      .run()
      .then(({ module }) => module.getNamespace());
  }

  importMetaInitialize(meta, context) {
    return this.#hooks.importMetaInitializer(meta, context);
  }

  /**
   * Provide source that is understood by one of Node's translators.
   *
   * @param {URL['href']} url The URL/path of the module to be loaded
   * @param {object} [context] Metadata about the module
   * @returns {{ format: ModuleFormat, source: ModuleSource }}
   */
  async load(url, context) {
    return this.#hooks.load(url, context);
  }

  /**
   * Resolve the location of the module.
   *
   * @param {string} originalSpecifier The specified URL path of the module to
   *                                   be resolved.
   * @param {string} [parentURL] The URL path of the module's parent.
   * @param {ImportAssertions} [importAssertions] Assertions from the import
   *                                              statement or expression.
   * @returns {{ format: string, url: URL['href'] }}
   */
  resolve(originalSpecifier, parentURL, importAssertions) {
    return this.#hooks.resolve(originalSpecifier, parentURL, importAssertions);
  }
}

/**
 * The ESMLoader to use when custom loaders are supplied.
 */
class CustomizedESMLoader extends DefaultESMLoader {
  constructor(...args) { super(...args); }

  /**
   * Get a (possibly still pending) module job from the cache, or create one and return its Promise.
   * @param {string} specifier The string after `from` in an `import` statement, or the first
   *   parameter of an `import()` expression
   * @param {string | undefined} parentURL The URL of the module importing this one, unless this is
   *   the Node.js entry point.
   * @param {Record<string, string>} importAssertions Validations for the module import.
   * @returns {Promise<ModuleJob>} The (possibly pending) module job
   */
   async getModuleJob(specifier, parentURL, importAssertions) {
    const { format, url } = await this.resolve(specifier, parentURL);

    return super
      .super // Bypass DefaultESMLoader::getModuleJob() to get to BaseESMLoader::getModuleJob()
      .getModuleJob(url, parentURL, importAssertions, format);
  }
}

/**
 * The ESMLoader to use in the main thread when custom hooks are supplied.
 */
class ProxiedESMLoader extends BaseESMLoader {
  #hooks;

  constructor() {
    super();

    const { HooksProxy } = require('internal/modules/esm/hooks');
    this.#hooks = new HooksProxy();
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
   * @returns {ModuleJob} The (possibly pending) module job
   */
   getModuleJob(specifier, parentURL, importAssertions) {
    const { format, url } = this.resolve(specifier, parentURL);

    return super.getModuleJob(url, parentURL, importAssertions, format);
  }

  importMetaInitialize(meta, context) {
    return hooksProxy.makeRequest('importMetaInitialize', meta, context);
  }

  /**
   * Provide source that is understood by one of Node's translators.
   *
   * @param {URL['href']} url The URL/path of the module to be loaded
   * @param {object} [context] Metadata about the module
   * @returns {{ format: ModuleFormat, source: ModuleSource }}
   */
  load(url, context) {
    const result = this.#hooks.makeRequest('load', url, context);

    const { format } = result;
    if (format == null) {
      require('internal/modules/esm/load').throwUnknownModuleFormat(url, format);
    }

    return result;
  }

  /**
   * Resolve the location of the module.
   *
   * @param {string} originalSpecifier The specified URL path of the module to
   *                                   be resolved.
   * @param {string} [parentURL] The URL path of the module's parent.
   * @param {ImportAssertions} [importAssertions] Assertions from the import
   *                                              statement or expression.
   * @returns {{ format: string, url: URL['href'] }}
   */
  resolve(
    originalSpecifier,
    parentURL,
    importAssertions = ObjectCreate(null),
  ) {
    return this.#hooks.makeRequest('resolve', originalSpecifier, parentURL, importAssertions);
  }
}

class ESMLoader {
  constructor(customLoaders) {
    if (customLoaders.length) { return new ProxiedESMLoader(); }
    return new DefaultESMLoader();
  }
}

exports.ESMLoader = ESMLoader;
exports.DefaultESMLoader = DefaultESMLoader;
exports.CustomizedESMLoader = CustomizedESMLoader;
exports.ProxiedESMLoader = ProxiedESMLoader;
