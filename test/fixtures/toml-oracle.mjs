// An independent TOML parser for tests: Python's tomllib, so a test that
// says "the file is still valid TOML and nothing else changed" is not judged
// by the same code that wrote it. `tomlAvailable` is false where python3
// (3.11+) is missing; tests that need it then skip with that reason.
import { spawnSync } from 'node:child_process';

const PY = `import sys, json, tomllib, datetime
def enc(o):
    if isinstance(o, (datetime.datetime, datetime.date, datetime.time)):
        return o.isoformat()
    raise TypeError(type(o))
try:
    print(json.dumps(tomllib.loads(sys.stdin.buffer.read().decode('utf-8')), default=enc))
except Exception as e:
    print(json.dumps({"__error__": str(e)}))
    sys.exit(3)
`;

export const tomlAvailable = spawnSync('python3', ['-I', '-c', 'import tomllib']).status === 0;
export const tomlSkip = tomlAvailable ? false : 'python3 with tomllib (3.11+) is not available';

export function parseToml(text) {
  const r = spawnSync('python3', ['-I', '-c', PY], { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`not valid TOML: ${r.stdout || r.stderr}`);
  return JSON.parse(r.stdout);
}

export const isToml = (text) => {
  try {
    parseToml(text);
    return true;
  } catch {
    return false;
  }
};
