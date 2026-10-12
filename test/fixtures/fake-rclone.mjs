#!/usr/bin/env node
// rclone, as far as Agent Hub uses it, for the tests: "Google Drive" is the
// folder $FAKE_RCLONE/drive, the sign-in is $FAKE_RCLONE/config.json, and
// the browser sign-in finishes once $FAKE_RCLONE/authorized exists.
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.FAKE_RCLONE;
const CONFIG = path.join(STATE, 'config.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(STATE, 'calls'), `${args.join(' ')}\n`);
const config = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {});
const die = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
// "remote:path" -> the folder standing for it.
function local(p) {
  const i = p.indexOf(':');
  if (i < 1 || p.startsWith('/')) return p;
  const name = p.slice(0, i);
  if (!config()[name]) die(`Failed to create file system for "${p}": didn't find section in config file ("${name}")`);
  return path.join(STATE, 'drive', p.slice(i + 1));
}

const [cmd, ...rest] = args;
switch (cmd) {
  case 'version':
    console.log('rclone v1.68.0\n- os/version: test');
    break;
  case 'listremotes':
    for (const name of Object.keys(config())) console.log(`${name}:`);
    break;
  case 'about': {
    const name = rest[0].replace(/:$/, '');
    const c = config()[name];
    if (!c) die(`didn't find section in config file ("${name}")`);
    if (!String(c.token).includes('good')) die('couldn\'t fetch token: invalid_grant');
    console.log(JSON.stringify({ total: 15e9, used: 1e9, free: 14e9 }));
    break;
  }
  case 'authorize': {
    console.log('NOTICE: If your browser doesn\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=fake123');
    console.log('NOTICE: Log in and authorize rclone for access');
    const wait = () => {
      if (!fs.existsSync(path.join(STATE, 'authorized'))) return setTimeout(wait, 100);
      console.log('Paste the following into your remote machine --->\n{"access_token":"good-token","token_type":"Bearer","expiry":"2030-01-01T00:00:00Z"}\n<---End paste');
    };
    wait();
    break;
  }
  case 'config': {
    const c = config();
    if (rest[0] === 'delete') delete c[rest[1]];
    if (rest[0] === 'create') {
      const token = rest.find((a) => a.startsWith('token='))?.slice(6);
      c[rest[1]] = { type: rest[2], token };
    }
    fs.writeFileSync(CONFIG, JSON.stringify(c));
    break;
  }
  case 'sync': {
    const [src, dst] = rest;
    const list = fs.readFileSync(rest[rest.indexOf('--files-from') + 1], 'utf8').split('\n').filter(Boolean);
    const to = local(dst);
    fs.rmSync(to, { recursive: true, force: true });
    for (const f of list) {
      fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(to, f));
    }
    break;
  }
  case 'copyto': {
    const to = local(rest[1]);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(rest[0], to);
    break;
  }
  case 'lsf': {
    const dir = local(rest[0]);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) console.log(f);
    break;
  }
  case 'deletefile':
    fs.rmSync(local(rest[0]));
    break;
  default:
    die(`unknown command ${cmd}`);
}
