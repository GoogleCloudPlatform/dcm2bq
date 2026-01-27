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

const assert = require("assert");
const { createHttpError, deepAssign, deepClone, DEBUG_MODE, createNonRetryableError } = require("../src/utils");

describe("utils", () => {
  describe("deepClone", () => {
    it("should clone a simple object", () => {
      const original = { a: 1, b: "test", c: true };
      const cloned = deepClone(original);
      
      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned, original); // Different references
    });

    it("should clone nested objects", () => {
      const original = { 
        a: 1, 
        nested: { 
          b: "test", 
          deep: { 
            c: [1, 2, 3] 
          } 
        } 
      };
      const cloned = deepClone(original);
      
      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned.nested, original.nested);
      assert.notStrictEqual(cloned.nested.deep, original.nested.deep);
    });

    it("should clone arrays", () => {
      const original = [1, 2, { a: "test" }, [4, 5]];
      const cloned = deepClone(original);
      
      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned, original);
    });

    it("should return undefined for undefined input", () => {
      const result = deepClone(undefined);
      assert.strictEqual(result, undefined);
    });

    it("should return undefined for null input", () => {
      const result = deepClone(null);
      assert.strictEqual(result, undefined);
    });

    it("should clone objects with various data types", () => {
      const original = {
        string: "test",
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: "value" },
        nullValue: null,
        emptyArray: [],
        emptyObject: {}
      };
      const cloned = deepClone(original);
      
      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned, original);
    });

    it("should handle circular references gracefully (converts to JSON)", () => {
      const original = { a: 1 };
      // Note: JSON.stringify will throw on circular references, 
      // so deepClone will also throw, which is expected behavior
      try {
        original.self = original;
        deepClone(original);
        assert.fail("Should have thrown an error for circular reference");
      } catch (e) {
        assert(e instanceof TypeError);
      }
    });
  });

  describe("deepAssign", () => {
    it("should merge a single source object into destination", () => {
      const dst = { a: 1 };
      const src = { b: 2 };
      const result = deepAssign(dst, src);
      
      assert.deepStrictEqual(result, { a: 1, b: 2 });
      assert.strictEqual(result, dst); // Should return the destination object
    });

    it("should merge multiple source objects into destination", () => {
      const dst = { a: 1 };
      const src1 = { b: 2 };
      const src2 = { c: 3, d: 4 };
      const result = deepAssign(dst, src1, src2);
      
      assert.deepStrictEqual(result, { a: 1, b: 2, c: 3, d: 4 });
    });

    it("should overwrite destination properties with source properties", () => {
      const dst = { a: 1, b: 2 };
      const src = { b: 20, c: 3 };
      const result = deepAssign(dst, src);
      
      assert.deepStrictEqual(result, { a: 1, b: 20, c: 3 });
    });

    it("should perform deep cloning of source objects", () => {
      const dst = {};
      const src = { nested: { value: "test" } };
      deepAssign(dst, src);
      
      // Modify the source nested object
      src.nested.value = "modified";
      
      // Destination should not be affected
      assert.strictEqual(dst.nested.value, "test");
    });

    it("should handle empty source objects", () => {
      const dst = { a: 1 };
      const result = deepAssign(dst, {});
      
      assert.deepStrictEqual(result, { a: 1 });
    });

    it("should handle no source arguments", () => {
      const dst = { a: 1 };
      const result = deepAssign(dst);
      
      assert.deepStrictEqual(result, { a: 1 });
    });

    it("should merge complex nested structures", () => {
      const dst = { 
        config: { 
          setting1: "value1",
          nested: { option: "a" }
        } 
      };
      const src = { 
        config: { 
          setting2: "value2",
          nested: { option: "b", extra: "c" }
        } 
      };
      const result = deepAssign(dst, src);
      
      // deepAssign uses Object.assign which is shallow at the top level,
      // so the entire 'config' object from src replaces the one in dst
      // However, the source is deep cloned before assignment
      assert.deepStrictEqual(result.config.setting2, "value2");
      // The config object is replaced, not merged
      assert.deepStrictEqual(result.config.nested.option, "b");
      assert.deepStrictEqual(result.config.nested.extra, "c");
    });
  });

  describe("createHttpError", () => {
    it("should create an error with code and message", () => {
      const error = createHttpError(404, "Not Found");
      
      assert(error instanceof Error);
      assert.strictEqual(error.code, 404);
      assert.strictEqual(error.message, "Not Found");
    });

    it("should create an error with different status codes", () => {
      const error400 = createHttpError(400, "Bad Request");
      const error500 = createHttpError(500, "Internal Server Error");
      
      assert.strictEqual(error400.code, 400);
      assert.strictEqual(error500.code, 500);
    });

    it("should create an error with custom message", () => {
      const customMsg = "Custom error message with special chars: !@#$%";
      const error = createHttpError(422, customMsg);
      
      assert.strictEqual(error.message, customMsg);
    });

    it("should be throwable", () => {
      const error = createHttpError(503, "Service Unavailable");
      
      assert.throws(
        () => { throw error; },
        (err) => {
          return err instanceof Error && err.code === 503;
        }
      );
    });

    it("should preserve error properties when caught", () => {
      try {
        throw createHttpError(429, "Too Many Requests");
      } catch (e) {
        assert.strictEqual(e.code, 429);
        assert.strictEqual(e.message, "Too Many Requests");
      }
    });

    it("should have proper Error prototype chain", () => {
      const error = createHttpError(401, "Unauthorized");
      
      assert(error instanceof Error);
      assert(error.hasOwnProperty("code"));
      assert(error.hasOwnProperty("message"));
    });
  });

  describe("createNonRetryableError", () => {
    it("should create an error with retryable flag set to false", () => {
      const error = createNonRetryableError("Invalid DICOM file");
      
      assert(error instanceof Error);
      assert.strictEqual(error.retryable, false);
      assert.strictEqual(error.message, "Invalid DICOM file");
    });

    it("should default to status code 422", () => {
      const error = createNonRetryableError("Parse error");
      
      assert.strictEqual(error.code, 422);
    });

    it("should accept custom status code", () => {
      const error = createNonRetryableError("Bad request", 400);
      
      assert.strictEqual(error.code, 400);
      assert.strictEqual(error.retryable, false);
    });

    it("should be distinguishable from retryable errors", () => {
      const nonRetryable = createNonRetryableError("Corrupted file");
      const retryable = createHttpError(500, "Timeout");
      
      assert.strictEqual(nonRetryable.retryable, false);
      assert.strictEqual(retryable.retryable, undefined); // Not set
    });

    it("should be throwable", () => {
      const error = createNonRetryableError("Unsupported format");
      
      assert.throws(
        () => { throw error; },
        (err) => {
          return err instanceof Error && err.retryable === false;
        }
      );
    });

    it("should preserve properties when caught", () => {
      try {
        throw createNonRetryableError("Invalid data", 400);
      } catch (e) {
        assert.strictEqual(e.code, 400);
        assert.strictEqual(e.retryable, false);
        assert.strictEqual(e.message, "Invalid data");
      }
    });
  });

  describe("DEBUG_MODE", () => {
    it("should be a boolean value", () => {
      assert.strictEqual(typeof DEBUG_MODE, "boolean");
    });

    it("should be false when DEBUG env var is not set", () => {
      // In test environment, DEBUG should be false
      assert.strictEqual(DEBUG_MODE, false);
    });
  });
});
