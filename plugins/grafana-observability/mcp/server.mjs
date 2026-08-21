import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

const __PM_SOURCE_PARTS__={"schemaVersion":1,"sourceBytes":1857254,"sourceSha256":"4c218d6244fc5bb5b61f6539b7e054f272f28076828f89592600b6fde7c72b8d","parts":[{"name":"server.mjs.source.part-000","bytes":140000,"sha256":"52c936999f625f5a409ab34b75763162833dc65df5b9350ee1fbc1c00ff35337"},{"name":"server.mjs.source.part-001","bytes":140000,"sha256":"733d31321218dc8d9b0f201b998b15691012ae4710706d551ec86b31e390dac1"},{"name":"server.mjs.source.part-002","bytes":139999,"sha256":"3c589c6b449b85112e143963609e34cdba9f1cca3a3b9454d73af8184e124b8a"},{"name":"server.mjs.source.part-003","bytes":140000,"sha256":"1dd0db127624d576e60dbcbad52b3dbfc1904a819e123537d4af59dd18bdbd49"},{"name":"server.mjs.source.part-004","bytes":140000,"sha256":"a3acc75724cf010423ac51244971d661c1380a401fdbf1af4d9d406cd0a84e2c"},{"name":"server.mjs.source.part-005","bytes":140000,"sha256":"8c758ce000678cc14acd9c4261eca12641342bc3d7990c3a91932b09452e8f71"},{"name":"server.mjs.source.part-006","bytes":140000,"sha256":"fb0c352027c4c3c326ea42c358d4b57677a0a990025290143a6b2967dd0c96d9"},{"name":"server.mjs.source.part-007","bytes":139992,"sha256":"bb461e7bcaa97ed78934ea61c247787c83f09635f1f384189a3b5fd9278dcb5d"},{"name":"server.mjs.source.part-008","bytes":140000,"sha256":"58d5475275e66a7af6ea5f7e1ccf7deb2812a286effd0d74fcaffbdd830888ee"},{"name":"server.mjs.source.part-009","bytes":140000,"sha256":"f58d64d9a93574522b85aa377424575c627c14c3e9cb8dde7f93389ff3deb7fb"},{"name":"server.mjs.source.part-010","bytes":140000,"sha256":"3c611176c9edcc681fa2a66e9688fa2406c4485be780997f8ae5650e77f24e59"},{"name":"server.mjs.source.part-011","bytes":140000,"sha256":"d26e520625efc66eb3243b20d2253cb2935cd36b396145fbae6663ebb9aaf68e"},{"name":"server.mjs.source.part-012","bytes":140000,"sha256":"b8758c732abfd4deabbd1eba72812799ac776d47bd4af0d1f7b4fe98b811dd55"},{"name":"server.mjs.source.part-013","bytes":37263,"sha256":"a3c66dca5419c156b40092b7e5f4c49e5a076a421033b8d2a50086fab7c90076"}]};
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
