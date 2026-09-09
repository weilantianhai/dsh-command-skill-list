window.__ModuleLoader__.load({
	id: "dsh-command-skill-list",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/* ── requires (host-injected module table) ───────────── */
		const react = require("react");
		const h = react.createElement;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* ── locale dictionaries ─────────────────────────────── */
		const NS = "skill-list";
		const zh = {
			"menu.groupTitle": "技能",
			"menu.userOnly": "仅用户",
			"menu.entryHint": "列出全部技能（中/英文描述自动翻译）",
			"settings.nav": "技能翻译",
			"settings.desc": "技能菜单描述的翻译方式：优先使用 DSH 内置模型（与当前会话同一供应商与凭据）；也可在下方填入自定义 DeepSeek API Key 作为备用通道。",
			"settings.placeholder": "自定义 DeepSeek API Key（可选，sk-…）",
			"settings.save": "保存 Key",
			"settings.saved": "已保存，翻译缓存已清空",
			"settings.keySet": "已配置自定义 Key：",
			"settings.noKey": "未配置自定义 Key（仅使用 DSH 内置模型）",
			"settings.clearCache": "清空翻译缓存",
			"settings.cacheCount": "条缓存",
			"settings.failed": "操作失败："
		};
		const en = {
			"menu.groupTitle": "Skills",
			"menu.userOnly": "user-only",
			"menu.entryHint": "List all skills (descriptions auto-translated zh/en)",
			"settings.nav": "Skill Translation",
			"settings.desc": "How skill-menu descriptions are translated: the DSH built-in model is used first (same provider and credentials as this session); a custom DeepSeek API key below serves as the fallback channel.",
			"settings.placeholder": "Custom DeepSeek API key (optional, sk-…)",
			"settings.save": "Save key",
			"settings.saved": "Saved; translation cache cleared",
			"settings.keySet": "Custom key configured:",
			"settings.noKey": "No custom key configured (built-in model only)",
			"settings.clearCache": "Clear translation cache",
			"settings.cacheCount": "entries",
			"settings.failed": "Operation failed: "
		};

		/* ── inject dependencies ─────────────────────────────── */
		const inject = [
			"inputTriggers",
			"connection",
			"sessions",
			"locale",
			"remote",
			"slots"
		];

		/* ── detect system language ──────────────────────────── */
		function detectLocale() {
			try {
				const lang = (typeof navigator !== "undefined" && navigator.language) || "en";
				return lang.startsWith("zh") ? "zh" : "en";
			} catch { return "en"; }
		}

		/* ── language detection heuristic ────────────────────── */
		const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
		function isChinese(text) { return CJK_RE.test(text); }

		/* ── fetch translated catalog from host ──────────────── */
		async function fetchTranslatedCatalog(sessionId, locale, signal) {
			try {
				const resp = await fetch(`/api/skill-list-translated?sessionId=${encodeURIComponent(sessionId)}&locale=${locale}`, { signal });
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				return await resp.json();
			} catch {
				return null; // fallback: no translation
			}
		}

		/* ── settings section component ──────────────────────── */
		function SettingsSection({ t }) {
			const [status, setStatus] = react.useState(null);
			const [apiKey, setApiKey] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState("");

			const refresh = react.useCallback(() => {
				fetch("/api/skill-list-config", { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((body) => setStatus(body))
					.catch(() => setStatus(null));
			}, []);
			react.useEffect(() => { refresh(); }, [refresh]);

			const post = react.useCallback(async (payload, okMessage) => {
				setBusy(true);
				setMessage("");
				try {
					const resp = await fetch("/api/skill-list-config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					});
					const body = await resp.json();
					if (!resp.ok) throw new Error(body.error || "HTTP " + resp.status);
					setStatus(body);
					setApiKey("");
					setMessage(okMessage);
				} catch (e) {
					setMessage(t("settings.failed") + e.message);
				} finally {
					setBusy(false);
				}
			}, [t]);

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 520 } },
				h("p", { style: { margin: 0, opacity: 0.75, fontSize: 12, lineHeight: 1.6 } }, t("settings.desc")),
				h("div", { style: { fontSize: 12, opacity: 0.85 } },
					status && status.hasKey
						? [t("settings.keySet") + " ", h("code", { key: "k" }, status.keyMasked)]
						: t("settings.noKey")
				),
				h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
					h(primitives.Input, {
						type: "password",
						placeholder: t("settings.placeholder"),
						value: apiKey,
						onChange: (e) => setApiKey(e.target.value),
						style: { flex: 1 },
					}),
					h(primitives.Button, {
						variant: "primary",
						size: "sm",
						disabled: busy || apiKey.trim() === "",
						onClick: () => post({ action: "save", apiKey: apiKey.trim() }, t("settings.saved")),
					}, t("settings.save")),
					h(primitives.Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => post({ action: "clearCache" }, t("settings.saved")),
					}, t("settings.clearCache") + (status ? ` (${status.cacheEntries} ${t("settings.cacheCount")})` : ""))
				),
				message !== "" && h("div", { style: { fontSize: 12, opacity: 0.9 } }, message)
			);
		}

		/* ── apply (browser entry) ───────────────────────────── */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-list: dictionaries");

			const connection = ctx.get("connection");
			const sessions = ctx.get("sessions");
			const inputTriggers = ctx.get("inputTriggers");
			const t = ctx.locale.bind(NS);
			const locale = detectLocale();

			// Fetch caches per session
			const fetches = new Map();       // sessionId → { promise, settled, abort }
			const lexiconListeners = new Map();

			const notifyLexicon = (sessionId) => {
				for (const listener of [...lexiconListeners.get(sessionId) ?? []]) {
					try { listener(); } catch (e) { console.error("[skill-list] lexicon listener:", e); }
				}
			};

			/** Fetch + translate the skill catalog for one session. */
			const fetchCatalog = (sessionId) => {
				// Catalog-addressed subagent sessions have no attached agent — skill.list fails there.
				if (sessions.subagentAddress(sessionId) !== undefined) return Promise.resolve([]);
				const existing = fetches.get(sessionId);
				if (existing !== undefined) return existing.promise;

				const abort = new AbortController();
				const promise = (async () => {
					// 1. Get raw catalog from built-in skill.list RPC
					const skillsApi = connection.api.skills;
					const { result } = await skillsApi.list({ sessionId }, abort.signal);
					if (!result.ok) throw new Error(`skill.list failed: ${result.error.code}`);
					const rawSkills = result.value.skills;

					// 2. Try to get translations from host
					const translated = await fetchTranslatedCatalog(sessionId, locale, abort.signal);

					// 3. Merge: use translated descriptions where available
					if (translated && translated.skills) {
						const tMap = new Map(translated.skills.map(s => [s.name, s.descriptionTranslated]));
						return rawSkills.map(s => ({
							...s,
							descriptionTranslated: tMap.get(s.name) || s.description
						}));
					}

					// 4. Fallback: apply client-side smart translation for mismatched languages
					return rawSkills.map(s => {
						const desc = s.description || "";
						const descIsChinese = isChinese(desc);
						const targetIsChinese = locale === "zh";
						if (descIsChinese === targetIsChinese) return { ...s, descriptionTranslated: desc };
						// No server-side translation available — show original
						return { ...s, descriptionTranslated: desc };
					});
				})();

				const entry = { promise, abort };
				fetches.set(sessionId, entry);
				promise.then((skills) => {
					entry.settled = skills;
					notifyLexicon(sessionId);
				}, () => {
					if (fetches.get(sessionId) === entry) fetches.delete(sessionId);
				});
				return promise;
			};

			const invalidate = (key) => {
				const entry = fetches.get(key);
				if (entry === undefined) return;
				fetches.delete(key);
				entry.abort.abort();
				notifyLexicon(key);
			};
			const clearAll = () => { for (const key of [...fetches.keys()]) invalidate(key); };

			/* ── InputTriggerSource ───────────────────────────── */
			const source = {
				trigger: "/",
				name: "skill-list",
				order: 3,   // after built-in skill (2) and command (1)
				async candidates(session, { query, signal }) {
					// Menu tokens never contain whitespace (the trigger scan stops at
					// whitespace), so "/skills <filter>" is unreachable by design. Flow:
					// - bare "/" → a single discoverable "skills" entry;
					// - any prefix of "skills" (or "skills" itself) → the translated catalog.
					const q = query.trimStart().toLowerCase();
					if (q !== "" && !q.startsWith("skills") && !"skills".startsWith(q)) return [];
					if (q === "") {
						return [{ name: "skills", description: t("menu.entryHint") }];
					}

					let skills;
					try {
						skills = await fetchCatalog(session.sessionId);
					} catch { return []; }
					if (signal.aborted) return [];

					return skills.map(s => ({
						name: s.name,
						description: s.modelInvocable
							? s.descriptionTranslated
							: `${t("menu.userOnly")} · ${s.descriptionTranslated}`
					}));
				},
				warm(session) { fetchCatalog(session.sessionId).catch(() => {}); },
				lexicon(session) {
					return fetches.get(session.sessionId)?.settled?.map(s => s.name);
				},
				subscribeLexicon(session, listener) {
					const key = session.sessionId;
					const listeners = lexiconListeners.get(key) ?? new Set();
					listeners.add(listener);
					lexiconListeners.set(key, listeners);
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) lexiconListeners.delete(key);
					};
				},
				onPick({ candidate }) {
					// Entry pick keeps the token slash-terminated (no trailing space)
					// so the trigger re-detects and the menu reopens with the catalog;
					// a skill pick inserts "/name " for the skill tool to consume.
					if (candidate.name === "skills") return { text: "/skills" };
					return { text: `/${candidate.name} ` };
				}
			};

			/* ── register + lifecycle ──────────────────────────── */
			ctx.remote.$on("agent-preset/selected", invalidate);
			ctx.on("connection/reset", clearAll);
			ctx.effect(() => {
				const unregister = inputTriggers.registerSource(source);
				return () => { unregister(); clearAll(); };
			}, "skill-list: source");

			// Settings page section: "Skill Translation" (key config + cache reset).
			ctx.effect(() => {
				const slots = ctx.get("slots");
				slots.inject("settings.section", () => slots.register({
					name: "settings.section",
					id: "skill-translation",
					order: 41,
					label: () => t("settings.nav"),
					locale: NS,
				}, () => h(SettingsSection, { t })));
			}, "skill-list: settings section");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
