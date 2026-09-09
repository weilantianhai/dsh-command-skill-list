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
let cache = {};
function loadCache() {
    try {
        if (existsSync(CACHE_FILE)) {
            cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        }
    } catch { cache = {}; }
}
function saveCache() {
    try {
        mkdirSync(dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch { /* ignore */ }
}
function cacheKey(text, locale) {
    return createHash('sha256').update(text).digest('hex').slice(0, 16) + ':' + locale;
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
function translationPrompt(descriptions, targetLang) {
    const langName = targetLang === 'zh' ? 'Chinese (Simplified)' : 'English';
    const items = descriptions.map((d, i) => `[${i}] ${d}`).join('\n');
    return [
        `Translate skill descriptions to ${langName}.`,
        'Keep technical terms, skill names, and code unchanged.',
        'Return ONLY a JSON array of translated strings, one per input, same order. No extra text.',
        '',
        items,
    ].join('\n');
}

/**
 * One auxiliary completion through the harness llm runtime, using the same
 * provider/key the session already uses (same shape as session-title-llm).
 * @param llm the harness LlmRuntime service.
 * @returns the assistant text, or null on any failure.
 */
async function llmComplete(llm, prompt) {
    try {
        const options = {
            provider: 'deepseek-official',
            model: DEEPSEEK_MODEL,
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-command-skill-list' },
            }],
            maxTokens: 2048,
            purpose: 'skill-translate',
        };
        let text = '';
        for await (const chunk of llm.stream(options)) {
            if (chunk.type === 'text-delta') text += chunk.text;
        }
        return text.trim() || null;
    } catch { return null; }
}

/* ── translate + cache ────────────────────────────────────── */
async function translateDescriptions(skills, locale, llm) {
    loadCache();
    const toTranslate = [];
    const toTranslateIdx = [];

    // Check cache first; walk by index so identical descriptions never alias.
    const results = skills.map((s, i) => {
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

    // Batch translate uncached: harness runtime first, direct API fallback.
    if (toTranslate.length > 0) {
        let translated = null;
        if (llm) {
            const text = await llmComplete(llm, translationPrompt(toTranslate, locale));
            if (text) translated = parseJsonArray(text, toTranslate.length);
        }
        if (!translated) translated = await translateBatchDirect(toTranslate, locale);
        if (translated) {
            for (let i = 0; i < toTranslate.length; i++) {
                const idx = toTranslateIdx[i];
                const key = cacheKey(toTranslate[i], locale);
                cache[key] = translated[i];
                results[idx] = translated[i];
            }
            saveCache();
        }
    }

    // Fill untranslated with original
    return skills.map((s, i) => ({
        name: s.name,
        description: s.description,
        descriptionTranslated: results[i] || s.description || '',
    }));
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
                        const translated = await translateDescriptions(skills, locale, llm);
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
                            const config = readConfig();
                            const key = process.env.DEEPSEEK_API_KEY || config.deepseekApiKey || '';
                            json(response, 200, {
                                hasKey: key !== '',
                                keyMasked: maskKey(key),
                                cacheEntries: Object.keys(cache).length,
                            });
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
                                mkdirSync(dirname(CONFIG_FILE), { recursive: true });
                                writeFileSync(CONFIG_FILE, JSON.stringify({ deepseekApiKey: apiKey }, null, 2), 'utf-8');
                            } else if (body.action === 'clearCache') {
                                cache = {};
                                try { writeFileSync(CACHE_FILE, '{}', 'utf-8'); } catch { /* ignore */ }
                            } else {
                                json(response, 400, { error: 'unknown action' });
                                return;
                            }
                            const config = readConfig();
                            const key = process.env.DEEPSEEK_API_KEY || config.deepseekApiKey || '';
                            json(response, 200, {
                                ok: true,
                                hasKey: key !== '',
                                keyMasked: maskKey(key),
                                cacheEntries: Object.keys(cache).length,
                            });
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
