# Contributing

Thanks for helping make these plugins useful, inspectable, and safe to share.
This is a public Codex marketplace, so a plugin is ready only when a new user
can understand and verify it from a cold start.

## Add or update a plugin

1. Put the package at `plugins/<plugin-name>/`. Use lower-case kebab-case, and
   keep the folder name, marketplace entry name, and manifest `name` identical.
2. Add `plugins/<plugin-name>/.codex-plugin/plugin.json` with accurate public
   metadata, capabilities, authentication behavior, version, repository URL,
   and license.
3. Add or update the entry in
   `.agents/plugins/marketplace.json`. Local source paths must be
   `./plugins/<plugin-name>`.
4. Include a plugin `README.md` that explains the first safe prompt,
   prerequisites, permissions, authentication, data boundaries, and failure
   behavior.
5. Keep tests, fixtures, licenses, and third-party notices with the plugin or
   in clearly named companion folders.
6. Add one `test:<plugin-name>` master suite to `package.json`. It should
   run the plugin's functional, integration/E2E, security, and packaged checks
   as applicable. The marketplace-wide CI job discovers each catalog entry
   and runs that matching test script; plugin-specific CI should expose one
   plugin-level job that invokes the same master suite.

Never commit credentials, OAuth tokens, customer data, private URLs, personal
paths, or generated caches.

## Validate locally

Node.js 22.19 or newer is required for the repository checks:

```sh
npm run validate:marketplace
npm run test:marketplace
npm run validate
```

Run the changed plugin's own test suite too. For Grafana Observability:

```sh
npm run verify:grafana:source
npm run test:grafana
```

The deeper provider, authentication, install, and native-platform checks are in
[the Grafana test guide](tests/grafana-observability/README.md).

For Autodesk Fusion, use the same root master-suite convention:

```sh
# Cold packaged checks do not need development dependencies or Autodesk access.
npm run test:autodesk-fusion:package
# Install only the pinned development dependencies for the complete master.
npm --prefix plugins/autodesk-fusion ci --ignore-scripts
npm run test:autodesk-fusion
```

The [Fusion test guide](tests/autodesk-fusion/README.md) describes its root
unit/integration/security checks, deeper plugin contracts, Python requirement
and explicit external qualification gates. Marketplace CI installs packages'
locked development dependencies without lifecycle scripts before invoking the
catalog-discovered master suites. Individual plugin CI uses those same masters;
platform and native-build jobs provide supplemental evidence.

## Pull requests

Keep pull requests focused. Describe:

- what the plugin does and who it is for;
- what capabilities, network access, files, or authentication it needs;
- how a reviewer can reproduce the happy path and a safe failure path;
- the tests you ran and any intentionally skipped gates;
- license or third-party-notice changes.

Use the [review and publish checklist](docs/review-and-publish.md) before asking
for review. New plugins should include their own validation coverage and update
the marketplace-wide checks when they introduce a new package shape.
