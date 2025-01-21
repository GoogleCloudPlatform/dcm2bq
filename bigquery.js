const { BigQuery } = require("@google-cloud/bigquery");
const config = require("./config");

const bigquery = new BigQuery();
const { datasetId, tableId } = config.get().bigQuery;

async function insert(obj) {
  await bigquery.dataset(datasetId).table(tableId).insert(obj);
}

module.exports = { insert };
