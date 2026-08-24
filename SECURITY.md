# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability, leaked secret,
or unsafe plugin behavior. Use this repository's
[private security advisory form](https://github.com/tonyloehr/community-plugins/security/advisories/new).
If that form is unavailable, open a public issue containing only “Security
contact requested”—no technical details—and a maintainer will arrange a private
channel.

Include:

- the affected plugin and version or commit;
- a minimal reproduction;
- expected and observed behavior;
- possible impact and any safe mitigation;
- whether credentials, customer data, or external systems may be involved.

Do not include real tokens, credentials, customer data, or private URLs in a
report. Redact them before sharing.

## Supported scope

Security review covers the current `main` branch and the latest published
version of each plugin in this marketplace. Older versions may be fixed only
by upgrading.

Plugin authors should document capabilities, authentication, external
endpoints, and data boundaries in each plugin README and manifest. A plugin
must not silently broaden those boundaries in a routine update.
