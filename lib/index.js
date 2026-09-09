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

/* ── DeepSeek translation ─────────────────────────────────── */
async function translateBatch(descriptions, targetLang) {
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
        // Parse JSON array from response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return null;
        const arr = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(arr) || arr.length !== descriptions.length) return null;
        return arr.map(String);
    } catch {
        return null;
    }
}

/* ── translate + cache ────────────────────────────────────── */
async function translateDescriptions(skills, locale) {
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

    // Batch translate uncached
    if (toTranslate.length > 0) {
        const translated = await translateBatch(toTranslate, locale);
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

export function apply(ctx) {
    ctx.inject(['webServer'], (hostCtx) => {
        const host = hostCtx;
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
                        const translated = await translateDescriptions(skills, locale);
                        response.writeHead(200, {
                            'cache-control': 'no-store',
                            'content-type': 'application/json; charset=utf-8',
                            'access-control-allow-origin': '*',
                        });
                        response.end(JSON.stringify({ skills: translated }));
                    } catch (error) {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: error.message }));
                    }
                },
            });
            return () => { disposable?.(); };
        }, 'skill-list: http route');
    });
}
