#!/usr/bin/env node
/**
 * Offline smoke checks for dsh-simple-restart.
 *
 * No restart is ever attempted here. The checks pin down the parts that fail
 * silently in a live harness: the client half must hand exactly one
 * General-settings row to the slot registry, the host half must register
 * exactly one route, and both halves must agree on that route's path — a
 * mismatch shows up in the browser as a button that reports "请求失败" while
 * the host log stays empty.
 *
 * Run it with `npm test` or `node scripts/smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** The one seat this package fills. */
const EXPECTED_SEATS = ['settings.general.item#dsh-simple-restart']

const failures = []
/**
 * Run one check, record its outcome, and keep going.
 * @param {string} name - what is being asserted, in one line.
 * @param {Function} body - the check; throw to fail.
 */
function check(name, body) {
	try {
		body()
		console.log('  ok    ' + name)
	} catch (error) {
		failures.push(name)
		const message = String((error && error.message) || error)
		console.log('  FAIL  ' + name + '\n        ' + message.split('\n').join('\n        '))
	}
}

/* ------------------------------------------------------------------ *
 * 1. Declaration order inside the client factory.
 *
 * See the longer note in the sibling package: a `const` declared below `apply`
 * is in its temporal dead zone when apply runs, and that throws during profile
 * boot, taking every later plugin row down with it.
 * ------------------------------------------------------------------ */
check('client factory declares every binding before apply()', () => {
	const lines = read('lib/client.js').split('\n')
	const applyLine = lines.findIndex((line) => /^\t\tfunction apply\(ctx\)/.test(line))
	assert.ok(applyLine > 0, 'no factory-scope `function apply(ctx)` found in lib/client.js')

	const bindings = []
	lines.forEach((line, index) => {
		const match = /^\t\t(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
		if (match) bindings.push({ name: match[1], line: index })
	})
	assert.ok(
		bindings.some((binding) => binding.line < applyLine),
		'the factory scan found no bindings at all — the indentation changed',
	)
	const later = bindings.filter((binding) => binding.line > applyLine)
	// apply() is the last factory binding: nothing below it can be in its TDZ.
	if (later.length === 0) return
	const body = lines.slice(applyLine, later[0].line).join('\n')
	const offenders = later
		.filter((binding) => new RegExp('\\b' + binding.name + '\\b').test(body))
		.map((binding) => binding.name + ' (line ' + (binding.line + 1) + ')')
	assert.deepEqual(offenders, [], 'read before initialization inside apply(): ' + offenders.join(', '))
})

/* ------------------------------------------------------------------ *
 * 2. Materialize the client bundle and apply it to a stub context.
 * ------------------------------------------------------------------ */
/** A React stand-in: only what a registration-time pass can reach. */
function reactStub() {
	return {
		createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
		memo: (component) => component,
		Fragment: Symbol('Fragment'),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial }),
		useMemo: (factory) => factory(),
		useCallback: (callback) => callback,
	}
}

/** Load lib/client.js, capturing the entry it hands to the module loader. */
function loadClientEntry() {
	const source = read('lib/client.js')
	const previous = { window: globalThis.window }
	let entry = null
	globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
	const React = reactStub()
	try {
		const factory = new Function('window', 'module', 'exports', 'require', source + '\n//# smoke\n')
		const module = { exports: {} }
		factory(globalThis.window, module, module.exports, (name) => {
			assert.equal(name, 'react', 'the client bundle may only require("react")')
			return React
		})
	} finally {
		if (previous.window === undefined) delete globalThis.window
		else globalThis.window = previous.window
	}
	assert.ok(entry && typeof entry.factory === 'function', 'the bundle never called window.__ModuleLoader__.load()')
	return entry
}

check('client bundle applies and fills its settings row', () => {
	const entry = loadClientEntry()
	assert.equal(entry.id, 'dsh-simple-restart', 'unexpected module id: ' + String(entry.id))
	const plugin = entry.factory((name) => {
		assert.equal(name, 'react')
		return reactStub()
	})
	assert.equal(plugin.name, 'dsh-simple-restart', 'unexpected plugin name: ' + String(plugin.name))
	assert.deepEqual(plugin.inject, ['slots'], 'the client half must inject the slot registry')

	const seats = []
	const sheets = []
	const disposers = []
	const slots = {
		inject(name, factory) {
			const dispose = factory()
			return typeof dispose === 'function' ? dispose : () => {}
		},
		register(options, component) {
			seats.push(options.name + '#' + String(options.key ?? options.id ?? ''))
			assert.equal(typeof component, 'function', 'seat ' + options.name + ' got no component')
			return () => {}
		},
	}
	const ctx = {
		get(name) {
			if (name === 'slots') return slots
			if (name === 'timer') return undefined
			return undefined
		},
		effect(body) {
			disposers.push(body())
			return () => {}
		},
		on() {
			return () => {}
		},
	}
	plugin.apply(ctx)

	assert.deepEqual(seats, EXPECTED_SEATS, 'registered settings seats changed')
	assert.equal(sheets.length, 0, 'this client half injects no stylesheet')
	for (const dispose of disposers) {
		if (typeof dispose === 'function') dispose()
	}
})

/* ------------------------------------------------------------------ *
 * 2b. README badges are well formed.
 *
 * A shields.io static badge is `label-message-color`, and a literal dash
 * inside a part has to be doubled. Getting that wrong does not fail loudly:
 * the service answers HTTP 200 with an SVG that reads "404: badge not found",
 * which a status-only check never sees. Park the escaped dashes before
 * splitting so `dsh--plugin` counts as one part.
 * ------------------------------------------------------------------ */
check('the manifest declares the host requirement where the market reads it', () => {
	const manifest = JSON.parse(read('package.json'))
	// The plugin market derives its compatibility line from the published
	// manifest — engines.dsh first, then any @deepseek-ai/dsh* peer. Dropping
	// either silently reverts the market to "undeclared".
	assert.equal(manifest.engines?.dsh, '>=0.1.5-rc.1', 'engines.dsh must state the host floor')
	for (const name of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-host-webserver']) {
		assert.equal(manifest.peerDependencies?.[name], '>=0.1.5-rc.1', name + ' must state the same floor')
	}
})

check('README badges are well-formed', () => {
	for (const file of ['README.md', 'README.zh.md']) {
		const urls = read(file).match(/https:\/\/img\.shields\.io\/badge\/[^)\s"']+/g) ?? []
		assert.ok(urls.length > 0, file + ' has no shields.io badge — did the badge markup change?')
		for (const url of urls) {
			const path = url.replace('https://img.shields.io/badge/', '').replace(/\.svg$/, '')
			const parts = path.replaceAll('--', '\u0000').split('-')
			assert.equal(
				parts.length,
				3,
				file + ': ' + url + ' splits into ' + parts.length + ' parts, not label-message-color — a dash inside a part must be doubled (dsh--plugin)',
			)
			for (const part of parts) {
				assert.ok(part.length > 0, file + ': ' + url + ' has an empty part')
			}
		}
	}
})

/* ------------------------------------------------------------------ *
 * 3. The host half registers its route — and both halves agree on the path.
 * ------------------------------------------------------------------ */
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
const routes = []

check('host half exposes inject/apply', () => {
	assert.deepEqual(host.inject, ['webServer'], 'the host half must inject the web server')
	assert.equal(typeof host.apply, 'function', 'no host apply() exported')
})

check('host half registers exactly one route', () => {
	const labels = []
	host.apply({
		webServer: {
			register(route) {
				routes.push(route)
				return () => {}
			},
		},
		get: () => undefined,
		effect(body, label) {
			labels.push(String(label || ''))
			body()
			return () => {}
		},
	})
	assert.equal(routes.length, 1, 'expected exactly one route registration')
	assert.equal(routes[0].kind, 'exact', 'the restart endpoint is an exact route')
	assert.equal(typeof routes[0].handler, 'function', 'the route has no handler')
	assert.ok(
		labels.some((label) => label.includes('/dsh-simple-restart/api/restart')),
		'the route effect carries no diagnostic label: ' + JSON.stringify(labels),
	)
})

check('client and host agree on the route path', () => {
	const clientPath = /const ROUTE = "([^"]+)"/.exec(read('lib/client.js'))
	const hostPath = /const ROUTE = '([^']+)'/.exec(read('lib/index.js'))
	assert.ok(clientPath, 'the client half no longer names its route')
	assert.ok(hostPath, 'the host half no longer names its route')
	assert.equal(clientPath[1], hostPath[1], 'the two halves post to different paths')
	assert.equal(routes[0].path, hostPath[1], 'the registered route does not match the declared path')
})

/* ------------------------------------------------------------------ *
 * 4. The supervisor decision table.
 *
 * These branches decide whether the button does anything at all on a
 * supervised host — and which of the two restarts it uses. They are pure, so
 * they are checked here without a harness, a unit, or a restart.
 * ------------------------------------------------------------------ */
check('the owning unit is read off a cgroup path', () => {
	const cgroup = (path) => '0::' + path + '\n'
	assert.deepEqual(
		host.owningUnitFrom(cgroup('/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service')),
		{ unit: 'dsh-web.service', userUnit: true },
	)
	assert.deepEqual(host.owningUnitFrom(cgroup('/system.slice/dsh.service')), { unit: 'dsh.service', userUnit: false })
	// The user manager supervises nothing but itself, so reaching it means the walk left the owning unit.
	assert.equal(host.owningUnitFrom(cgroup('/user.slice/user-1000.slice/user@1000.service')), null)
	// A transient scope (systemd-run --user --scope) has no owning unit either.
	assert.equal(host.owningUnitFrom(cgroup('/user.slice/user-1000.slice/user@1000.service/app.slice/run-abc.scope')), null)
	// A scope nested under a service still belongs to that service.
	assert.deepEqual(
		host.owningUnitFrom(cgroup('/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service/landlock-1.scope')),
		{ unit: 'dsh-web.service', userUnit: true },
	)
	assert.equal(host.owningUnitFrom(''), null)
})

check('Restart=always under a supervisor becomes a self-exit', () => {
	const plan = host.planRestart({
		supervisor: 'systemd',
		owner: { unit: 'dsh-web.service', userUnit: true },
		restartPolicy: 'always',
		preventExitStatus: '',
		isMainProcess: true,
	})
	assert.equal(plan.mode, 'self-exit', 'a unit that restarts on any exit needs no helper')
	assert.equal(plan.unit, 'dsh-web.service', 'the report must name the unit that takes over')
})

check('a self-exit needs this process to be the unit main process', () => {
	for (const isMainProcess of [false, null, undefined]) {
		const plan = host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy: 'always',
			preventExitStatus: '',
			isMainProcess,
		})
		assert.equal(plan.mode, 'refused', 'isMainProcess=' + String(isMainProcess) + ' must not self-exit')
		assert.match(plan.reason, /main process/)
		assert.match(plan.reason, /allowRestart: true/)
	}
})

check('RestartPreventExitStatus=SIGTERM overrides Restart=always', () => {
	for (const preventExitStatus of ['SIGTERM', 'TERM', '15', '143', 'SIGINT SIGTERM']) {
		const plan = host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy: 'always',
			preventExitStatus,
			isMainProcess: true,
		})
		assert.equal(plan.mode, 'refused', 'PreventExitStatus=' + preventExitStatus + ' suppresses the exit restart')
		assert.match(plan.reason, /RestartPreventExitStatus/)
	}
	for (const preventExitStatus of [null, '', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
		const plan = host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy: 'always',
			preventExitStatus,
			isMainProcess: true,
		})
		assert.equal(plan.mode, 'self-exit', 'PreventExitStatus=' + String(preventExitStatus) + ' does not cover SIGTERM')
	}
	// systemd hands the property back as text; parse it the same way it is written.
	assert.equal(host.preventsSignalRestart('SIGTERM'), true)
	assert.equal(host.preventsSignalRestart('SIGKILL 143'), true)
	assert.equal(host.preventsSignalRestart('SIGINT, SIGHUP'), false)
	assert.equal(host.preventsSignalRestart(null), false)
	assert.equal(host.preventsSignalRestart(undefined), false)
})

check('a supervisor that does not restart a clean exit is still refused', () => {
	for (const restartPolicy of ['on-failure', 'on-abnormal', 'on-success', 'no', null]) {
		const plan = host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy,
		})
		assert.equal(plan.mode, 'refused', 'Restart=' + String(restartPolicy) + ' does not cover a signal exit')
		assert.match(plan.reason, /allowRestart: true/)
	}
})

check('a supervisor with no owning unit is refused, not guessed at', () => {
	const plan = host.planRestart({ supervisor: 'systemd', owner: null, restartPolicy: null })
	assert.equal(plan.mode, 'refused')
	assert.match(plan.reason, /owning unit/)
})

check('no supervisor, or an explicit allowRestart, keeps the helper', () => {
	assert.equal(host.planRestart({ supervisor: null, owner: null, restartPolicy: null }).mode, 'helper')
	assert.equal(
		host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy: 'on-failure',
			allowRestart: true,
		}).mode,
		'helper',
	)
})

check('allowRestart: false still refuses everywhere', () => {
	assert.equal(host.planRestart({ supervisor: null, owner: null, restartPolicy: null, allowRestart: false }).mode, 'refused')
	assert.equal(
		host.planRestart({
			supervisor: 'systemd',
			owner: { unit: 'dsh-web.service', userUnit: true },
			restartPolicy: 'always',
			allowRestart: false,
		}).mode,
		'refused',
	)
})

if (failures.length > 0) {
	console.error('\n' + failures.length + ' check(s) failed')
	process.exit(1)
}
console.log('\nall checks passed')
