// The connector's config.toml editing: reading the structure of Kimi's file
// and the three edits the hub may make to [secondary_model] (repair a stale
// alias, remove the table the hub wrote, compare "everything else"). The
// scanner is pulled out of the connector's source (it is one file, nothing to
// import) and run on config.toml files shaped the way people really write
// them: comments after headers, single-quoted keys, spaced and quoted
// headers, inline tables, dotted keys, CRLF, multi-line strings that look
// like headers. Every result is parsed again by Python's tomllib, and the
// untouched settings must be equal to the original's, value for value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseToml, isToml, tomlSkip } from './fixtures/toml-oracle.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const source = fs.readFileSync(path.join(ROOT, 'bridge/agent-hub-bridge.mjs'), 'utf8');
const block = source.slice(source.indexOf('// ---- toml:begin'), source.indexOf('// ---- toml:end'));
assert.ok(block.length > 2000, 'found the scanner block in the connector');
const lib = new Function('DS_PROVIDER', `${block}\nreturn { tomlScan, tomlOthers, tomlOutside, tomlStripHub, tomlRepair, TomlUnsupported };`)('agent-hub-deepseek');
const { tomlScan, tomlOthers, tomlStripHub, tomlRepair, TomlUnsupported } = lib;

const OLD = 'agent-hub-deepseek/deepseek/deepseek-v4.1-flash';
const OLD_PRO = 'agent-hub-deepseek/deepseek/deepseek-v4-pro';
const NEW = 'agent-hub-deepseek/deepseek-v4.1-flash';
const NEW_PRO = 'agent-hub-deepseek/deepseek-v4-pro';
const SUB = 'managed:kimi-code/kimi-for-coding';
// A repair after a gateway change: Flash and Pro keep their descriptions under
// the new aliases (the plan secondaryRepairPlan makes for such a file).
const plan = (over = {}) => ({
  oldDefault: OLD,
  wanted: { model: NEW, models: [NEW, NEW_PRO, SUB] },
  mappings: new Map([[OLD, NEW], [OLD_PRO, NEW_PRO]]),
  owners: new Map([[NEW, OLD], [NEW_PRO, OLD_PRO]]),
  existing: new Set([SUB]),
  ...over,
});

// The settings that surround [secondary_model] in every fixture.
const SURROUND = `default_model = "${SUB}"
default_provider = "managed:kimi-code"

[thinking]
enabled = true
effort = "high"

[providers.other]
type = "openai"
base_url = "https://other.example/v1"
note = """
[secondary_model]
default_model = "this is inside a string"
"""
tags = [
  "a",
  "[secondary_model.models]",
]

[models."other/m"]
provider = "other"
`;

const without = (parsed) => {
  const { secondary_model, ...rest } = structuredClone(parsed);
  return rest;
};

function repairOk(secondaryText, { eol = '\n', trailer = '', over = {} } = {}) {
  const cv = (t) => t.replace(/\n/g, eol);
  const head = cv(`${SURROUND}\n`);
  const before = head + cv(secondaryText) + cv(trailer);
  const parsedBefore = parseToml(before);
  const after = tomlRepair(before, plan(over));
  assert.notEqual(after, before);
  const parsedAfter = parseToml(after);
  // Everything that is not [secondary_model] is the same value for value...
  assert.deepEqual(without(parsedAfter), without(parsedBefore));
  // ...and the text around it is the same bytes (the lines before the table,
  // and any tables after it).
  assert.ok(after.startsWith(head), 'the settings before [secondary_model] are byte for byte the same');
  assert.ok(after.endsWith(cv(trailer)), 'and so are the tables after it');
  assert.equal(after.includes('\r\n'), eol === '\r\n', 'the line endings are kept');
  assert.ok(!/\r?\n$/.test(after) === !/\r?\n$/.test(before), 'and the final newline');
  return { before, after, parsedBefore, parsedAfter };
}

test('the scanner reads headers and keys however they are spelled', { skip: tomlSkip }, () => {
  const text = [
    '[ a . "b/c" . \'d e\' ]   # comment ]',
    "'x y' = 1  # c",
    'dotted.key."q r" = [ 1,',
    '  2 ]  # array across lines',
    'm = """',
    '[not.a.header]',
    '"""',
    '[[arr]]',
    'k = { a = 1, b = "two" }',
    '',
  ].join('\n');
  assert.ok(isToml(text));
  const doc = tomlScan(text);
  const shape = doc.stmts.map((s) => [s.type, s.path.join('|'), s.table?.join('|') ?? '', s.start, s.end]);
  assert.deepEqual(shape, [
    ['table', 'a|b/c|d e', '', 0, 0],
    ['kv', 'x y', 'a|b/c|d e', 1, 1],
    ['kv', 'dotted|key|q r', 'a|b/c|d e', 2, 3],
    ['kv', 'm', 'a|b/c|d e', 4, 6],
    ['aot', 'arr', '', 7, 7],
    ['kv', 'k', 'arr', 8, 8],
  ]);
});

test('text the scanner cannot read exactly is refused, not guessed', () => {
  for (const [name, text] of [
    ['unterminated string', 'a = "oops\n'],
    ['unterminated multi-line string', 'a = """\nx\n'],
    ['unterminated array', 'a = [1,\n2\n'],
    ['text after a value', 'a = 1 2\n'],
    ['no equals', 'a 1\n'],
    ['bad header', '[a\nb = 1\n'],
    ['a key escape it does not know', '"\\q" = 1\n'],
  ]) {
    assert.throws(() => tomlScan(text), (e) => e instanceof TomlUnsupported, name);
  }
});

const SECOND = {
  'plain nested and direct entries': `[secondary_model]
default_model = "${OLD}"
default_effort = "high"

[secondary_model.models]
"${OLD}" = "Flash（我的描述）"
"${SUB}" = "K3.1 Pro"

[secondary_model.models."${OLD_PRO}"]
description = "Pro nested"
`,
  'trailing comments on headers and values': `[secondary_model] # my subagents
default_model = "${OLD}" # keep this comment
default_effort = "high"

[secondary_model.models]   # the pool
"${OLD}" = "Flash（我的描述）"  # and this
"${SUB}" = "K3.1 Pro"

[secondary_model.models."${OLD_PRO}"] # nested
description = "Pro nested"
`,
  'single-quoted keys and values': `[secondary_model]
default_model = '${OLD}'
default_effort = 'high'

[secondary_model.models]
'${OLD}' = 'Flash（我的描述）'
'${SUB}' = 'K3.1 Pro'

[secondary_model.models.'${OLD_PRO}']
description = 'Pro nested'
`,
  'spaced and quoted headers': `[ "secondary_model" ]
default_model = "${OLD}"
default_effort = "high"

[ secondary_model . 'models' ]
"${OLD}" = "Flash（我的描述）"
"${SUB}" = "K3.1 Pro"

[ secondary_model . models . "${OLD_PRO}" ]
description = "Pro nested"
`,
  'a models table that does not exist yet': `[secondary_model]
default_model = "${OLD}"
default_effort = "high"
`,
  'the secondary table sits between other tables': `[secondary_model]
default_model = "${OLD}"
default_effort = "high"

[secondary_model.models]
"${OLD}" = "Flash（我的描述）"
"${OLD_PRO}" = "Pro 直接寫入"
"${SUB}" = "K3.1 Pro"
`,
};

const TRAILER = '\n[providers.after]\ntype = "openai"\nbase_url = "https://after.example/v1"\n';
for (const [name, text] of Object.entries(SECOND)) {
  test(`repair: ${name}`, { skip: tomlSkip }, () => {
    for (const eol of ['\n', '\r\n']) {
      for (const trailer of ['', TRAILER]) {
      const { parsedAfter } = repairOk(text, { eol, trailer });
      const sec = parsedAfter.secondary_model;
      assert.equal(sec.default_model, NEW);
      assert.equal(sec.default_effort, 'high', 'effort untouched');
      assert.ok(NEW in (sec.models || {}), 'the default is in the pool');
      assert.ok(!(OLD in (sec.models || {})) && !(OLD_PRO in (sec.models || {})), 'old aliases are gone');
      if (SUB in (sec.models || {})) {
        const d = sec.models[SUB];
        assert.ok(d === 'K3.1 Pro' || d.description === 'K3.1 Pro', 'the user\'s own entry is kept as it was');
      }
      if (trailer) assert.equal(parsedAfter.providers.after.base_url, 'https://after.example/v1');
      }
    }
  });
}

test('repair keeps comments and descriptions on the lines it edits', { skip: tomlSkip }, () => {
  const { after, parsedAfter } = repairOk(SECOND['trailing comments on headers and values']);
  assert.match(after, /\[secondary_model\] # my subagents/);
  assert.match(after, /default_model = "agent-hub-deepseek\/deepseek-v4\.1-flash" # keep this comment/);
  assert.match(after, /\[secondary_model\.models\]   # the pool/);
  assert.match(after, /"agent-hub-deepseek\/deepseek-v4\.1-flash" = "Flash（我的描述）"  # and this/);
  assert.equal(parsedAfter.secondary_model.models[NEW], 'Flash（我的描述）');
  assert.equal(parsedAfter.secondary_model.models[NEW_PRO], 'Pro nested', 'a nested table\'s description moves to a direct entry');
});

const REFUSED = {
  'inline table': `secondary_model = { default_model = "${OLD}", default_effort = "high" }\n`,
  'dotted keys at the root': `secondary_model.default_model = "${OLD}"\nsecondary_model.default_effort = "high"\n`,
  'models as an inline table': `[secondary_model]\ndefault_model = "${OLD}"\nmodels = { "${OLD}" = "d", "${SUB}" = "k" }\n`,
  'models as a dotted key': `[secondary_model]\ndefault_model = "${OLD}"\nmodels."${OLD}" = "d"\n`,
  'an array of tables': `[[secondary_model]]\ndefault_model = "${OLD}"\n`,
  'a dotted key inside the pool': `[secondary_model]\ndefault_model = "${OLD}"\n[secondary_model.models]\n"${OLD}".description = "d"\n`,
  'a default_model that is not a one-line string': `[secondary_model]\ndefault_model = """\n${OLD}\n"""\n`,
};
for (const [name, text] of Object.entries(REFUSED)) {
  test(`repair refuses without touching anything: ${name}`, { skip: tomlSkip }, () => {
    const before = `${SURROUND}\n${text}`;
    assert.ok(isToml(before), 'the fixture is valid TOML');
    assert.throws(() => tomlRepair(before, plan()), (e) => e instanceof TomlUnsupported && e.message.length > 5, name);
  });
}

test('repair refuses a file it cannot read, and a repair that would change anything else', () => {
  assert.throws(() => tomlRepair('[secondary_model\ndefault_model = "x"\n', plan()), (e) => e instanceof TomlUnsupported);
  // Same text in, nothing to do.
  assert.throws(() => tomlRepair(`[secondary_model]\ndefault_model = "${NEW}"\n[secondary_model.models]\n"${NEW}" = "d"\n`, plan({ oldDefault: NEW, mappings: new Map(), owners: new Map(), existing: new Set([NEW]) })), (e) => e instanceof TomlUnsupported);
});

const HUB_TABLE = (head = '[secondary_model]', model = NEW) => `${head}\ndefault_model = "${model}"\ndefault_effort = "max"\n`;

test('strip removes exactly the table the hub wrote, however it was spelled', { skip: tomlSkip }, () => {
  for (const [name, table] of [
    ['plain', HUB_TABLE()],
    ['comment on the header', HUB_TABLE('[secondary_model] # made by Agent Hub')],
    ['spaced header', HUB_TABLE('[ secondary_model ]')],
    ['quoted header', HUB_TABLE('["secondary_model"]')],
    ['single-quoted value', `[secondary_model]\ndefault_model = '${NEW}'\ndefault_effort = "max"\n`],
    ['no effort', `[secondary_model]\ndefault_model = "${NEW}"\n`],
  ]) {
    for (const eol of ['\n', '\r\n']) {
      const before = `${SURROUND}\n${table}\n[providers.after]\ntype = "openai"\n`.replace(/\n/g, eol);
      const parsedBefore = parseToml(before);
      const after = tomlStripHub(before);
      assert.equal(typeof after, 'string', name);
      const parsedAfter = parseToml(after);
      assert.equal(parsedAfter.secondary_model, undefined, name);
      assert.deepEqual(parsedAfter, without(parsedBefore), `${name}: nothing else changed`);
      assert.equal(tomlOthers(after), tomlOthers(before), name);
    }
  }
});

test('strip leaves a table that is not exactly the hub\'s alone', { skip: tomlSkip }, () => {
  for (const [name, text] of [
    ['a pool', `${HUB_TABLE()}\n[secondary_model.models]\n"${NEW}" = "d"\n`],
    ['an extra key', `[secondary_model]\ndefault_model = "${NEW}"\nforce = true\n`],
    ['someone else\'s model', HUB_TABLE('[secondary_model]', SUB)],
    ['inline table', `secondary_model = { default_model = "${NEW}" }\n`],
    ['dotted keys', `secondary_model.default_model = "${NEW}"\n`],
    ['models as an inline table', `[secondary_model]\ndefault_model = "${NEW}"\nmodels = { "${NEW}" = "d" }\n`],
    ['no default_model', `[secondary_model]\ndefault_effort = "high"\n`],
  ]) {
    const before = `${SURROUND}\n${text}`;
    assert.ok(isToml(before), name);
    assert.equal(tomlStripHub(before), null, name);
  }
  assert.equal(tomlStripHub('[secondary_model\n'), null, 'a file it cannot read');
});

test('"everything else" ignores comments and quoting, but not another provider\'s change or a lookalike provider', { skip: tomlSkip }, () => {
  const a = `${SURROUND}\n${HUB_TABLE()}`;
  const normalized = a.replace(/'/g, '"').replace(/^default_provider = .*$/m, 'default_provider = \'managed:kimi-code\' # same value');
  assert.equal(tomlOthers(normalized), tomlOthers(a), 'quote style and comments are not settings');
  assert.notEqual(tomlOthers(a.replace('"high"', '"low"')), tomlOthers(a), 'a changed setting is');
  assert.notEqual(tomlOthers(a.replace('https://other.example/v1', 'https://evil.example/v1')), tomlOthers(a));
  // The hub's own tables are left out; a name that merely starts the same is not the hub's.
  const mine = `${a}\n[providers.agent-hub-deepseek]\ntype = "openai"\nbase_url = "http://127.0.0.1:1/x"\n\n[models."agent-hub-deepseek/m"]\nprovider = "agent-hub-deepseek"\n`;
  assert.equal(tomlOthers(mine), tomlOthers(a), 'the hub\'s provider and model tables do not count');
  const lookalike = `${a}\n[providers.agent-hub-deepseek-xxx]\ntype = "openai"\nbase_url = "https://x.example/v1"\n`;
  assert.notEqual(tomlOthers(lookalike), tomlOthers(a), 'a provider that only shares a prefix is somebody else\'s');
  assert.notEqual(tomlOthers(lookalike.replace('x.example', 'y.example')), tomlOthers(lookalike));
});
