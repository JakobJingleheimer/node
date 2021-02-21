'use strict';

// This is needed to avoid cycles in esm/resolve <-> cjs/loader
require('internal/modules/cjs/loader');

const {
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
const { URL, pathToFileURL } = require('internal/url');
const { validateString } = require('internal/validators');
const ModuleMap = require('internal/modules/esm/module_map');
const ModuleJob = require('internal/modules/esm/module_job');

const {
  defaultResolve,
  DEFAULT_CONDITIONS,
} = require('internal/modules/esm/resolve');
const { defaultGetFormat } = require('internal/modules/esm/get_format');
const { defaultGetSource } = require(
  'internal/modules/esm/get_source');
const { defaultTransformSource } = require(
  'internal/modules/esm/transform_source');
const { translators } = require(
  'internal/modules/esm/translators');
const { getOptionValue } = require('internal/options');

/**
 * A Loader instance is used as the main entry point for loading ES modules.
 * Currently, this is a singleton -- there is only one used for loading
 * the main module and everything in its dependency graph.
 */
class Loader {

  /**
   * This hook is called once before the first root module is imported. It's a
   * function that returns a piece of code that runs as a sloppy-mode script.
   * The script may evaluate to a function that can be called with a
   * `getBuiltin` helper that can be used to retrieve builtins.
   * If the hook returns `null` instead of a source string, it opts out of
   * running any preload code.
   * The preload code runs as soon as the hook module has finished evaluating.
   */
  #globalPreloadCode;
  #resolve;
  #load;

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

  async #getFormat(url) {
    const getFormatResponse = await this._getFormat(
      url, {}, defaultGetFormat);
    if (typeof getFormatResponse !== 'object') {
      throw new ERR_INVALID_RETURN_VALUE(
        'object', 'loader getFormat', getFormatResponse);
    }

    const { format } = getFormatResponse;
    if (typeof format !== 'string') {
      throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
        'string', 'loader getFormat', 'format', format);
    }

    if (format === 'builtin') {
      return format;
    }

    if (this._resolve !== defaultResolve) {
      try {
        new URL(url);
      } catch {
        throw new ERR_INVALID_RETURN_PROPERTY(
          'url', 'loader resolve', 'url', url
        );
      }
    }

    if (this._resolve === defaultResolve &&
      !StringPrototypeStartsWith(url, 'file:') &&
      !StringPrototypeStartsWith(url, 'data:')
    ) {
      throw new ERR_INVALID_RETURN_PROPERTY(
        'file: or data: url', 'loader resolve', 'url', url
      );
    }

    return format;
  }

  // consolidate
  // * resolve + getFormat --> resolve()
  // * getSource + transform --> load()

  /**
   * Resolve the location of the module
   * @param {*} specifier - The specified URL path of the module to be resolved
   * @param {Object} context - Metadata about the module
   * @param {String} context.parentURL - The URL path of the module's parent
   * @returns {{ format: string; url: String }}
   */
  async resolve(specifier, { parentURL }) {
    if (parentURL !== undefined) validateString(parentURL, 'parentURL');

    const rsp = await this.#resolve(
      specifier,
      {
        parentURL,
        conditions: DEFAULT_CONDITIONS,
      },
      defaultResolve,
    );

    if (typeof rsp !== 'object') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
      'string',
      'loader resolve',
      rsp,
    );

    const { url } = rsp;

    if (typeof url !== 'string') throw new ERR_INVALID_RETURN_PROPERTY_VALUE(
      'string',
      'loader resolve',
      'url',
      url,
    );

    return url;
  }

  /**
   *
   * @param {string} url - The URL/path of the module to be loaded
   * @param {Object} context - Metadata about the module
   * @param {string} context.format - The type of import to be loaded
   */
  async load(url, { format }) {
    let verifiedFormat = format;

    if (format && !~FORMATS.indexOf(format)) {
      const verifiedFormat = await defaultGetFormat(url);

      process.emitWarning(
        `Loader expected ${FORMATS_LIST} but received unsupported "${format}". Using ${verifiedFormat} instead.`
      );
    }


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

  async import(specifier, parent) {
    const job = await this.getModuleJob(specifier, parent);
    const { module } = await job.run();

    return module.getNamespace();
  }

  hook(hooks) {
    const {
      globalPreloadCode,
      resolve,
      load,
      // obsolete hooks:
      dynamicInstantiate,
      getFormat,
      getGlobalPreloadCode,
      getSource,
      transformSource,
    } = hooks;
    const obsoleteHooks = [];

    if (getGlobalPreloadCode) {
      globalPreloadCode ??= getGlobalPreloadCode;

      process.emitWarning(
        'Loader hook "getGlobalPreloadCode" has been renamed to "globalPreloadCode"'
      );
    }
    // Use .bind() to avoid giving access to the Loader instance when called.
    if (globalPreloadCode) {
      this.#globalPreloadCode = FunctionPrototypeBind(globalPreloadCode, null);
    }
    if (resolve) {
      this.#resolve = FunctionPrototypeBind(resolve, null);
    }
    if (load) {
      this.#load = FunctionPrototypeBind(load, null);
    }

    if (dynamicInstantiate) obsoleteHooks.push('dynamicInstantiate');
    if (getFormat) obsoleteHooks.push('getFormat');
    if (getSource) obsoleteHooks.push('getSource');
    if (transformSource) obsoleteHooks.push('transformSource');

    if (obsoleteHooks.length) process.emitWarning(
      `Obsolete loader hook(s) supplied: ${obsoleteHooks.join(', ')}`
    );
  }

  runGlobalPreloadCode() {
    if (!this.#globalPreloadCode) return;

    const preloadCode = this.#globalPreloadCode();
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
}

ObjectSetPrototypeOf(Loader.prototype, null);

exports.Loader = Loader;
