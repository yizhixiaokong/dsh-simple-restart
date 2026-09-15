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

if (failures.length > 0) {
	console.error('\n' + failures.length + ' check(s) failed')
	process.exit(1)
}
console.log('\nall checks passed')
