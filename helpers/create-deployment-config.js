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

const fs = require("fs");
const { execSync } = require("child_process");

/**
 * Extract Terraform outputs and create a deployment config file
 * 
 * Usage: node create-deployment-config.js [--terraform-dir <dir>] [--output <file>]
 */

const args = process.argv.slice(2);
let terraformDir = "./tf";
let outputFile = "./deployment-config.json";

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--terraform-dir" && args[i + 1]) {
    terraformDir = args[i + 1];
    i++;
  } else if (args[i] === "--output" && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  }
}

try {
  console.log(`Reading Terraform outputs from: ${terraformDir}`);
  
  // Change to terraform directory
  const cwd = process.cwd();
  process.chdir(terraformDir);
  
  try {
    // Get Terraform outputs as JSON
    const outputs = JSON.parse(
      execSync("terraform output -json", { encoding: "utf8" })
    );
    
    process.chdir(cwd);
    
    // Extract values
    const config = {
      gcs_bucket_name: outputs.gcs_bucket_name?.value,
      bq_dataset_id: outputs.bq_dataset_id?.value,
      bq_instances_table_id: outputs.bq_instances_table_id?.value,
      cloud_run_service_url: outputs.cloud_run_service_url?.value,
      gcs_processed_data_bucket_name: outputs.gcs_processed_data_bucket_name?.value,
    };
    
    // Validate required fields
    if (!config.gcs_bucket_name || !config.bq_dataset_id || !config.bq_instances_table_id) {
      throw new Error("Missing required Terraform outputs");
    }
    
    // Write config file
    fs.writeFileSync(outputFile, JSON.stringify(config, null, 2));
    
    console.log(`✓ Created deployment config: ${outputFile}`);
    console.log("\nConfiguration:");
    console.log(JSON.stringify(config, null, 2));
    
  } catch (error) {
    process.chdir(cwd);
    throw error;
  }
  
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
