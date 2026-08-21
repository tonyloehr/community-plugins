#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

const __PM_SOURCE_PARTS__={"schemaVersion":1,"sourceBytes":121670,"sourceSha256":"11d71d84bc2f630c3092b83d86205d63ef6233bfad0b1ad0daa062400e8f2b81","parts":[{"name":"observabilityctl.mjs.source.part-000","bytes":121670,"sha256":"11d71d84bc2f630c3092b83d86205d63ef6233bfad0b1ad0daa062400e8f2b81"}]};
const sourceParts = __PM_SOURCE_PARTS__.parts.map((part) => {
  const bytes = readFileSync(new URL(part.name, import.meta.url));
  if (bytes.byteLength !== part.bytes || createHash("sha256").update(bytes).digest("hex") !== part.sha256) {
    throw new Error("Generated Production Monitoring source part failed integrity verification");
  }
  return bytes;
});
const source = Buffer.concat(sourceParts);
if (source.byteLength !== __PM_SOURCE_PARTS__.sourceBytes || createHash("sha256").update(source).digest("hex") !== __PM_SOURCE_PARTS__.sourceSha256) {
  throw new Error("Generated Production Monitoring source failed integrity verification");
}
const loaderPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const Module = require("node:module");
const runtimeModule = new Module(loaderPath);
runtimeModule.filename = loaderPath;
runtimeModule.paths = Module._nodeModulePaths(dirname(loaderPath));
runtimeModule._compile(source.toString("utf8"), loaderPath);
