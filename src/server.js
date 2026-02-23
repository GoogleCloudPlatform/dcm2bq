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

const httpErrors = require("http").STATUS_CODES;
const express = require("express");

const { handleEvent } = require("./eventhandlers");
const { matchEventSchema } = require("./schemas");
const config = require("./config");
const { DEBUG_MODE } = require("./utils");
const pkg = require("../package.json");
const { PerfCtx } = require("./perf");

const app = express();

app.use(express.json());

app.use(/.*/, (req, res, next) => {
  res.perfCtx = new PerfCtx();
  if (DEBUG_MODE && req.body) {
    const output = { url: req.url, body: req.body };
    try {
      console.log(JSON.stringify(output, null, 2));
    } catch (e) {}
  }
  next();
});

// Method for version response
app.get("/", (_, res) => {
  res.json({ name: pkg.name, version: pkg.version });
  res.perfCtx.addRef("afterResponse");
  res.perfCtx.print();
});

// Method for receiving push events
app.post("/", async (req, res) => {
  try {
    const eventName = matchEventSchema(req.body);
    res.perfCtx.addRef("beforeHandleEvent");
    await handleEvent(eventName, req, res);
    res.perfCtx.addRef("afterHandleEvent");
  } catch (e) {
    return handleHttpError(req, res, e);
  }
  res.status(200).send();
  res.perfCtx.addRef("afterResponse");
  res.perfCtx.print();
});

function handleHttpError(req, res, e) {
  const err = new Error(e.message || "unknown", { cause: e });
  
  // Determine appropriate HTTP status code
  if (httpErrors[e.code]) {
    // Error has a valid HTTP status code
    err.code = e.code;
  } else if (e.retryable === false) {
    // Explicitly marked as non-retryable - use 422 (Unprocessable Entity)
    err.code = 422;
  } else {
    // Default to 500 for unknown/retryable errors
    err.code = 500;
  }
  
  err.messageId = req.body?.message?.messageId || "unknown";
  res.status(err.code).json({ code: err.code, messageId: err.messageId, reason: err.message });
  console.error(e);
}

class HttpServer {
  constructor(port = 8080) {
    this.port = port;
    this.listening = false;
  }

  start() {
    this.server = app.listen(this.port, () => {
      console.log(`listener started; port: ${this.port}, version: ${pkg.version}, debug: ${DEBUG_MODE}`);
      if (DEBUG_MODE) {
        console.log(JSON.stringify(config.get()));
      }
      this.listening = true;
    });

    this.server.on("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        console.error(`Failed to bind to port ${this.port}: address already in use.`);
      } else {
        console.error("HTTP server error:", error);
      }
      process.exitCode = 1;
    });
  }

  stop() {
    if (this.listening) {
      this.server.close();
    }
  }
}

module.exports = { HttpServer };
