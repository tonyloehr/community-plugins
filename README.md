# Community Plugins

A public, Git-backed marketplace of Codex plugins that developers, prospects,
and enterprise teams can inspect before they install. Each plugin is packaged
with its manifest, setup guide, tests, and license or third-party notices.

This repository is a community distribution source for local Codex, not an
automatic listing in OpenAI's universal Plugins Directory. See
[OpenAI's plugin packaging docs](https://developers.openai.com/plugins/build/plugins)
for the distinction between public directory publishing and repo marketplaces.

## Add it to Codex

In Codex, choose **Add plugin marketplace** and use a repository slug or clone
URL, not a raw `marketplace.json` URL:

```text
Source: tonyloehr/community-plugins
Git ref: main
Sparse paths:
.agents/plugins
plugins
```

Those two sparse paths load the complete plugin catalog without pulling this
repo's tests, demo media, or source receipts. To fetch every repository file,
leave **Sparse paths** blank. To fetch only Grafana Observability, use these two
paths instead:

```text
.agents/plugins
plugins/grafana-observability
```

Adding a marketplace makes its catalog available to browse. It does **not**
install, enable, or authenticate every plugin. After adding it, install only
the plugin you want.

The same flow from the CLI:

```sh
# Load the full catalog efficiently.
codex plugin marketplace add tonyloehr/community-plugins \
  --ref main \
  --sparse .agents/plugins \
  --sparse plugins

# Install one plugin from that catalog.
codex plugin add grafana-observability@community-plugins
```

If you want a full checkout instead of a sparse one:

```sh
codex plugin marketplace add tonyloehr/community-plugins --ref main
```

The `@community-plugins` selector comes from the top-level `name` in
[the marketplace manifest](.agents/plugins/marketplace.json), not from the
GitHub URL. Start a new Codex task after installation so its skills and tools
are picked up.

## Available plugins

| Plugin | Purpose | Learn more |
| --- | --- | --- |
| [Grafana Observability](plugins/grafana-observability/README.md) | Inspect administrator-approved, read-only Grafana evidence for infrastructure, APM, logs, IoT/edge, and business KPIs. | [Guide](plugins/grafana-observability/README.md) · [23-second demo](docs/media/grafana-production-monitoring-demo-8x.mp4) |

Grafana Observability requires Codex and Node.js 22.19 or newer. Its manifest
declares both `Read` and `Write`. `Write` is limited to
plugin-owned local audit and evidence files; it does not write to Grafana,
datasources, dashboards, services, or deployments.

Its default startup uses a credential-free fixture, so you can verify the
install without touching a Grafana instance:

```text
Use $setup-grafana-observability to check the fixture profile and available packs.
```

## Copy-paste Codex prompts

Browse before installing:

```text
Add the Git-backed marketplace from tonyloehr/community-plugins at ref main. Use sparse paths .agents/plugins and plugins. List the available plugins and recommend the best fit for this repository, but do not install or authenticate anything yet.
```

Install one plugin:

```text
If community-plugins is not already configured, add it from tonyloehr/community-plugins at ref main using sparse paths .agents/plugins and plugins/grafana-observability. Install grafana-observability@community-plugins, explain its permissions and authentication policy, and give me the credential-free smoke-test prompt for a new Codex task.
```

Review before adoption:

```text
Review tonyloehr/community-plugins before I install it. Inspect .agents/plugins/marketplace.json, each plugin manifest, declared capabilities, authentication policy, external endpoints, licenses, and setup instructions. Flag anything that needs security or admin review.
```

## Update or remove

```sh
# Refresh the Git-backed marketplace snapshot.
codex plugin marketplace upgrade community-plugins

# Reinstall a plugin after a new version is published.
codex plugin add grafana-observability@community-plugins

# Remove the configured marketplace source.
codex plugin marketplace remove community-plugins
```

For an enterprise fork or private mirror, use its HTTPS or SSH clone URL and
make sure Git credentials already work non-interactively. Keep the same
`.agents/plugins/marketplace.json` and `plugins/<name>/` layout.

## Repository layout

```text
.agents/plugins/marketplace.json      # Catalog and install policy
plugins/<plugin-name>/                 # One installable plugin
  .codex-plugin/plugin.json            # Required plugin manifest
  README.md                            # Cold-start setup and safety guidance
tests/<plugin-name>/                   # Plugin-specific verification
scripts/                               # Marketplace and package checks
```

## Trust and contributions

Treat every plugin as code you are choosing to run. Review its manifest,
capabilities, authentication policy, setup guide, and license before installing
it. This repository never needs credentials committed to it.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add or update a plugin,
[SECURITY.md](SECURITY.md) to report a vulnerability, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations. The
repository is Apache-2.0 licensed; individual plugins may carry their own
license and third-party notices.
