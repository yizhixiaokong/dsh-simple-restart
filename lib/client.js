/**
 * Client half of dsh-simple-restart.
 *
 * One row in Settings → General that asks this package's own Host route to
 * restart `dsh web`. The Host refuses under a supervisor or a debugger, and
 * the refusal text is shown in the row rather than swallowed — a restart
 * button that silently does nothing is worse than no button at all.
 *
 * This file is this package's `./client` bundle, in the same factory form
 * every web plugin hands to `window.__ModuleLoader__`: no imports, the
 * bundler-owned `require("react")` seed, and a plain-Cordis plugin exported as
 * `{ name, inject, apply }`.
 */
window.__ModuleLoader__.load({
	id: "dsh-simple-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The Host route this row calls. */
		const ROUTE = "/dsh-simple-restart/api/restart";
		/** How long a primed "确认重启？" stays armed. */
		const CONFIRM_MS = 5000;
		/** The additive seat for one General-settings row. */
		const SLOT = "settings.general.item";
		/** This row's key in that seat. */
		const ID = "dsh-simple-restart";

		const FOCUS_RING = { outline: "2px solid var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.75))", outlineOffset: "-1px" };

		/**
		 * The General section's own row recipe (mirrored from the shipped rows
		 * like Language / Permission): 16px vertical padding under a hairline
		 * separator, a flex-1 text column with a 48px gutter, and a borderless
		 * 36px pill control filled with `bg-module-platform`.
		 */
		const S = {
			row: { display: "flex", alignItems: "center", gap: "8px", padding: "16px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))" },
			text: { display: "flex", flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, paddingRight: "48px" },
			label: { color: "var(--dsw-alias-label-primary, inherit)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
			hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			hintError: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #f85149)" },
			hintOk: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-success-primary, #3fb950)" },
			control: { flex: "none" },
			btn: { display: "inline-flex", alignItems: "center", gap: "12px", flex: "none", boxSizing: "border-box", height: "36px", padding: "0 14px", border: "none", borderRadius: "18px", background: "var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)))", color: "var(--dsw-alias-label-primary, inherit)", font: "inherit", fontSize: "14px", lineHeight: "22px", cursor: "pointer", transition: "background .12s ease, color .12s ease" },
			btnHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))" },
			btnDanger: { color: "var(--dsw-alias-state-error-primary, #f85149)" },
			btnDangerHover: { background: "var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.14))" },
			btnBusy: { opacity: .6, cursor: "default" },
		};

		/**
		 * One restart request against this package's own route.
		 * @returns {Promise<{ ok: boolean, text: string }>} the outcome to display.
		 */
		async function requestRestart() {
			let response;
			try {
				response = await fetch(ROUTE, { method: "POST" });
			} catch (error) {
				return { ok: false, text: "请求失败：" + String((error && error.message) || error) };
			}
			const body = await response.json().catch(() => null);
			if (response.ok && body && body.ok === true) {
				return {
					ok: true,
					text: "已排程重启：宿主 pid " + String(body.pid) + "，交接 helper " + String(body.helperPid) + "；本页即将断开，日志 " + String(body.logErr || ""),
				};
			}
			return { ok: false, text: String((body && body.error) || ("HTTP " + response.status)) };
		}

		/**
		 * The plugin body: register one General-settings row, owned by this
		 * plugin's fiber so unloading removes it.
		 * @param {object} ctx - the client Cordis context.
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const timer = ctx.get("timer");

			/** The settings row: label, hint, and the two-step restart button. */
			function RestartRow() {
				const phasePair = React.useState("idle");
				const phase = phasePair[0];
				const setPhase = phasePair[1];
				const messagePair = React.useState("");
				const message = messagePair[0];
				const setMessage = messagePair[1];
				const hoverPair = React.useState(false);
				const hovered = hoverPair[0];
				const setHovered = hoverPair[1];
				const focusPair = React.useState(false);
				const focused = focusPair[0];
				const setFocused = focusPair[1];

				/** First press arms for {@link CONFIRM_MS}; a second press runs it. */
				const onPress = () => {
					if (phase === "restarting") return;
					if (phase !== "confirm") {
						setPhase("confirm");
						if (timer !== undefined && typeof timer.timeout === "function") {
							timer.timeout(() => setPhase((current) => (current === "confirm" ? "idle" : current)), CONFIRM_MS);
						}
						return;
					}
					setPhase("restarting");
					setMessage("");
					requestRestart().then((result) => {
						setPhase(result.ok ? "done" : "error");
						setMessage(result.text);
					}, (failure) => {
						setPhase("error");
						setMessage(String((failure && failure.message) || failure));
					});
				};

				const busy = phase === "restarting";
				const danger = phase === "confirm";
				const style = Object.assign({}, S.btn,
					danger ? S.btnDanger : null,
					busy ? S.btnBusy : null,
					focused ? FOCUS_RING : null,
					(!busy && hovered) ? (danger ? S.btnDangerHover : S.btnHover) : null);
				const hintStyle = phase === "error" ? S.hintError : (phase === "done" ? S.hintOk : S.hint);
				const hint = phase === "restarting"
					? "正在重启…"
					: (message !== ""
						? message
						: "重启 dsh web，应用需要重启才生效的插件改动；重启时本页会短暂断开。");

				return React.createElement("div", { style: S.row },
					React.createElement("div", { style: S.text },
						React.createElement("span", { style: S.label }, "重启 dsh web"),
						React.createElement("span", { style: hintStyle }, hint)),
					React.createElement("button", {
						type: "button",
						style: style,
						disabled: busy,
						title: "用同一套启动参数重新拉起 dsh web（仅同源 loopback 可用）",
						onClick: onPress,
						onMouseEnter: () => setHovered(true),
						onMouseLeave: () => setHovered(false),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false),
					}, busy ? "重启中…" : (danger ? "确认重启？" : (phase === "error" ? "重试" : "重启"))));
			}

			ctx.effect(() => slots.inject(SLOT, () => slots.register({ name: SLOT, id: ID, order: 90 }, RestartRow)));
		}

		module.exports = { name: ID, inject: ["slots"], apply };
		return module.exports;
	}
});
