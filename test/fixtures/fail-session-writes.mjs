// Preload for a child process (node --import this-file ..., or NODE_OPTIONS):
// the temporary file a conversation save writes next to the conversation
// (`<id>.json.<pid>.w.tmp`) cannot be created, as on a disk that refuses writes.
// A permission bit would not do: the tests may run as root, who ignores it.
// Nothing else is touched (the shutdown flush uses another name).
import fs from 'node:fs';

const open = fs.promises.open;
fs.promises.open = (p, ...rest) =>
  /\.w\.tmp$/.test(String(p)) ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES', errno: -13, syscall: 'open', path: String(p) })) : open.call(fs.promises, p, ...rest);
