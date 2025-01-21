#!/usr/bin/env node

// TODO: Try to improve startup time, when running as CLI. Tested time: ~400ms

const url = require("url");
const { Command } = require("commander");
const DicomToJson = require("./dicomtojson");
const config = require("./config");
const { HttpServer } = require("./server");
const package = require("./package.json");

const program = new Command();

program.name(package.name).description(package.description).version(package.version);

program
  .command("dump")
  .description("dump file to JSON")
  .argument("<inputFile>", "file to parse")
  .action((fileName) => {
    const fileUrl = new URL(url.pathToFileURL(fileName));
    const reader = new DicomToJson(fileUrl);
    const { jsonOutputOptions } = config.get();
    const json = reader.toJson(jsonOutputOptions);
    console.log(JSON.stringify(json, "", 2));
  });

program
  .command("service")
  .description("run in HTTP service mode")
  .argument("[port]", "port to listen on", process.env.PORT || 8080)
  .action((port) => {
    const server = new HttpServer(port);
    server.start();
  });

program.parse();
