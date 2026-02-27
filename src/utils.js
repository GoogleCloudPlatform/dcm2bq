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
 * Create a non-retryable error for permanent failures.
 * These errors indicate the request will never succeed even if retried.
 * Note: When used with Pub/Sub push subscriptions, the message will STILL be retried
 * up to max_delivery_attempts (both 4xx and 5xx trigger retries). The 422 status code
 * is used for error classification and tracking, not to prevent retries.
 * Use for: invalid file format, corrupted data, unsupported operations, missing config, etc.
 * @param {string} message Error message
 * @param {number} [code=422] HTTP status code (defaults to 422 Unprocessable Entity)
 * @returns {Error} Error with code property set and retryable flag set to false
 */
function createNonRetryableError(message, code = 422) {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  return err;
}

/**
 * Determine if an error from an API call is retryable.
 * This classification helps determine the appropriate HTTP status code to return:
 * - Retryable errors → 500/5xx (transient issues that might succeed on retry)
 * - Non-retryable errors → 422/4xx (permanent issues that won't be fixed by retrying)
 * 
 * Note: In Pub/Sub push subscriptions, BOTH 4xx and 5xx status codes trigger retries.
 * This classification is primarily for error tracking, logging, and dead letter analysis.
 * 
 * @param {Error} error The error object
 * @returns {boolean} true if the error might succeed on retry, false if it's permanent
 */
function isRetryableError(error) {
  const message = error?.message || '';
  const status = error?.response?.status || error?.code;
  
  // Check for quota/rate limit errors (429, 503, quota exceeded)
  const retryablePatterns = [
    /quota\s+exceeded/i,
    /rate\s+limit/i,
    /too\s+many\s+requests/i,
    /throttl/i,
    /temporarily\s+unavailable/i,
    /service\s+temporarily\s+unavailable/i,
    /deadline\s+exceeded/i,
    /temporarily.*unavailable/i,
    /connection\s+reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /socket\s+hang\s+up/i,
    /network\s+error/i,
  ];
  
  // Check for permanent errors (permissions, not found, etc.)
  const nonRetryablePatterns = [
    /bucket.*does\s+not\s+exist/i,
    /bucket.*not\s+found/i,
    /permission\s+denied/i,
    /access\s+denied/i,
    /unauthorized/i,
    /forbidden/i,
    /invalid\s+bucket/i,
    /authentication\s+failed/i,
  ];
  
  const isNonRetryableMessage = nonRetryablePatterns.some(pattern => pattern.test(message));
  if (isNonRetryableMessage) {
    return false;
  }
  
  const isRetryableMessage = retryablePatterns.some(pattern => pattern.test(message));
  
  // HTTP status codes that indicate retryable errors
  const retryableStatuses = [429, 500, 502, 503, 504];
  const isRetryableStatus = retryableStatuses.includes(status);
  
  return isRetryableMessage || isRetryableStatus;
}

module.exports = { createHttpError, createNonRetryableError, isRetryableError, deepAssign, deepClone, DEBUG_MODE };
