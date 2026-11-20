import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vsctm from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let grammarPromise;
function loadGrammar() {
    if (!grammarPromise) {
        grammarPromise = (async () => {
            const wasmBin = fs.readFileSync(path.join(ROOT, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer;
            await oniguruma.loadWASM(wasmBin);
            const rawGrammar = fs.readFileSync(path.join(ROOT, 'syntax/valk.json'), 'utf8');
            const registry = new vsctm.Registry({
                onigLib: Promise.resolve({
                    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
                    createOnigString: (s) => new oniguruma.OnigString(s),
                }),
                loadGrammar: async (scopeName) => {
                    if (scopeName === 'source.valk') {
                        return vsctm.parseRawGrammar(rawGrammar, 'syntax/valk.json');
                    }
                    return null;
                },
            });
            return registry.loadGrammar('source.valk');
        })();
    }
    return grammarPromise;
}

async function tokenize(code) {
    const grammar = await loadGrammar();
    let ruleStack = vsctm.INITIAL;
    const lines = code.split('\n');
    const tokens = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const res = grammar.tokenizeLine(line, ruleStack);
        ruleStack = res.ruleStack;
        for (const tok of res.tokens) {
            const text = line.slice(tok.startIndex, tok.endIndex);
            if (text.trim().length > 0) {
                tokens.push({ line: lineIndex, text, scopes: tok.scopes });
            }
        }
    }
    return tokens;
}

function findToken(tokens, text, predicate) {
    const matches = tokens.filter((t) => t.text === text && (!predicate || predicate(t)));
    assert.ok(matches.length > 0, `Expected token "${text}" in:\n${JSON.stringify(tokens, null, 2)}`);
    return matches[0];
}

function assertScope(tokens, text, expectedScope, predicate) {
    const tok = findToken(tokens, text, predicate);
    assert.ok(
        tok.scopes.includes(expectedScope),
        `Expected token "${text}" to have scope "${expectedScope}", got: ${JSON.stringify(tok.scopes)}`
    );
}

test('bench and synctest keywords', async () => {
    const tokens = await tokenize(`
bench "hash payload" {
    let data = "abc"
    while b.loop() {
        b.keep(data.hash())
    }
}
synctest "sync flush" {
    assert(true)
}
`);
    assertScope(tokens, 'bench', 'keyword.other.valk');
    assertScope(tokens, 'synctest', 'keyword.other.valk');
    assertScope(tokens, 'let', 'keyword.other.valk');
    assertScope(tokens, 'assert', 'support.function.builtin.valk');
});

test('$tag(...) and backtick field tags vs prop.$tag(...)', async () => {
    const tokens = await tokenize(`
class User {
    id: int \`json: "user_id", db: "id", pk\`
    name: String $tag(json: "full_name", omitempty)
    note: String ("has \`backticks\` inside")
    // comment with \`backticks\`
}
fn inspect[T]() {
    #loop properties T as prop
    let key = prop.$tag("json", prop.name)
    #end
}
`);
    assertScope(tokens, '`', 'punctuation.definition.tag.begin.valk');
    assertScope(tokens, 'json', 'entity.other.attribute-name.valk', (t) => t.line === 2);
    assertScope(tokens, 'pk', 'entity.other.attribute-name.valk', (t) => t.line === 2);
    assertScope(tokens, 'user_id', 'string.quoted.double.valk', (t) => t.line === 2);

    assertScope(tokens, '$tag', 'support.constant.valk', (t) => t.line === 3);
    assertScope(tokens, 'json', 'entity.other.attribute-name.valk', (t) => t.line === 3);
    assertScope(tokens, 'omitempty', 'entity.other.attribute-name.valk', (t) => t.line === 3);
    assertScope(tokens, 'full_name', 'string.quoted.double.valk', (t) => t.line === 3);

    // Backticks inside string and comment must not open field tags
    const stringLineTokens = tokens.filter((t) => t.line === 4);
    assert.ok(stringLineTokens.every((t) => !t.scopes.includes('meta.annotation.tag.valk')));
    const commentLineTokens = tokens.filter((t) => t.line === 5);
    assert.ok(commentLineTokens.every((t) => !t.scopes.includes('meta.annotation.tag.valk')));

    // prop.$tag(...) is a method call, not a property annotation
    const methodTag = findToken(tokens, '$tag', (t) => t.line === 9);
    assert.ok(methodTag.scopes.includes('support.constant.valk'));
    assert.ok(!methodTag.scopes.includes('meta.annotation.tag.valk'));
});

test('Weak, BTreeMap, BTreeSet, SELF, and atomic builtins', async () => {
    const tokens = await tokenize(`
class Cache {
    ref: Weak[Node]
    tree: BTreeMap[String, int]
    seen: BTreeSet[uint]
    static fn new() SELF {
        let ok = atomic_cas(flag, 0, 1)
        let cur = atomic_load(flag)
        atomic_store(flag, 0)
        return SELF {}
    }
}
`);
    assertScope(tokens, 'Weak', 'support.type.valk');
    assertScope(tokens, 'BTreeMap', 'support.type.valk');
    assertScope(tokens, 'BTreeSet', 'support.type.valk');
    assertScope(tokens, 'SELF', 'support.type.valk');
    assertScope(tokens, 'atomic_cas', 'support.function.builtin.valk');
    assertScope(tokens, 'atomic_load', 'support.function.builtin.valk');
    assertScope(tokens, 'atomic_store', 'support.function.builtin.valk');
});

test('const generics and is interface/builtin constraints', async () => {
    const tokens = await tokenize(`
struct FixedBuf[T is Printable + $eq + $order, const N: uint] is io.Writer {
    data: [T x N]
}
`);
    assertScope(tokens, 'const', 'keyword.other.valk');
    assertScope(tokens, 'is', 'keyword.other.valk', (t) => t.scopes.includes('keyword.other.valk'));
    assertScope(tokens, '$eq', 'support.constant.valk');
    assertScope(tokens, '$order', 'support.constant.valk');
    const isTokens = tokens.filter((t) => t.text === 'is');
    assert.equal(isTokens.length, 2);
    for (const tok of isTokens) {
        assert.ok(tok.scopes.includes('keyword.other.valk'));
    }
});

test('string interpolation format specifiers vs ternary and nested braces', async () => {
    const tokens = await tokenize(`
let a = "%{n:04x} %{u:#08X} %{f:+.2f} %{s:*^10} %{n: 05} %{b:#08b} %{o:#o}"
let b = "%{cond ? x : y} %{cond ? a : 0} %{Point{ x: 1 }:>10}"
`);
    assertScope(tokens, '04x', 'constant.other.placeholder.valk');
    assertScope(tokens, '#08X', 'constant.other.placeholder.valk');
    assertScope(tokens, '+.2f', 'constant.other.placeholder.valk');
    assertScope(tokens, '*^10', 'constant.other.placeholder.valk');
    assertScope(tokens, ' 05', 'constant.other.placeholder.valk');
    assertScope(tokens, '#08b', 'constant.other.placeholder.valk');
    assertScope(tokens, '#o', 'constant.other.placeholder.valk');

    // Ternary branches must not be mis-classified as format specifiers
    const line2 = tokens.filter((t) => t.line === 2);
    const fmtOnLine2 = line2.filter((t) => t.scopes.includes('constant.other.placeholder.valk'));
    assert.deepEqual(fmtOnLine2.map((t) => t.text), ['>10']);
});

test('inline #embed/#embed_dir, octal 0c, match default, and field names', async () => {
    const tokens = await tokenize(`
let raw = #embed("data.bin")
let dir = #embed_dir("assets")
let mode = 0c755
let obj = Item { type: 1, value: 2, error: "ok" }
mode MyMap[T] for HashMap[String, T] {}
let x = match v : int {
    .a => 1
    default => 0
}
`);
    assertScope(tokens, '#embed', 'keyword.control.directive.valk');
    assertScope(tokens, '#embed_dir', 'keyword.control.directive.valk');
    assertScope(tokens, '0c755', 'constant.numeric.octal.valk');
    assertScope(tokens, 'mode', 'keyword.other.valk', (t) => t.line === 5);
    assertScope(tokens, 'default', 'keyword.control.valk');

    // Variable/field names followed by '=' or ':' should not be highlighted as keywords
    const line3Keywords = tokens.filter((t) => t.line === 3 && t.scopes.includes('keyword.other.valk')).map((t) => t.text);
    assert.deepEqual(line3Keywords, ['let']);
    const line4Keywords = tokens.filter((t) => t.line === 4 && t.scopes.includes('keyword.other.valk')).map((t) => t.text);
    assert.deepEqual(line4Keywords, ['let']);
});

test('snippets/valk.json and language-config.json are valid', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const snippets = JSON.parse(fs.readFileSync(path.join(ROOT, 'snippets/valk.json'), 'utf8'));
    const langCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'language-config.json'), 'utf8'));

    assert.equal(pkg.contributes.snippets[0].path, './snippets/valk.json');
    for (const [name, snip] of Object.entries(snippets)) {
        assert.ok(typeof snip.prefix === 'string' && snip.prefix.length > 0, `Snippet "${name}" missing prefix`);
        assert.ok(Array.isArray(snip.body) && snip.body.length > 0, `Snippet "${name}" missing body`);
        assert.ok(typeof snip.description === 'string' && snip.description.length > 0, `Snippet "${name}" missing description`);
    }
    for (const required of ['bench', 'synctest', 'tag', 'btag', 'weak', 'cas', 'loopprops']) {
        assert.ok(
            Object.values(snippets).some((s) => s.prefix === required),
            `Missing snippet with prefix "${required}"`
        );
    }
    assert.ok(langCfg.autoClosingPairs.some((p) => p.open === '`' && p.close === '`'));
    assert.ok(langCfg.surroundingPairs.some(([o, c]) => o === '`' && c === '`'));
});
