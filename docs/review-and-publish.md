# Review and publish

This repository distributes public Codex plugins. A release is ready only when
the marketplace entry, installable package, cold-start instructions, licenses,
and evidence all agree.

## Review checklist

- Confirm `.agents/plugins/marketplace.json` names only plugins intended for
  public distribution and points to existing `./plugins/<name>` directories.
- Confirm every manifest has accurate publisher, repository, website, version,
  capability, authentication, and license metadata.
- Check that plugin docs tell a cold-started Codex task what to do first, what
  inputs are safe, what it must never do, and how to stop when prerequisites are
  missing.
- Scan manifests, docs, fixtures, source archives, and media for secrets,
  personal paths, customer identifiers, private transcripts, and unpublished
  customer data.
- Review each plugin's license and third-party notices before redistribution.
- Confirm GitHub private vulnerability reporting is enabled before sharing the
  marketplace publicly.
- Run `npm run validate:marketplace`, `npm run test:marketplace`,
  `npm run validate`, and the deeper tests for every changed plugin.
- For Grafana release changes, review the full demo media and source receipts;
  skipped checks are not passes.

## Grafana verification

From a fresh checkout:

```sh
npm run validate
npm run verify:grafana:source
npm run test:grafana
```

The [Grafana test guide](../tests/grafana-observability/README.md) lists the
real-provider matrix, authentication, installed-client, source-rebuild, and
native Keychain commands with their platform requirements. The
[source/build guide](grafana-observability-source.md) explains the pinned source
archive and exact-byte rebuild process.

Before publishing a Grafana release, also run the applicable end-to-end gates:

```sh
npm run test:grafana:matrix
npm run test:grafana:auth
npm run test:grafana:installed
# macOS arm64 only:
npm run test:grafana:keychain
npm run test:grafana:handoff
```

If a required platform is unavailable, record the skipped gate and an explicit
reviewer-approved exception instead of treating it as a pass.

The recording in [demo media](media/README.md) illustrates a broader local
workflow and is not installed-plugin test evidence. Review it in full before
redistribution.

## Publish checklist

1. Review the complete diff, source receipts, media, and test results.
2. Confirm the GitHub Actions workflow covers the changed package paths.
3. Merge through the repository's normal review process.
4. From a clean checkout of `main`, install the GitHub-backed marketplace:

   ```sh
   codex plugin marketplace add tonyloehr/community-plugins --ref main
   codex plugin add grafana-observability@community-plugins
   ```

5. Start a new Codex task and run the plugin's setup skill before sharing the
   release.

Use branch protection and reviewer ownership as the catalog grows. This guide
describes verification; it does not bypass normal review or release approval.
