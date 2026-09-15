# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-15

### Added

- One row in **Settings → General** that restarts `dsh web`, with a two-step
  confirm (armed for 5s) and an inline result that reports the host pid stepping
  aside, the helper's pid and the diagnostics path.
- `POST /dsh-simple-restart/api/restart`, owned by this package: no dependency on
  another plugin's route.
- A detached `node -e` helper that waits for the listening port to become free
  (probing by connect, never by bind), starts the replacement with the original
  invocation, and watches for up to 20s that it bound the port.
- Diagnostics written after the handoff to
  `$TMPDIR/dsh-simple-restart-<timestamp>.err.log`, because the process that would
  otherwise report a failure is the one that just exited.
- Guard rails before anything is spawned: POST only, loopback peer only, no
  forwarding headers, `Origin` must match `Host`, no debugger, and a refusal
  under a detected systemd supervisor unless `allowRestart: true`.

### Notes

- Shipped as `dsh-simple-restart`. It was developed under the working name
  `dsh-restart-button`, which is already published on npm by another project and
  used by several other repositories; the package name, the client bundle id,
  the settings-row key, the diagnostics prefix and the route
  (`/dsh-simple-restart/api/restart`) were all renamed before the first release.
  The route matters beyond naming: other restart plugins register
  `/dsh-restart/...`, and two plugins cannot own the same route.
- Shipped as a real package rather than a dynamic plugin: a dynamic plugin is
  unloaded by the very restart it triggers, and it has no way to spawn a
  detached process.
- The supervisor check requires two signals (`INVOCATION_ID`/`JOURNAL_STREAM`
  *and* a parent that is the manager) so that an ordinary terminal, which
  inherits the journal variables, is not misread as systemd.

[0.1.0]: https://github.com/yizhixiaokong/dsh-simple-restart/releases/tag/v0.1.0
