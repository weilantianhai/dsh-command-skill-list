/**
 * dsh-command-skill-list host entry:
 * - Scans ~/.agents/skills for SKILL.md
 * - Translates descriptions to system language via DeepSeek API
 * - Exposes /api/skill-list-translated HTTP endpoint
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── constants ───────────────────────────────────────────── */
const SKILLS_DIR = join(homedir(), '.agents', 'skills');
const CACHE_FILE = join(__dirname, '..', 'data', 'translations.json');
const CONFIG_FILE = join(homedir(), '.dsh', 'plugins', 'command-skill-list', 'config.json');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/* ── frontmatter parser (minimal, no yaml dep) ───────────── */
function parseFrontmatter(content) {
    // Strip UTF-8 BOM — files written by .NET WriteAllText may carry one, and
    // it breaks every anchored regex below.
    const text = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};
    const block = match[1];
    const result = {};
    const unquote = (v) => {
        let s = v.trim();
        if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
            s = s.slice(1, -1);
        }
        return s.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
    };
    const nameMatch = block.match(/^name:\s*(.+)$/m);
    if (nameMatch) result.name = unquote(nameMatch[1]);
    const descMatch = block.match(/^description:\s*(.+)$/m);
    if (descMatch) result.description = unquote(descMatch[1]);
    return result;
}

/* ── scan skill directory ─────────────────────────────────── */
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function scanSkills() {
    if (!existsSync(SKILLS_DIR)) return [];
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(SKILLS_DIR, entry.name, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        try {
            const content = readFileSync(skillMd, 'utf-8');
            const fm = parseFrontmatter(content);
            // Mirror dsh-skill-filesystem: only kebab-case names are valid skills.
            if (fm.name && KEBAB_RE.test(fm.name)) {
                skills.push({
                    name: fm.name,
                    description: fm.description || '',
                });
            }
        } catch { /* skip unreadable */ }
    }
    return skills;
}

/* ── translation cache ────────────────────────────────────── */
/**
 * Cache flows (prewarm zh, prewarm en, user requests) all run concurrently
 * and each translation awaits, so a whole-file overwrite would lose entries
 * written by other flows after this one loaded (lost-update). Every write
 * therefore re-reads the file and merges before writing; reads also refresh
 * from disk so a flow picks up entries another flow just persisted.
 */
function loadCache() {
    let disk = {};
    try {
        if (existsSync(CACHE_FILE)) disk = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) || {};
    } catch { disk = {}; }
    cache = { ...disk, ...cache };   // in-memory additions win on conflict
}
function saveCache() {
    try {
        let disk = {};
        try {
            if (existsSync(CACHE_FILE)) disk = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) || {};
        } catch { disk = {}; }
        cache = { ...disk, ...cache };   // merge — never clobber other flows' entries
        mkdirSync(dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch { /* ignore */ }
}
/** Serialize cache writes across async flows (one at a time, no lost update). */
let cacheQueue = Promise.resolve();
/** Run `fn` exclusively with respect to other cache mutations. */
function withCacheLock(fn) {
    const run = cacheQueue.then(fn, fn);
    cacheQueue = run.catch(() => {});
    return run;
}
function cacheKey(text, locale) {
    // v2: concise-summary prompt — old full-translation entries are ignored.
    return 'v2:' + createHash('sha256').update(text).digest('hex').slice(0, 16) + ':' + locale;
}

/* ── config reader ────────────────────────────────────────── */
function readConfig() {
    try {
        if (existsSync(CONFIG_FILE)) {
            return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

/* ── language detection ───────────────────────────────────── */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
function isChinese(text) { return CJK_RE.test(text); }

/* ── DeepSeek translation (fallback: direct API with user key) ── */
async function translateBatchDirect(descriptions, targetLang) {
    const apiKey = process.env.DEEPSEEK_API_KEY || readConfig().deepseekApiKey;
    if (!apiKey) return null; // no key configured

    const langName = targetLang === 'zh' ? 'Chinese (Simplified)' : 'English';
    const items = descriptions.map((d, i) => `[${i}] ${d}`).join('\n');
    const prompt = `Translate the following skill descriptions to ${langName}. Keep technical terms and code unchanged. Return ONLY a JSON array of translated strings, one per input, in the same order. No extra text.\n\n${items}`;

    try {
        const resp = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                max_tokens: 2048,
            }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) return null;
        return parseJsonArray(text, descriptions.length);
    } catch {
        return null;
    }
}

/** Extract a JSON string array of exactly `expected` items from model text. */
function parseJsonArray(text, expected) {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    try {
        const arr = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(arr) || arr.length !== expected) return null;
        return arr.map(String);
    } catch { return null; }
}

/* ── translation via the harness llm runtime (primary) ────── */
/** Last llm-runtime failure observed (diagnostics via /api/skill-list-config). */
let lastLlmError = null;

function translationPrompt(descriptions, targetLang) {
    const langName = targetLang === 'zh' ? 'Chinese (Simplified)' : 'English';
    const limit = targetLang === 'zh' ? '24 个汉字以内' : '15 words or fewer';
    const items = descriptions.map((d, i) => `[${i}] ${d}`).join('\n');
    return [
        `Below are descriptions of AI-agent skills. For each, write a CONCISE one-line summary in ${langName} that captures what the skill is for.`,
        `Hard limit: ${limit}. Do not translate the full text — distill it.`,
        'Keep technical terms and code unchanged. No period at the end.',
        'Return ONLY a JSON array of strings, one per input, same order. No extra text.',
        '',
        items,
    ].join('\n');
}

/**
 * Pick a provider/model route for auxiliary calls: prefer a deepseek route,
 * else the first registered provider; prefer deepseek-chat, else the first
 * advertised model. Returns null when no adapter is registered at all.
 */
async function pickLlmRoute(llm) {
    try {
        const providers = llm.listProviders();
        if (!Array.isArray(providers) || providers.length === 0) {
            lastLlmError = 'NO_ADAPTER: no llm provider registered';
            return null;
        }
        const preferred = providers.find((p) => p.id.includes('deepseek')) || providers[0];
        let model = DEEPSEEK_MODEL;
        try {
            const models = await llm.listModels(preferred.id);
            if (Array.isArray(models) && models.length > 0) {
                const chat = models.find((m) => m.id === DEEPSEEK_MODEL);
                model = (chat || models[0]).id;
            }
        } catch { /* keep default model */ }
        return { provider: preferred.id, model };
    } catch (error) {
        lastLlmError = error.code ? `${error.code} ${error.message}` : error.message;
        return null;
    }
}

/**
 * One auxiliary completion through the harness llm runtime, using the same
 * provider/key the session already uses (same shape as session-title-llm).
 * Adapter failures arrive as terminal `finish` chunks, not throws — capture
 * both. @param llm the harness LlmRuntime service.
 * @returns the assistant text, or null on any failure.
 */
async function llmComplete(llm, prompt) {
    const route = await pickLlmRoute(llm);
    if (!route) return null;
    try {
        const options = {
            provider: route.provider,
            model: route.model,
            messages: [{
                id: createHash('sha256').update(prompt).digest('hex').slice(0, 32),
                role: 'user',
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-command-skill-list' },
            }],
            maxTokens: 8192,
            purpose: 'skill-translate',
        };
        let text = '';
        let failure = null;
        for await (const chunk of llm.stream(options)) {
            if (chunk.type === 'text-delta') text += chunk.text;
            else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop') {
                failure = chunk.reason.failure
                    ? `${chunk.reason.kind}:${chunk.reason.failure.code} ${chunk.reason.failure.message}`
                    : chunk.reason.kind;
            }
        }
        lastLlmError = failure ? `${route.provider}/${route.model} ${failure}` : null;
        return (!failure && text.trim()) ? text.trim() : null;
    } catch (error) {
        lastLlmError = error.code ? `${error.code} ${error.message}` : error.message;
        return null;
    }
}

/* ── translate + cache ────────────────────────────────────── */
/**
 * @param skills scanned catalog entries ({name, description}).
 * @param locale 'zh' | 'en'.
 * @param llm harness LlmRuntime service (may be undefined).
 * @param notes per-skill custom notes map (name → note); noted skills skip
 *   translation entirely and show the note as-is.
 */
async function translateDescriptions(skills, locale, llm, notes = {}) {
    return withCacheLock(async () => {
        loadCache();   // fresh snapshot from disk inside the lock
        const toTranslate = [];
        const toTranslateIdx = [];

        // Check cache first; walk by index so identical descriptions never alias.
        const results = skills.map((s, i) => {
            const note = notes[s.name];
            if (typeof note === 'string' && note.trim() !== '') return note.trim();
            const desc = s.description || '';
            if (desc === '') return '';            // nothing to translate
            const key = cacheKey(desc, locale);
            if (cache[key]) return cache[key];
            // If source language matches target, no translation needed
            if (isChinese(desc) === (locale === 'zh')) return desc;
            toTranslate.push(desc);
            toTranslateIdx.push(i);
            return null; // placeholder
        });

        // Batch translate uncached in parallel chunks: harness runtime first,
        // direct API fallback. Short concise outputs keep batches small and fast.
        if (toTranslate.length > 0) {
            const CHUNK = 3;
            const batches = [];
            for (let start = 0; start < toTranslate.length; start += CHUNK) {
                batches.push(toTranslate.slice(start, start + CHUNK));
            }
            const translateOne = async (batch) => {
                if (llm) {
                    const text = await llmComplete(llm, translationPrompt(batch, locale));
                    if (text) {
                        const parsed = parseJsonArray(text, batch.length);
                        if (parsed) return parsed;
                    }
                }
                return translateBatchDirect(batch, locale);
            };
            const settled = await Promise.all(batches.map(translateOne));
            if (settled.every((t) => t !== null)) {
                let cursor = 0;
                for (const batch of settled) {
                    for (const value of batch) {
                        const idx = toTranslateIdx[cursor];
                        const key = cacheKey(toTranslate[cursor], locale);
                        cache[key] = value;
                        results[idx] = value;
                        cursor++;
                    }
                }
                saveCache();   // merge-on-write inside the lock — no lost update
            }
        }

        // Fill untranslated with original
        return skills.map((s, i) => ({
            name: s.name,
            description: s.description,
            descriptionTranslated: results[i] || s.description || '',
        }));
    });
}

/* ── host plugin entry ────────────────────────────────────── */
export const name = 'dsh-command-skill-list';

/** Mask a secret for display: keep first 3 + last 4 chars. */
function maskKey(key) {
    if (!key || key.length < 8) return '';
    return key.slice(0, 3) + '****' + key.slice(-4);
}

/** Read one JSON request body. */
function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (c) => chunks.push(c));
        request.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
            catch (e) { reject(e); }
        });
        request.on('error', reject);
    });
}

/** Merge a patch into config.json (preserving unknown keys). */
function writeConfigPatch(patch) {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    const merged = { ...readConfig(), ...patch };
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
}

/** Shape shared by GET and successful POST config responses. */
function configPayload() {
    const config = readConfig();
    const key = process.env.DEEPSEEK_API_KEY || config.deepseekApiKey || '';
    const notes = config.notes && typeof config.notes === 'object' ? config.notes : {};
    return {
        hasKey: key !== '',
        keyMasked: maskKey(key),
        cacheEntries: Object.keys(cache).length,
        llmError: lastLlmError,
        notes,
        skills: scanSkills().map((s) => ({
            name: s.name,
            note: typeof notes[s.name] === 'string' ? notes[s.name] : '',
            description: s.description,
        })),
    };
}

export function apply(ctx) {
    ctx.inject(['webServer', 'llm'], (hostCtx) => {
        const host = hostCtx;
        const llm = hostCtx.llm;
        const json = (response, code, payload) => {
            response.writeHead(code, {
                'cache-control': 'no-store',
                'content-type': 'application/json; charset=utf-8',
            });
            response.end(JSON.stringify(payload));
        };

        // Prewarm translations in the background (both locales) so the first
        // menu open is served from cache. Fire-and-forget: never blocks boot.
        for (const locale of ['zh', 'en']) {
            translateDescriptions(scanSkills(), locale, llm, readConfig().notes || {}).catch(() => {});
        }

        host.effect(() => {
            const disposable = host.webServer.register({
                kind: 'exact',
                path: '/api/skill-list-translated',
                handler: async (request, response) => {
                    if (request.method !== 'GET') {
                        response.writeHead(405, { allow: 'GET' });
                        response.end();
                        return;
                    }
                    try {
                        const url = new URL(request.url, 'http://localhost');
                        const locale = url.searchParams.get('locale') || 'en';
                        const skills = scanSkills();
                        const config = readConfig();
                        const translated = await translateDescriptions(skills, locale, llm, config.notes || {});
                        response.writeHead(200, {
                            'cache-control': 'no-store',
                            'content-type': 'application/json; charset=utf-8',
                            'access-control-allow-origin': '*',
                        });
                        response.end(JSON.stringify({ skills: translated }));
                    } catch (error) {
                        json(response, 500, { error: error.message });
                    }
                },
            });
            return () => { disposable?.(); };
        }, 'skill-list: http route');

        host.effect(() => {
            const disposable = host.webServer.register({
                kind: 'exact',
                path: '/api/skill-list-config',
                handler: async (request, response) => {
                    try {
                        if (request.method === 'GET') {
                            json(response, 200, configPayload());
                            return;
                        }
                        if (request.method === 'POST') {
                            const body = await readBody(request);
                            if (body.action === 'save') {
                                const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
                                if (!apiKey) {
                                    json(response, 400, { error: 'apiKey is required' });
                                    return;
                                }
                                writeConfigPatch({ deepseekApiKey: apiKey });
                            } else if (body.action === 'saveNote') {
                                const name = typeof body.name === 'string' ? body.name.trim() : '';
                                const note = typeof body.note === 'string' ? body.note.trim() : '';
                                if (name === '') {
                                    json(response, 400, { error: 'name is required' });
                                    return;
                                }
                                const notes = { ...(readConfig().notes || {}) };
                                if (note === '') delete notes[name];
                                else notes[name] = note;
                                writeConfigPatch({ notes });
                            } else if (body.action === 'clearCache') {
                                cache = {};
                                try { writeFileSync(CACHE_FILE, '{}', 'utf-8'); } catch { /* ignore */ }
                            } else {
                                json(response, 400, { error: 'unknown action' });
                                return;
                            }
                            json(response, 200, { ok: true, ...configPayload() });
                            return;
                        }
                        response.writeHead(405, { allow: 'GET, POST' });
                        response.end();
                    } catch (error) {
                        json(response, 500, { error: error.message });
                    }
                },
            });
            return () => { disposable?.(); };
        }, 'skill-list: config route');
    });
}
