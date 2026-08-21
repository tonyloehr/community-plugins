import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

const __PM_SOURCE_PARTS__={"schemaVersion":1,"sourceBytes":1495972,"sourceSha256":"68f5b966cadc2e09acf6c11ff3ead8bb604cdc3de196c14db36750443865fcb7","parts":[{"name":"provider-worker.mjs.source.part-000","bytes":140000,"sha256":"c668f252a1582ea5d6d61e98b62ad60d231eff1ac81de4aa13343d2a742e8e75"},{"name":"provider-worker.mjs.source.part-001","bytes":140000,"sha256":"ffc2c85e121806a42d59ab1baf1cb69cade492472f73cfa031f16999f2831526"},{"name":"provider-worker.mjs.source.part-002","bytes":140000,"sha256":"1cbedbda2b2e5b6bf9fd8b7b39cd5ea4ba1cff4be0eb4f1459d271885da6c7e7"},{"name":"provider-worker.mjs.source.part-003","bytes":139991,"sha256":"25565c53102c1b543d756e0256659c094ac49262228da32d0e1845b053fabbc0"},{"name":"provider-worker.mjs.source.part-004","bytes":140000,"sha256":"ebec10a0ae51d81d03bc98d94add5fa2c96982be6cd5fe18e4d23d43d34a2877"},{"name":"provider-worker.mjs.source.part-005","bytes":140000,"sha256":"8ee74de1362bde223e05b6b22fe0668e1ebe4afcc05a995ca20bc8a790786b36"},{"name":"provider-worker.mjs.source.part-006","bytes":139988,"sha256":"0ac9feee0e6a7256d4dee8007de0493b45f43e2cfc9679688615d71984e5a328"},{"name":"provider-worker.mjs.source.part-007","bytes":140000,"sha256":"762946dbf012d89d4e667399c9d2f5b8db203de52a6a83ec02d2dd9d7dcf3d17"},{"name":"provider-worker.mjs.source.part-008","bytes":140000,"sha256":"2040dd45e1409a23fb02f31f191716c8c749d9b2b92f2b904b431089c41345c7"},{"name":"provider-worker.mjs.source.part-009","bytes":140000,"sha256":"d99127aeb4ed2b9e138f79f2b5410b31bbe3e70b1bcf4f1a21ec7205b60fee35"},{"name":"provider-worker.mjs.source.part-010","bytes":95993,"sha256":"2be8d44454fadc3a8d97e5372e11eebac097d871df90cdbdb87873e43aebddc2"}]};
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
