#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

const __PM_SOURCE_PARTS__={"schemaVersion":1,"sourceBytes":1235091,"sourceSha256":"2f205076c9f962efe9e98a65b579f4dff469868d821379d81bfb5122c676d3de","parts":[{"name":"grafana-authorityctl.mjs.source.part-000","bytes":140000,"sha256":"14fa65d7bb9b9294eb08f857ca6f8efd890c34d672b3402eacbc9ccecdf131ba"},{"name":"grafana-authorityctl.mjs.source.part-001","bytes":140000,"sha256":"4bcdabd2ded13066e314e2bcb58dc206ed681a7a8b3ebc7b191b311cfcfa64e9"},{"name":"grafana-authorityctl.mjs.source.part-002","bytes":139983,"sha256":"ac95dedb899f49a482a0d70ed8e6dbfa8c98f44f1f118578e173819e4a3aeebb"},{"name":"grafana-authorityctl.mjs.source.part-003","bytes":140000,"sha256":"3486504c723024d71e1c5ee095378474f965bc6c6f22d7d604e45efd0e77ec0e"},{"name":"grafana-authorityctl.mjs.source.part-004","bytes":139997,"sha256":"57bc4830c5b24dec33b02922d64da1b5e28b24998b25efe65958a65a8b4a42a5"},{"name":"grafana-authorityctl.mjs.source.part-005","bytes":140000,"sha256":"02daa97618bb32b2fd0543d4b365f111ba70d2041a8a779599c5127392fa74cc"},{"name":"grafana-authorityctl.mjs.source.part-006","bytes":140000,"sha256":"b763fb83bbb745cd40b7a60aa204aae8ba2e958a37d3897857113120ca6d8e24"},{"name":"grafana-authorityctl.mjs.source.part-007","bytes":140000,"sha256":"8a73f277bb98ffb6e1e1026e648a745db4005c581892a30a40508d69f88ebb12"},{"name":"grafana-authorityctl.mjs.source.part-008","bytes":115111,"sha256":"0b763de3b87ea2cae4e6b401406159f8180a2449484d509c0006accaef1c1ccd"}]};
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
