const httpErrors = require("http").STATUS_CODES;
const express = require("express");

const { handleEvent } = require("./eventhandlers");
const { matchEventSchema } = require("./schemas");
const config = require("./config");
const { DEBUG_MODE } = require("./utils");
const pkg = require("./package.json");
const { PerfCtx } = require("./perf");

const app = express();

app.use(express.json());

app.use("*", (req, res, next) => {
  res.perfCtx = new PerfCtx();
  if (DEBUG_MODE) {
    console.log(JSON.stringify(req.body));
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
  err.code = httpErrors[e.code] ? e.code : 500;
  err.messageId = req.body?.message?.messageId || "unknown";
  res.status(err.code).json({ code: err.code, messageId: err.messageId, reason: err.message });
  console.error(err);
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
  }

  stop() {
    if (this.listening) {
      this.server.close();
    }
  }
}

module.exports = { HttpServer };
