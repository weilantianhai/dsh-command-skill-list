// Full self-check: apply() against a mock ctx + exercise every route and core helper.
// Run: node test/selfcheck.mjs   (or: npm test)
import { readFileSync } from 'node:fs';
import { apply } from '../lib/index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  OK', name, extra); }
    else { fail++; console.log('  FAIL', name, extra); }
};

// ── 1. apply + route registration ──
const routes = new Map();
const ctx = {
    inject(deps, fn) {
        fn({
            effect: (f) => f(),
            llm: undefined, // direct-API fallback path (no key → null → original text)
            webServer: { register: (o) => { routes.set(o.path, o.handler); return {}; } },
        });
    },
};
apply(ctx);
console.log('[1] route registration');
ok('two routes registered', routes.size === 2, [...routes.keys()].join(', '));

const mockRes = () => ({ code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } });
const { Readable } = await import('node:stream');
const makePost = (obj) => {
    const req = Readable.from([Buffer.from(JSON.stringify(obj), 'utf-8')]);
    req.method = 'POST';
    req.url = '/api/skill-list-config';
    return req;
};

// ── 2. GET config ──
console.log('[2] GET /api/skill-list-config');
{
    const res = mockRes();
    await routes.get('/api/skill-list-config')({ method: 'GET' }, res);
    ok('status 200', res.code === 200, `got ${res.code}`);
    const body = JSON.parse(res.body);
    ok('hasKey boolean', typeof body.hasKey === 'boolean');
    ok('skills array present', Array.isArray(body.skills) && body.skills.length >= 5, `got ${body.skills?.length}`);
    ok('skill has name/note/description', body.skills.every(s => typeof s.name === 'string' && typeof s.note === 'string'));
    ok('llmError field present', 'llmError' in body);
}

// ── 3. GET translated (zh) — no key → fallback, must not 500 ──
console.log('[3] GET /api/skill-list-translated?locale=zh');
{
    const res = mockRes();
    await routes.get('/api/skill-list-translated')({ method: 'GET', url: '/api/skill-list-translated?locale=zh' }, res);
    ok('status 200', res.code === 200, `got ${res.code}`);
    const body = JSON.parse(res.body);
    ok('skills returned', body.skills?.length >= 5, `got ${body.skills?.length}`);
    ok('descriptions non-empty', body.skills.every(s => s.descriptionTranslated && s.descriptionTranslated.length > 0));
}

// ── 4. saveNote roundtrip via the real route ──
console.log('[4] saveNote roundtrip');
{
    const post = mockRes();
    await routes.get('/api/skill-list-config')(makePost({ action: 'saveNote', name: 'tdd', note: 'TDD note' }), post);
    ok('saveNote 200', post.code === 200, `got ${post.code} ${post.body.slice(0, 80)}`);
    if (post.code === 200) {
        const saved = JSON.parse(post.body);
        ok('note reflected', saved.skills?.find(s => s.name === 'tdd')?.note === 'TDD note');

        const res = mockRes();
        await routes.get('/api/skill-list-translated')({ method: 'GET', url: '/api/skill-list-translated?locale=zh' }, res);
        const tdd = JSON.parse(res.body).skills.find(s => s.name === 'tdd');
        ok('note shown in menu', tdd?.descriptionTranslated === 'TDD note', tdd?.descriptionTranslated?.slice(0, 20));

        const clr = mockRes();
        await routes.get('/api/skill-list-config')(makePost({ action: 'saveNote', name: 'tdd', note: '' }), clr);
        ok('clearNote 200', clr.code === 200);
        const cleared = clr.code === 200 ? JSON.parse(clr.body).skills?.find(s => s.name === 'tdd')?.note : '<no>';
        ok('note cleared', cleared === '', `got "${cleared}"`);
    }
}

// ── 5. source sanity ──
console.log('[5] source sanity');
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf-8');
ok('let cache declared', /\nlet cache = \{\};/.test(src));
ok('withCacheLock used in translateDescriptions', /return withCacheLock\(async/.test(src));
ok('merge-on-write present', /cache = \{ \.\.\.disk, \.\.\.cache \}/.test(src));
ok('concise prompt', /CONCISE one-line summary/.test(src));
ok('prewarm both locales', /for \(const locale of \['zh', 'en'\]\)/.test(src));
ok('readBody accepts string chunks', /typeof c === 'string' \? Buffer\.from\(c\)/.test(src));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
