'use strict';

const { getOptionValue } = require('internal/options');
const { ESMLoader } = require('internal/modules/esm/loader');
const {
  hasUncaughtExceptionCaptureCallback,
} = require('internal/process/execution');

const esmLoader = new ESMLoader(getOptionValue('--experimental-loader'));
exports.esmLoader = esmLoader;

exports.loadESM = async function loadESM(callback) {
  try {
    await callback(esmLoader);
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
