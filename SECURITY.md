# Security policy

## Supported versions

OH SHI is a continuously deployed web application. Security fixes target the
current default branch and the production deployment; older commits and local
forks are not supported release lines.

## Report a vulnerability

Please use GitHub's private vulnerability reporting flow:

<https://github.com/lpbangun/oh-shi/security/advisories/new>

Include the affected route or component, impact, reproduction steps, and any
suggested mitigation. Redact tokens, personal information, and third-party
content. Please do not open a public issue or test against production in a way
that changes data, degrades availability, or accesses another person's data.

You can expect an acknowledgement within five business days. The maintainer
will validate the report, coordinate a fix and release, and discuss disclosure
timing with the reporter. Timelines may vary with severity and complexity.

## Security-sensitive areas

Reports are especially useful for:

- bypasses of protected ingestion or review routes;
- secrets exposed through logs, APIs, builds, or browser bundles;
- injection or unsafe URL handling in source ingestion;
- cross-site scripting or unintended disclosure of stored source content;
- dependency or workflow compromise with a demonstrated project impact; and
- integrity failures that allow incomplete evidence to close canonical jobs.

General source-quality corrections and stale job reports are not security
issues; use the public bug-report form for those.
