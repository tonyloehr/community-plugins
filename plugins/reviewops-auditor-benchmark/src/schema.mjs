import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.mjs";
export { parseJsonLines, parseJsonText } from "./json.mjs";

const SCHEMA_NAMES = Object.freeze([
  "common",
  "config",
  "config-validation",
  "review-run-export",
  "normalization-report",
  "eval-protocol",
  "adjudication-protocol",
  "benchmark-manifest",
  "candidate-config",
  "decision-policy",
  "tool-contract",
  "validator-result",
  "rubric",
  "pricing-snapshot",
  "run-record",
  "case-label",
  "eval-validity-report",
  "benchmark-scorecard",
  "reference-architecture-recommendation",
  "static-diagnostic-report",
]);
const AjvConstructor = /** @type {new (options?: Record<string, unknown>) => any} */ (
  /** @type {unknown} */ (Ajv2020)
);

export async function createSchemaRegistry(pluginRoot) {
  const ajv = new AjvConstructor({
    allErrors: false,
    allowUnionTypes: true,
    strict: true,
    validateFormats: false,
  });

  for (const name of SCHEMA_NAMES) {
    const schemaPath = path.join(pluginRoot, "schemas", `${name}.schema.json`);
    let schema;
    try {
      schema = JSON.parse(await readFile(schemaPath, "utf8"));
    } catch {
      fail("RO_SCHEMA_LOAD_FAILED", "Bundled schema files are unavailable.");
    }
    ajv.addSchema(schema);
  }

  const validators = new Map();
  for (const name of SCHEMA_NAMES) {
    const validator = ajv.getSchema(`urn:reviewops:schema:${name}:1`);
    if (!validator) {
      fail("RO_SCHEMA_LOAD_FAILED", "Bundled schema files are unavailable.");
    }
    validators.set(name, validator);
  }

  return {
    assert(name, value) {
      const validator = validators.get(name);
      if (!validator) {
        fail("RO_SCHEMA_UNKNOWN", "Requested schema is not bundled.");
      }
      if (!validator(value)) {
        const first = validator.errors?.[0];
        const location = first?.instancePath || first?.schemaPath || "unknown field";
        fail(
          "RO_SCHEMA_INVALID",
          `${name} input does not match its public schema at ${location}.`,
        );
      }
    },
  };
}
