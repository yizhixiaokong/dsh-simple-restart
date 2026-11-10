/**
 * dsh-simple-restart — Host half.
 *
 * A self-restart capability owned by this package: no dependency on any other
 * plugin's route. The shape of it — hand the boot invocation to a detached
 * helper, let the replacement wait for the listening port, then exit — is the
 * one dshmarket uses for the same job; this is an independent implementation of
 * that shape, in this package's own words.
 *
 * Why a helper at all: a process cannot replace itself. It can only stop, and
 * something else has to start the successor AFTER the listening port is free —
 * starting it earlier dies with EADDRINUSE. So this half spawns a detached
 * `node -e` helper, hands it the exact boot invocation, and then terminates
 * itself. The helper polls the port, starts the replacement, checks that it
 * came up, and writes a diagnosis when it did not — because the process that
 * would otherwise log the failure is the one that just exited.
 *
 * Safety model: the route accepts only POST from a same-origin loopback
 * browser (no forwarding headers), refuses under a debugger, and refuses a
 * second request while one is scheduled. Under a detected systemd supervisor it
 * refuses too — unless `config.allowRestart: true` says this unit survives a
 * detached helper, or the unit itself starts this process again on any exit
 * (`Restart=always`). That last case is the one supervisor that needs no
 * helper at all: the restart IS the exit, so `KillMode=control-group` has
 * nothing to kill and no privileges are involved.
 *
 * @module dsh-simple-restart
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The web carrier is the only hard dependency: without it there is no route. */
export const inject = ['webServer']

/** The one route this plugin owns. */
const ROUTE = '/dsh-simple-restart/api/restart'

/** How long the helper waits for the old port to go quiet. */
const PORT_FREE_TIMEOUT_MS = 30000

/** How long the helper waits for the replacement to start listening. */
const REPLACEMENT_TIMEOUT_MS = 20000

/** npm's Windows shim needs a shell; POSIX never does. */
const VIA_SHELL = process.platform === 'win32'

/** How long the self-exit waits before signalling, so the 202 gets out first. */
const SELF_EXIT_DELAY_MS = 1500

/**
 * Whether this host looks supervised by systemd.
 *
 * Two signals are required. `INVOCATION_ID`/`JOURNAL_STREAM` are inherited by
 * every descendant, so on their own they would flag an ordinary terminal; the
 * second signal is the parent being the manager itself (PID 1, or a process
 * whose comm is `systemd`, which is what a per-user manager instance looks
 * like). `/proc` is Linux-only, exactly as wide as systemd itself.
 * @returns {'systemd' | null} the detected supervisor.
 */
function detectedSupervisor() {
  const marked = (process.env.INVOCATION_ID ?? '') !== '' || (process.env.JOURNAL_STREAM ?? '') !== ''
  if (!marked) return null
  if (process.ppid === 1) return 'systemd'
  try {
    return readFileSync(`/proc/${String(process.ppid)}/comm`, 'utf8').trim() === 'systemd' ? 'systemd' : null
  } catch {
    return null
  }
}

/**
 * The systemd unit that owns a process, out of the contents of its
 * `/proc/<pid>/cgroup`.
 *
 * A cgroup path names several units on the way down, and the deepest
 * `.service` is the one that owns the process. `user@<uid>.service` is only
 * the user manager — reaching it means the walk left the owning unit, which is
 * what a process in a transient scope (`systemd-run --user --scope`, the way
 * some runners start their children) looks like.
 * @param {string} text - contents of /proc/self/cgroup.
 * @returns {{ unit: string, userUnit: boolean } | null} the owning unit, or null.
 */
export function owningUnitFrom(text) {
  if (typeof text !== 'string') return null
  const userUnit = /\/user@\d+\.service\//.test(text)
  const parts = text.split('/')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index].trim()
    if (!/\.service$/.test(part)) continue
    if (/^user@\d+\.service$/.test(part)) return null
    return { unit: part, userUnit }
  }
  return null
}

/**
 * {@link owningUnitFrom} for this process.
 * @returns {{ unit: string, userUnit: boolean } | null} the owning unit, or null.
 */
function owningUnit() {
  try {
    return owningUnitFrom(readFileSync('/proc/self/cgroup', 'utf8'))
  } catch {
    return null
  }
}

/**
 * The unit facts a self-exit depends on, or nulls when systemctl cannot answer.
 *
 * Three facts decide the branch:
 * - `Restart=` must be `always`. Only that restarts a process that exited
 *   cleanly, which is what a signal produces; `on-failure`, `on-abnormal` and
 *   `on-success` all read that exit as success.
 * - `RestartPreventExitStatus=` overrides `Restart=`. A unit that lists SIGTERM
 *   there is not restarted even with `Restart=always`, so the exit would leave
 *   nothing running.
 * - `MainPID` is the process systemd restarts. Exiting only restarts the unit
 *   when this host *is* that process; a wrapper unit keeps running after a
 *   child exits, and a nested process would take the whole unit down with it.
 * @param {{ unit: string, userUnit: boolean }} owner - the owning unit.
 * @returns {{ restart: string | null, preventExitStatus: string | null, mainPid: number | null }} the facts.
 */
function unitFacts(owner) {
  const args = ['show', owner.unit, '-p', 'Restart', '-p', 'RestartPreventExitStatus', '-p', 'MainPID']
  if (owner.userUnit) args.unshift('--user')
  const facts = { restart: null, preventExitStatus: null, mainPid: null }
  try {
    const text = execFileSync('systemctl', args, { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of text.split('\n')) {
      const at = line.indexOf('=')
      if (at < 0) continue
      const key = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      if (key === 'Restart') facts.restart = value.length === 0 ? null : value
      else if (key === 'RestartPreventExitStatus') facts.preventExitStatus = value.length === 0 ? null : value
      else if (key === 'MainPID') facts.mainPid = /^\d+$/.test(value) ? Number(value) : null
    }
  } catch {
    // systemctl missing or the unit vanished: every fact stays null and the
    // decision table refuses rather than guesses.
  }
  return facts
}

/**
 * Whether `RestartPreventExitStatus=` covers the SIGTERM the self-exit sends.
 *
 * systemd accepts termination signal names and numeric statuses there; the
 * shell convention `143` (128 + SIGTERM) is accepted too, so a unit written
 * that way is not treated as safe by accident.
 * @param {string | null} value - the property value, e.g. `SIGTERM SIGINT`.
 * @returns {boolean} true when the policy would suppress the restart.
 */
export function preventsSignalRestart(value) {
  if (typeof value !== 'string') return false
  return value
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .some((token) => /^(SIGTERM|TERM|15|143)$/i.test(token))
}

/**
 * How a restart would be carried out on this host, when it may be at all.
 *
 * Pure: every fact the decision needs is passed in, so the whole table can be
 * checked offline (see scripts/smoke.mjs).
 *
 * - `self-exit`: a supervisor starts this process again on any exit, so the
 *   restart IS the exit. Nothing is left behind for `KillMode=control-group`
 *   to kill, and no privileges are involved.
 * - `helper`: the detached helper brings the successor up, as before.
 * - `refused`: neither is safe here, and `reason` says why.
 * @param {{ supervisor: string | null, owner: { unit: string, userUnit: boolean } | null, restartPolicy: string | null, preventExitStatus?: string | null, isMainProcess?: boolean | null, allowRestart?: boolean }} input - the facts.
 * @returns {{ mode: 'self-exit' | 'helper' | 'refused', unit?: string, reason: string }} the plan.
 */
export function planRestart(input) {
  if (input.allowRestart === false) {
    return { mode: 'refused', reason: 'allowRestart is false on this row' }
  }
  if (input.allowRestart === true) {
    // The operator has stated that this unit survives a detached helper:
    // `KillMode=process`, or a wrapper that outlives the main process.
    return { mode: 'helper', reason: 'allowRestart: true' }
  }
  if (input.supervisor === null) {
    return { mode: 'helper', reason: 'no supervisor was detected' }
  }
  if (input.owner === null) {
    return {
      mode: 'refused',
      reason: `self-restart is disabled under ${input.supervisor}: this process has no owning unit to start it again; set allowRestart: true if this unit can survive a detached helper`,
    }
  }
  if (input.restartPolicy === 'always') {
    if (input.isMainProcess !== true) {
      return {
        mode: 'refused',
        reason: `self-restart is disabled under ${input.supervisor}: unit ${input.owner.unit} does not run this process as its main process, so exiting would not restart the unit; set allowRestart: true if this unit can survive a detached helper`,
      }
    }
    if (preventsSignalRestart(input.preventExitStatus ?? null)) {
      return {
        mode: 'refused',
        reason: `self-restart is disabled under ${input.supervisor}: unit ${input.owner.unit} lists SIGTERM in RestartPreventExitStatus=, which overrides Restart=always, so exiting would not restart the unit; set allowRestart: true if this unit can survive a detached helper`,
      }
    }
    return {
      mode: 'self-exit',
      unit: input.owner.unit,
      reason: `unit ${input.owner.unit} starts this process again on any exit (Restart=always)`,
    }
  }
  return {
    mode: 'refused',
    reason: `self-restart is disabled under ${input.supervisor}: unit ${input.owner.unit} has Restart=${input.restartPolicy ?? 'unknown'}, which does not cover a clean exit, so nothing would bring this process back; set allowRestart: true if this unit can survive a detached helper`,
  }
}

/**
 * {@link planRestart} with the facts read off this host.
 * @param {{ allowRestart?: boolean }} config - the plugin row's config.
 * @returns {{ mode: 'self-exit' | 'helper' | 'refused', unit?: string, reason: string }} the plan.
 */
function restartPlan(config) {
  const owner = owningUnit()
  const facts = owner === null ? null : unitFacts(owner)
  return planRestart({
    supervisor: detectedSupervisor(),
    owner,
    restartPolicy: facts === null ? null : facts.restart,
    preventExitStatus: facts === null ? null : facts.preventExitStatus,
    isMainProcess: facts === null ? null : facts.mainPid === process.pid,
    allowRestart: config.allowRestart,
  })
}

/**
 * Whether this host runs under a debugger, where a self-restart would take the
 * debug session down with it.
 * @returns {boolean} true when an inspector flag is on this process.
 */
function detectedDebugger() {
  return process.execArgv.some((token) => /^--(inspect|inspect-brk|inspect-port|inspect-wait|debug|debug-brk)(=|$)/.test(token))
}

/**
 * The port the browser actually reached this host on, read from the request's
 * Host header (already validated against Origin by the guard).
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {number | null} the port, or null for a default-port authority.
 */
function servingPort(req) {
  const host = req.headers.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * Whether a request may control this process: a loopback peer with no
 * forwarding trace, and an Origin that names exactly this authority.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the request is trusted.
 */
function trustedRequest(req) {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * The exact boot invocation to replay.
 *
 * Absolute paths matter: a source launch passes a relative entry, which the
 * child would resolve against its own cwd and die with MODULE_NOT_FOUND. The
 * cwd is set next to the entry so `execArgv` loaders (tsx/esm) stay resolvable.
 * @returns {{ file: string, args: string[], cwd: string, viaShell: boolean }} the invocation.
 */
function restartLaunch() {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const absolute = resolve(entry)
    return {
      file: process.execPath,
      args: [...process.execArgv, absolute, ...process.argv.slice(2)],
      cwd: dirname(absolute),
      viaShell: false,
    }
  }
  return { file: 'dsh', args: process.argv.slice(2), cwd: process.cwd(), viaShell: VIA_SHELL }
}

/**
 * Source of the detached helper.
 *
 * Written as a string so it can be run as `node -e`, which keeps it out of this
 * process entirely: it must outlive the process it replaces.
 * @param {{ file: string, args: string[], cwd: string, viaShell: boolean }} launch - the invocation.
 * @param {{ out: string, err: string }} logs - where the replacement's output goes.
 * @param {number | null} port - the port the replacement must take over.
 * @returns {string} the helper program.
 */
function helperSource(launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(launch.file)}`,
    `const args = ${JSON.stringify(launch.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(launch.viaShell)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, "[dsh-simple-restart] " + line + "\\n") } catch {} }',
    // "Free" is tested by CONNECTING, never by binding: a test bind would itself
    // hold the port for the moment the replacement needs it.
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    `  if (port) {`,
    `    const until = Date.now() + ${String(PORT_FREE_TIMEOUT_MS)}`,
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note("port " + port + " was still in use after the timeout; starting anyway")',
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    // A missing or unexecutable file is reported ASYNCHRONOUSLY; without this
    // listener the failure is as silent as the bug this helper exists to fix.
    '    child.on("error", (error) => note("could not start the replacement: " + String((error && error.message) || error)))',
    '    child.unref()',
    '  } catch (error) {',
    '    note("could not start the replacement: " + String((error && error.message) || error))',
    '    return',
    '  }',
    `  if (!port) { await sleep(3000); return }`,
    `  const upBy = Date.now() + ${String(REPLACEMENT_TIMEOUT_MS)}`,
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note("the replacement did not bind port " + port + " within the timeout — see the output log beside this one")',
    '}',
    'main()',
  ].join('\n')
}

/**
 * End this process so the unit that owns it starts it again.
 *
 * SIGTERM is the graceful half: the DSH core maps it to an orderly dispose and
 * an exit code of 0, and `Restart=always` covers that exit like any other. So
 * nothing is spawned, nothing has to outlive this process, and no privileges are
 * needed — the restart is simply the exit. The delay exists only so this answer
 * reaches the browser before the socket goes away.
 * @param {string} unit - the unit that will start the replacement.
 * @param {{ selfExitDelayMs?: number }} config - the plugin row's config.
 * @returns {{ pid: number, unit: string, signalMs: number }} the handoff.
 */
function scheduleSelfExit(unit, config) {
  const signalMs = Number.isFinite(config.selfExitDelayMs) ? Math.max(0, config.selfExitDelayMs) : SELF_EXIT_DELAY_MS
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), signalMs)
  return { pid: process.pid, unit, signalMs }
}

/**
 * Hand the restart to a detached helper and schedule this process's exit.
 * @param {number | null} port - the port the replacement must take over.
 * @returns {{ pid: number, helperPid: number | undefined, logOut: string, logErr: string }} the handoff.
 */
function scheduleRestart(port) {
  const launch = restartLaunch()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-simple-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-simple-restart-${stamp}.err.log`)
  const helper = spawn(process.execPath, ['-e', helperSource(launch, { out: logOut, err: logErr }, port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/**
 * Mount the plugin: one guarded restart route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the host context.
 * @param {{ allowRestart?: boolean, selfExitDelayMs?: number }} [config] - the plugin row's config.
 */
export function apply(ctx, config = {}) {
  let scheduled = false

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!trustedRequest(req)) {
        send(403, { ok: false, error: 'restart is limited to same-origin loopback requests' })
        return
      }
      const plan = restartPlan(config)
      if (plan.mode === 'refused') {
        send(403, { ok: false, error: plan.reason })
        return
      }
      if (detectedDebugger()) {
        send(403, { ok: false, error: 'self-restart is disabled while the host runs under a debugger' })
        return
      }
      if (scheduled) {
        send(409, { ok: false, error: 'restart already scheduled' })
        return
      }
      scheduled = true
      try {
        if (plan.mode === 'self-exit') {
          send(202, { ok: true, mode: 'self-exit', ...scheduleSelfExit(plan.unit, config) })
        } else {
          send(202, { ok: true, mode: 'helper', ...scheduleRestart(servingPort(req)) })
        }
      } catch (error) {
        scheduled = false
        send(500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }), 'dsh-simple-restart: /dsh-simple-restart/api/restart')
}
