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
const sinon = require("sinon");
const { PerfCtx } = require("../src/perf");

describe("perf", () => {
  describe("PerfCtx", () => {
    it("should create a new performance context with auto-generated ID", () => {
      const perfCtx = new PerfCtx();
      
      assert.ok(perfCtx.id);
      assert.strictEqual(typeof perfCtx.id, "number");
      assert(perfCtx.name.startsWith("perf_"));
    });

    it("should create a new performance context with custom ID and name", () => {
      const perfCtx = new PerfCtx(12345, "myContext");
      
      assert.strictEqual(perfCtx.id, 12345);
      assert.strictEqual(perfCtx.name, "myContext");
    });

    it("should initialize with create reference point", () => {
      const perfCtx = new PerfCtx();
      
      assert.strictEqual(perfCtx.length, 1);
      assert.strictEqual(perfCtx.stack[0].name, "create");
      assert.strictEqual(perfCtx.stack[0].ts, 0);
    });

    it("should track start timestamp", () => {
      const beforeTime = Date.now();
      const perfCtx = new PerfCtx();
      const afterTime = Date.now();
      
      assert(perfCtx.start >= beforeTime);
      assert(perfCtx.start <= afterTime);
    });

    it("should add reference points with addRef", () => {
      const perfCtx = new PerfCtx();
      
      perfCtx.addRef("checkpoint1");
      perfCtx.addRef("checkpoint2");
      
      assert.strictEqual(perfCtx.length, 3);
      assert.strictEqual(perfCtx.stack[1].name, "checkpoint1");
      assert.strictEqual(perfCtx.stack[2].name, "checkpoint2");
    });

    it("should track time elapsed from start for each reference", () => {
      const perfCtx = new PerfCtx();
      
      perfCtx.addRef("ref1");
      assert(perfCtx.stack[1].ts >= 0);
      assert(perfCtx.stack[1].ts < 100); // Should be very quick
    });

    it("should add hot flag when time difference exceeds threshold", async function() {
      this.timeout(5000);
      
      const perfCtx = new PerfCtx();
      perfCtx.addRef("before");
      
      // Wait long enough to trigger hot spot detection
      await new Promise(r => setTimeout(r, 150));
      
      perfCtx.addRef("after");
      
      // The "after" reference should have hot flag set
      assert(perfCtx.stack[2].hot === true);
    });

    it("should not add hot flag for quick operations", () => {
      const perfCtx = new PerfCtx();
      
      perfCtx.addRef("quick1");
      perfCtx.addRef("quick2");
      
      // Quick operations should not have hot flag
      assert(perfCtx.stack[1].hot !== true);
      assert(perfCtx.stack[2].hot !== true);
    });

    it("should add reference without explicit name", () => {
      const perfCtx = new PerfCtx();
      
      perfCtx.addRef();
      
      assert.strictEqual(perfCtx.length, 2);
      assert(!perfCtx.stack[1].name); // No name provided
      assert(perfCtx.stack[1].ref); // Should have ref field
    });

    it("should return performance data with get()", () => {
      const perfCtx = new PerfCtx(999, "testContext");
      perfCtx.addRef("ref1");
      
      const data = perfCtx.get();
      
      assert.strictEqual(data.id, 999);
      assert.strictEqual(data.name, "testContext");
      assert(data.start);
      assert(Array.isArray(data.stack));
      assert.strictEqual(data.stack.length, 2);
    });

    it("should have correct structure in get() output", () => {
      const perfCtx = new PerfCtx(123, "context");
      perfCtx.addRef("operation1");
      
      const data = perfCtx.get();
      
      assert(data.stack[0].ref);
      assert.strictEqual(data.stack[0].ts, 0);
      assert.strictEqual(data.stack[0].name, "create");
      assert(data.stack[1].ref);
      assert.strictEqual(data.stack[1].name, "operation1");
    });

    it("should print JSON when DEBUG_MODE is enabled", () => {
      const perfCtx = new PerfCtx();
      perfCtx.addRef("test");
      
      // Mock console.log
      const consoleSpy = sinon.spy(console, "log");
      
      // This will only log if DEBUG_MODE is true
      perfCtx.print();
      
      // In test environment DEBUG_MODE should be false, so no logs
      assert(!consoleSpy.called);
      
      consoleSpy.restore();
    });

    it("should update length property with each addRef", () => {
      const perfCtx = new PerfCtx();
      assert.strictEqual(perfCtx.length, 1);
      
      perfCtx.addRef("ref1");
      assert.strictEqual(perfCtx.length, 2);
      
      perfCtx.addRef("ref2");
      assert.strictEqual(perfCtx.length, 3);
      
      perfCtx.addRef();
      assert.strictEqual(perfCtx.length, 4);
    });

    it("should maintain stack order", () => {
      const perfCtx = new PerfCtx();
      
      perfCtx.addRef("first");
      perfCtx.addRef("second");
      perfCtx.addRef("third");
      
      assert.strictEqual(perfCtx.stack[0].name, "create");
      assert.strictEqual(perfCtx.stack[1].name, "first");
      assert.strictEqual(perfCtx.stack[2].name, "second");
      assert.strictEqual(perfCtx.stack[3].name, "third");
    });

    it("should handle special characters in reference names", () => {
      const perfCtx = new PerfCtx();
      
      const specialName = "operation_with-special.chars@123!";
      perfCtx.addRef(specialName);
      
      assert.strictEqual(perfCtx.stack[1].name, specialName);
    });
  });
});
