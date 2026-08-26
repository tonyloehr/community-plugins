import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const readme = fs.readFileSync(
  path.join(repoRoot, "plugins", "react-native-to-swiftui", "README.md"),
  "utf8",
);

test("README leads with the safe read-only first run", () => {
  assert.match(readme, /^## Safe first run$/m);
  assert.match(
    readme,
    /Use \$plan-react-native-port to inspect only the declared React Native feature and propose a SwiftUI parity contract\. Do not edit files yet\./,
  );
  assert.match(readme, /read-only/i);
  assert.match(readme, /contract before code/i);
});

test("README explains permissions, authentication, boundaries, accessibility, and limits", () => {
  for (const heading of [
    "## Permissions and authentication",
    "## Data boundary",
    "## Accessibility",
    "## Limitations",
  ]) {
    assert.match(readme, new RegExp("^" + heading + "$", "m"));
  }

  assert.match(readme, /\bRead\b/);
  assert.match(readme, /\bWrite\b/);
  assert.match(readme, /ON_USE/);
  assert.match(readme, /explicit target directory/i);
  assert.match(readme, /do not overwrite unrelated Swift files/i);
  assert.match(readme, /pure Swift domain/i);
  assert.match(readme, /Xcode|Simulator|XCUITest/);
  assert.match(readme, /App Store/i);
  assert.match(readme, /not guaranteed|does not guarantee/i);
  assert.match(readme, /accessibility/i);
});
