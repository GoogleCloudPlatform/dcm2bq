#!/usr/bin/env node

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
