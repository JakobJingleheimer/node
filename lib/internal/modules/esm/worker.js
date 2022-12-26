'use strict';

const {
  Int32Array,
  ReflectApply,
  SafeWeakMap,
  TypedArrayPrototypeFill,
  TypedArrayPrototypeSet,
  Uint8Array,
  globalThis: {
    Atomics,
  },
} = primordials;

function debug(...args) {
  return;
  require('fs').appendFileSync('/dev/fd/1',
    'HooksWorker: ' + args.map((arg) => require('util').inspect(arg)).join(' ') + '\n'
  );
}
debug('starting up');

// Create this WeakMap in js-land because V8 has no C++ API for WeakMap.
internalBinding('module_wrap').callbackMap = new SafeWeakMap();

const { isMainThread, workerData } = require('worker_threads');
if (isMainThread) { return; } // Needed to pass some tests that happen to load this file on the main thread
const { commsChannel } = workerData;

// lock = 0 -> main sleeps
// lock = 1 -> worker sleeps
const lock = new Int32Array(commsChannel, 0, 4); // Required by Atomics
const requestResponseData = new Uint8Array(commsChannel, 4, 2044); // For v8.deserialize/serialize

function releaseLock() {
  Atomics.store(lock, 0, 1); // Send response to main
  Atomics.notify(lock, 0); // Notify main of new response
}

/**
 * ! Run everything possible within this function so errors get reported.
 */
(async function setupESMWorker() {
  const { initializeESM, initializeHooks } = require('internal/modules/esm/utils');
  initializeESM();
debug('ESM initialised');
  const hooks = await initializeHooks();

debug('Hooks initialised', hooks);
  // ! Put as little above this line as possible
  releaseLock(); // Send 'ready' signal to main

debug('released lock');
  const { deserialize, serialize } = require('v8');

  while (true) {
debug('req & rsp started. sleeping until a request is received');
    Atomics.wait(lock, 0, 1); // This pauses the while loop

debug('awoken; request received');
    const { type, args } = deserialize(requestResponseData);

debug('request', type, ...args);
debug('emptying data vehicle');
    TypedArrayPrototypeFill(requestResponseData, 0); // Erase handled request/response data

debug('preparing response');
    const response = await ReflectApply(hooks[type], hooks, args);

debug('response prepared', response);
    TypedArrayPrototypeSet(requestResponseData, serialize(response));

    releaseLock();
debug('lock released');
  }
})().catch((err) => {
  debug(err)
  const { triggerUncaughtException } = internalBinding('errors');
  releaseLock();
  triggerUncaughtException(err);
});
