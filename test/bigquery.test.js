/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 bottom of license notice.
 */

const assert = require("assert");
const sinon = require("sinon");
const { BigQuery } = require("@google-cloud/bigquery");
const bqModule = require("../src/bigquery");

describe("bigquery module - insertEmbeddings batching", () => {
  let tableInsertStub;
  let datasetStub;
  let tableStub;
  let bigqueryInstanceStub;

  beforeEach(() => {
    tableInsertStub = sinon.stub().resolves();
    tableStub = { insert: tableInsertStub };
    datasetStub = { table: sinon.stub().returns(tableStub) };
    bigqueryInstanceStub = sinon.stub(BigQuery.prototype, "dataset").returns(datasetStub);
  });

  afterEach(() => {
    bigqueryInstanceStub.restore();
  });

  it("should split large embedding row arrays into batches of 50 by default", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `id_${i}`,
      frameNumber: i,
      embeddingVector: [0.1, 0.2, 0.3],
    }));
    const insertIds = rows.map((r) => `${r.id}|1`);

    await bqModule.insertEmbeddings(rows, insertIds);

    assert.strictEqual(tableInsertStub.callCount, 3, "Should call BigQuery insert 3 times for 120 rows with batch size 50");

    // Batch 1: rows 0..49
    const call1Args = tableInsertStub.getCall(0).args;
    assert.strictEqual(call1Args[0].length, 50);
    assert.strictEqual(call1Args[0][0].insertId, "id_0|1");
    assert.strictEqual(call1Args[0][49].insertId, "id_49|1");

    // Batch 2: rows 50..99
    const call2Args = tableInsertStub.getCall(1).args;
    assert.strictEqual(call2Args[0].length, 50);
    assert.strictEqual(call2Args[0][0].insertId, "id_50|1");

    // Batch 3: rows 100..119
    const call3Args = tableInsertStub.getCall(2).args;
    assert.strictEqual(call3Args[0].length, 20);
    assert.strictEqual(call3Args[0][0].insertId, "id_100|1");
    assert.strictEqual(call3Args[0][19].insertId, "id_119|1");
  });
});
