import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonLines,
  parseJsonText,
} from "../../../plugins/reviewops-auditor-benchmark/src/json.mjs";

test("JSON parsing rejects duplicate decoded object keys", () => {
  assert.throws(
    () => parseJsonText('{"laneId":"first","laneId":"second"}', "config"),
    (error) => error?.code === "RO_JSON_DUPLICATE_KEY",
  );
  assert.throws(
    () => parseJsonText('{"\\u006caneId":"first","laneId":"second"}', "config"),
    (error) => error?.code === "RO_JSON_DUPLICATE_KEY",
  );
});

test("JSONL parsing rejects duplicate keys in any record", () => {
  assert.throws(
    () =>
      parseJsonLines(
        '{"caseId":"one"}\n{"caseId":"two","caseId":"three"}',
        "runs",
      ),
    (error) => error?.code === "RO_JSON_DUPLICATE_KEY",
  );
});

test("JSON parsing keeps valid nested values deterministic", () => {
  assert.deepEqual(
    parseJsonText('{"lane":{"ids":["a",1,true,null]},"ok":true}', "config"),
    { lane: { ids: ["a", 1, true, null] }, ok: true },
  );
});
