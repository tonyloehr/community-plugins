#!/usr/bin/env node

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const schemaRoot = path.join(pluginRoot, "schemas");
const sourceSchemaPath = path.join(pluginRoot, "src", "schema.mjs");
const AjvConstructor = /** @type {new (options?: Record<string, unknown>) => any} */ (
  /** @type {unknown} */ (Ajv2020)
);
const generateStandaloneCode =
  /** @type {(ajv: any, refs: Record<string, string>) => string} */ (
    /** @type {unknown} */ (standaloneCode)
  );

async function compileSchemaModule() {
  const schemaFiles = (await readdir(schemaRoot))
    .filter((name) => name.endsWith(".schema.json"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const schemaNames = schemaFiles.map((name) => name.replace(".schema.json", ""));
  const ajv = new AjvConstructor({
    allErrors: false,
    allowUnionTypes: true,
    strict: true,
    validateFormats: false,
    code: { source: true, esm: true },
  });
  for (const filename of schemaFiles) {
    const source = await readFile(path.join(schemaRoot, filename), "utf8");
    ajv.addSchema(JSON.parse(source));
  }
  const exportsByName = Object.fromEntries(
    schemaNames.map((name) => [
      name.replaceAll("-", "_"),
      `urn:reviewops:schema:${name}:1`,
    ]),
  );
  const validators = schemaNames
    .map((name) => {
      const exportName = name.replaceAll("-", "_");
      return `["${name}", ${exportName}]`;
    })
    .join(",");
  const compiled = generateStandaloneCode(ajv, exportsByName);
  return `import { parseJsonLines, parseJsonText } from "./json.mjs";
import { fail } from "./errors.mjs";
${compiled}
const validators = new Map([${validators}]);

export async function createSchemaRegistry() {
  return {
    assert(name, value) {
      const validator = validators.get(name);
      if (!validator) {
        fail("RO_SCHEMA_UNKNOWN", "Requested schema is not bundled.");
      }
      if (!validator(value)) {
        const first = validator.errors?.[0];
        const location = first?.instancePath || first?.schemaPath || "unknown field";
        fail("RO_SCHEMA_INVALID", name + " input does not match its public schema at " + location + ".");
      }
    },
  };
}

export { parseJsonLines, parseJsonText };
`;
}

const compiledSchemaModule = await compileSchemaModule();

await build({
  absWorkingDir: pluginRoot,
  entryPoints: {
    reviewops: "src/cli.mjs",
    "reviewops-worker": "src/worker.mjs",
  },
  outdir: "scripts",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22.19"],
  plugins: [
    {
      name: "precompile-bundled-schemas",
      setup(buildContext) {
        buildContext.onLoad({ filter: /src[\\/]schema\.mjs$/ }, async (args) =>
          args.path === sourceSchemaPath
            ? {
                contents: compiledSchemaModule,
                loader: "js",
                resolveDir: path.dirname(sourceSchemaPath),
              }
            : null,
        );
      },
    },
    {
      name: "disable-yaml-debug-environment",
      setup(buildContext) {
        buildContext.onLoad(
          {
            filter:
              /node_modules[\\/]yaml[\\/]dist[\\/](parse[\\/]parser|compose[\\/]composer)\.js$/,
          },
          async (args) => {
            const source = await readFile(args.path, "utf8");
            return {
              contents: source
                .replaceAll("node_process.env.LOG_STREAM", "false")
                .replaceAll("node_process.env.LOG_TOKENS", "false"),
              loader: "js",
            };
          },
        );
      },
    },
  ],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "inline",
  sourcemap: false,
  minify: false,
  charset: "utf8",
  logLevel: "info",
});
