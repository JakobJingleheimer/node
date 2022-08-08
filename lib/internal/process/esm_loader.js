'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeConcat,
  ObjectCreate,
} = primordials;

const {
  ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING,
} = require('internal/errors').codes;
const { ESMLoader } = require('internal/modules/esm/loader');
const {
  hasUncaughtExceptionCaptureCallback,
} = require('internal/process/execution');
const { pathToFileURL } = require('internal/url');
const {
  getModuleFromWrap,
} = require('internal/vm/module');

exports.initializeImportMetaObject = function(wrap, meta) {
  const { callbackMap } = internalBinding('module_wrap');
  if (callbackMap.has(wrap)) {
    const { initializeImportMeta } = callbackMap.get(wrap);
    if (initializeImportMeta !== undefined) {
      initializeImportMeta(meta, getModuleFromWrap(wrap) || wrap);
    }
  }
};

exports.importModuleDynamicallyCallback =
async function importModuleDynamicallyCallback(wrap, specifier, assertions) {
  const { callbackMap } = internalBinding('module_wrap');
  if (callbackMap.has(wrap)) {
    const { importModuleDynamically } = callbackMap.get(wrap);
    if (importModuleDynamically !== undefined) {
      return importModuleDynamically(
        specifier, getModuleFromWrap(wrap) || wrap, assertions);
    }
  }
  throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING();
};

// A separate loader instance is necessary to avoid cross-contamination
// between internal Node.js and userland. For example, a module with internal
// state (such as a counter) should be independent.
const internalESMLoader = new ESMLoader();
const publicESMLoader = new ESMLoader();
exports.esmLoader = publicESMLoader;

// Module.runMain() causes loadESM() to re-run (which it should do); however, this should NOT cause
// ESM to be re-initialised; doing so causes duplicate custom loaders to be added to the public
// esmLoader.
let isESMInitialized = false;

/**
 * Causes side-effects: user-defined loader hooks are added to esmLoader.
 * @returns {void}
 */
async function initializeLoader() {
  if (isESMInitialized) { return; }

  const { getOptionValue } = require('internal/options');
  const ambientLoaderSpecifiers = getOptionValue('--experimental-ambient-loader');
  const layLoaderSpecifiers = getOptionValue('--experimental-loader');
  const preloadModules = getOptionValue('--import');
  const ambientLoaders = await loadModulesInIsolation(ambientLoaderSpecifiers);
  const layLoaders = await loadModulesInIsolation(layLoaderSpecifiers, ambientLoaders);

  // Hooks must then be added to external/public loader
  // (so they're triggered in userland)
  publicESMLoader.addCustomLoaders(
    // ESMLoader::addCustomLoaders() triggers ESMLoader:preload(), so concat these (ambient last!)
    // to avoid triggering preload twice
    ArrayPrototypeConcat(
      layLoaders,
      ambientLoaders, // LIFO
    )
  );

  // Preload after loaders are added so they can be used
  if (preloadModules?.length) {
    await loadModulesInIsolation(preloadModules, layLoaders);
  }

  isESMInitialized = true;
}

function loadModulesInIsolation(specifiers, loaders = []) {
  if (!ArrayIsArray(specifiers) || specifiers.length === 0) { return; }

  let cwd;
  try {
    cwd = process.cwd() + '/';
  } catch {
    cwd = 'file:///';
  }

  internalESMLoader.addCustomLoaders(loaders);

  // Importation must be handled by internal loader to avoid polluting userland
  return internalESMLoader.import(
    specifiers,
    pathToFileURL(cwd).href,
    ObjectCreate(null),
  );
}

exports.loadESM = async function loadESM(callback) {
  try {
    await initializeLoader();
    await callback(publicESMLoader);
  } catch (err) {
    if (hasUncaughtExceptionCaptureCallback()) {
      process._fatalException(err);
      return;
    }
    internalBinding('errors').triggerUncaughtException(
      err,
      true /* fromPromise */
    );
  }
};
