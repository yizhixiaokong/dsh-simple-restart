# dsh-simple-restart

English | [中文](README.zh.md)

[![CI](https://github.com/yizhixiaokong/dsh-simple-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/yizhixiaokong/dsh-simple-restart/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-installable-2ea44f)](https://github.com/topics/dsh-plugin)

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that adds one
row to **Settings → General**: a button that restarts the running `dsh web`
process with the same invocation it was started with.

It exists because a plugin change to a client bundle only takes effect after the
host restarts, and doing that from a terminal means finding the terminal again.
This package owns its own route and its own restart logic — no other plugin is
involved.

## What it does

1. The row asks this package's own host route for a restart (a second click
   confirms; the armed state expires after 5s).
2. The host checks its own safety rules, then spawns a **detached helper** and
   hands it the exact boot invocation — executable, argv, working directory.
3. The helper waits until the listening port is free, starts the replacement,
   and then watches for up to 20s to confirm it bound the port.
4. The host exits 500ms after the handoff. The browser page disconnects briefly
   and reconnects when the new process is up.

If anything goes wrong after the handoff, the helper writes a diagnosis to
`$TMPDIR/dsh-simple-restart-<timestamp>.err.log` (the replacement's own stdout/stderr
go to the `.out.log` beside it). The process that would otherwise log the
failure is the one that just exited — that is why the helper is a separate
program rather than a `setTimeout` in the host.

## Why a helper at all

A process cannot replace itself: it can only stop, and something has to start the
successor *after* the listening port is free. Starting it earlier dies with
`EADDRINUSE`. So the restart is a handshake between two processes, and the second
one has to be detached — it must outlive the first.

`"free"` is tested by *connecting* to the port, never by binding it: a test bind
would itself hold the port at the exact moment the replacement needs it.

## Requirements

| Requirement | Notes |
| --- | --- |
| DSH, web profile | The route is served by `webServer`; the settings row is a client-half slot. |
| Same-origin loopback caller | The route refuses anything else (see below). |
| Not supervised by systemd — or `allowRestart: true` | systemd's default `KillMode=control-group` kills the helper together with the unit, so a restart there would leave nothing running. |
| Not under a debugger | A debugger attached to this process cannot follow it across an `exec`-less restart. |

## Install

```sh
git clone https://github.com/yizhixiaokong/dsh-simple-restart.git
cd dsh-simple-restart
dsh plugin --profile web add "$PWD"
```

From npm:

```sh
dsh plugin --profile web add dsh-simple-restart
```

The package's [`cordis.patch.yml`](cordis.patch.yml) contributes the one host
row it needs. **Now restart `dsh web` once from a terminal** — the client bundle
is baselined at boot, so the button appears only after the next start. After
that, the button can do it.

To remove it:

```sh
dsh plugin --profile web remove dsh-simple-restart
```

## Usage

Settings → **通用 / General** → *重启 dsh web*:

- first click arms the button (`确认重启？`), a second click within 5s performs it;
- the hint line then shows the host pid that is stepping aside and the helper's
  pid, plus the diagnostics path;
- the page reconnects on its own once the replacement is listening.

## Configuration

The row's config is passed to the host `apply`:

```yaml
# in the profile's cordis.patch.yml, on the row this package contributes
- insert:
    - id: simple-restart
      name: dsh-simple-restart
      config:
        allowRestart: true   # restart even when a systemd supervisor is detected
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `allowRestart` | `boolean` | `false` under a detected systemd supervisor, `true` otherwise | Whether a restart is permitted where supervision was detected. Only set this where the unit is known to survive it (`KillMode=process`, or a supervisor that restarts the unit). |

## HTTP API

One exact route, `POST /dsh-simple-restart/api/restart`. It is fenced before anything is
spawned:

| Check | Refusal |
| --- | --- |
| Method other than POST | `405` with `Allow: POST` |
| Socket peer that is not `127.0.0.1`, `::1` or `::ffff:127.0.0.1` | `403` |
| Any forwarding header (`forwarded`, `x-forwarded-for`, `x-real-ip`) | `403` |
| Missing `Origin`, or an `Origin` whose host is not `Host` | `403` |
| systemd supervisor detected and `allowRestart` not `true` | `403` |
| Debugger detected in `process.execArgv` | `403` |
| A restart is already scheduled | `409` |

```jsonc
// 202 Accepted
{
  "ok": true,
  "pid": 12345,          // the host that is stepping aside
  "helperPid": 12350,    // the detached helper
  "logOut": "/tmp/dsh-simple-restart-2026-09-15T10-00-00.out.log",
  "logErr": "/tmp/dsh-simple-restart-2026-09-15T10-00-00.err.log"
}
```

Failures answer `{"ok":false,"error":"…"}` with the status from the table above.

The helper is spawned as `node -e <program>`, detached with `stdio: "ignore"` and
`unref()`ed, so it is out of this process's lifetime from the moment it exists.
It is given the boot invocation as data (`{ file, args, cwd }`), never by
re-running a shell command line: when the host was started as `node …/bin.js`
the absolute entry and its original `execArgv`/argv are reused; otherwise it
falls back to the `dsh` executable on `PATH` with the original arguments.

## Limits and known behaviour

- **Detached, not supervised.** Once the helper is running, this package has no
  further control over it. A restart of a process started with unusual wrapper
  arguments (a shell function, a container entrypoint) falls back to running
  `dsh` with the same argv — which is right for `dsh web`, not for every
  possible wrapper.
- **No port to wait for.** If `Host` carries no port, the helper simply waits
  1.5s before starting the replacement.
- **Environment is inherited**, including the current working directory.
- **Diagnostics live in the temp directory** and are never cleaned up; they are
  small, and finding them is the point.

## Development

```
lib/index.js        host half — route, guards, launch description, detached helper
lib/client.js       client bundle — one General-settings row
cordis.patch.yml    the single host row this package contributes
scripts/smoke.mjs   offline checks (no harness, no restart)
```

```sh
npm test          # node scripts/smoke.mjs
```

The smoke test materializes the client bundle against stub globals and applies
the host half to a stub context. **It never restarts anything.** It checks that
the client half fills exactly one settings seat, that the host registers exactly
one route, and that both halves agree on that route's path — a mismatch shows up
in the browser as a row that always says "请求失败" while the host log stays
empty.

## Repository notes

Versions are tagged to match `package.json` — this tree is `v0.1.0`.

The `yizhixiaokong` placeholder in `package.json`, `CHANGELOG.md`, the badges and the
install commands above stands for the GitHub account this repository is pushed
to; replace it before publishing. The commits here were authored under a neutral
`dsh-plugins <noreply@example.com>` identity so that no personal address ends up
in the published history; if you want your own name on them, set
`git config user.name` / `user.email` and run
`git commit --amend --reset-author` before pushing.

### About the name

This plugin was developed under the working name `dsh-restart-button`. That name
is not available: it is published on npm by
[`jiqiu0709/dsh-restart-button`](https://github.com/jiqiu0709/dsh-restart-button)
and used by several other GitHub repositories, so the package ships as
`dsh-simple-restart`. Renaming also removed a real collision — the route is now
this package's own `/dsh-simple-restart/api/restart`, instead of the
`/dsh-restart/api/restart` that other restart plugins register.

### Getting listed in the marketplace

The plugin list at
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
is generated from one YAML file per plugin, and its CI checks a submission's
shape against this repository. The mechanical part is already satisfied here:
`dsh.bundle` is declared in `package.json` beside `cordis.patch.yml`, the
official `@deepseek-ai/*` packages are declared as `peerDependencies`, there are
no dependencies to install and no build step.

Mind what this plugin shares with entries already on that list: several of them
restart `dsh web` from inside the GUI. This one adds two things they do not
state — it refuses to restart under a detected systemd supervisor, whose default
`KillMode=control-group` would kill the helper along with the unit, and it tests
whether the port is free by *connecting* to it rather than binding it, so the
replacement never races the old process for the port.

Owner steps:

1. add the `dsh-plugin` topic —
   `gh repo edit yizhixiaokong/dsh-simple-restart --add-topic dsh-plugin`;
2. let the repository age past 1 day (the list's CI rejects younger ones);
3. open one PR adding `data/plugins/yizhixiaokong__dsh-simple-restart.yml`:

   ```yaml
   url: https://github.com/yizhixiaokong/dsh-simple-restart
   name: yizhixiaokong/dsh-simple-restart
   category: dev
   description:
     en: 'Adds a restart row to Settings → General that relaunches dsh web with the same invocation through a detached helper, refuses under a detected systemd supervisor unless allowRestart is true, and tests whether the listening port is free by connecting to it rather than binding it.'
     zh: '在「设置 → 通用」增加一行重启按钮：用相同启动参数、经分离的 helper 重新拉起 dsh web；检测到 systemd 监管时默认拒绝（除非 allowRestart 为 true）；判断端口是否空闲用连接探测而非绑定。'
   ```

## License

[MIT](LICENSE)
