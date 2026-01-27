/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

const DEBUG_MODE = /(true|1|yes)/.test(process.env.DEBUG); // truey

function deepClone(srcObj) {
  return srcObj ? JSON.parse(JSON.stringify(srcObj)) : undefined;
}

function deepAssign(dstObj, ...srcObjs) {
  srcObjs.forEach((obj) => {
    Object.assign(dstObj, deepClone(obj));
  });
  return dstObj;
}

function createHttpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Create a non-retryable error (4xx) for permanent failures.
 * These errors indicate the request will never succeed and should not be retried by Pub/Sub.
 * Use for: invalid file format, corrupted data, unsupported operations, etc.
 * @param {string} message Error message
 * @param {number} [code=422] HTTP status code (defaults to 422 Unprocessable Entity)
 * @returns {Error} Error with code property set
 */
function createNonRetryableError(message, code = 422) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  return err;
}

module.exports = { createHttpError, createNonRetryableError, deepAssign, deepClone, DEBUG_MODE };
