window.__ModuleLoader__.load({
	id: "dsh-command-skill-list",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/* ── locale dictionaries ─────────────────────────────── */
		const NS = "skill-list";
		const zh = {
			"menu.groupTitle": "技能",
			"menu.userOnly": "仅用户",
			"menu.entryHint": "列出全部技能（中/英文描述自动翻译）"
		};
		const en = {
			"menu.groupTitle": "Skills",
			"menu.userOnly": "user-only",
			"menu.entryHint": "List all skills (descriptions auto-translated zh/en)"
		};

		/* ── inject dependencies ─────────────────────────────── */
		const inject = [
			"inputTriggers",
			"connection",
			"sessions",
			"locale",
			"remote"
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
					// Bare "/" → offer just the skills entry (avoid duplicating the built-in skill list).
					// "/skills" or "/skills <filter>" → the translated catalog.
					const q = query.trimStart();
					if (q !== "" && !q.startsWith("skills")) return [];
					if (q === "") {
						return [{ name: "skills", description: t("menu.entryHint") }];
					}
					const filter = q.slice("skills".length).trimStart();

					let skills;
					try {
						skills = await fetchCatalog(session.sessionId);
					} catch { return []; }
					if (signal.aborted) return [];

					return skills
						.filter(s => filter === "" || s.name.startsWith(filter))
						.map(s => ({
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
