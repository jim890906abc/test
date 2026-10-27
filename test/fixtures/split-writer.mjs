// A child process that writes known bytes in pieces, cut at the byte offsets
// it is told to, with a pause between pieces so each piece reaches the reader
// as a chunk of its own. A multi-byte character cut in the middle is what a
// reader that decodes every chunk on its own gets wrong.
//
//   node split-writer.mjs raw  <base64 payload> <cuts> [stderr]
//        writes the payload to stdout (or stderr) in pieces
//   node split-writer.mjs acp  <base64 title>   <cuts>
//        a minimal ACP agent: answers `initialize` with that title as its
//        agentInfo, written in pieces, and `session/new` plainly
//
// <cuts> is a comma-separated list of byte offsets into what is written.
import readline from 'node:readline';

const [mode, payloadB64, cutsText, which] = process.argv.slice(2);
const cuts = String(cutsText || '').split(',').filter(Boolean).map(Number);
const PAUSE_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writePieces(stream, buf) {
  let from = 0;
  for (const cut of [...cuts, buf.length]) {
    if (cut <= from) continue;
    await new Promise((r) => stream.write(buf.subarray(from, cut), r));
    from = cut;
    if (from < buf.length) await sleep(PAUSE_MS);
  }
}

if (mode === 'raw') {
  await writePieces(which === 'stderr' ? process.stderr : process.stdout, Buffer.from(payloadB64, 'base64'));
} else if (mode === 'acp') {
  const title = Buffer.from(payloadB64, 'base64').toString('utf8');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      const out = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { title, version: '1' }, agentCapabilities: {} } })}\n`);
      await writePieces(process.stdout, out);
    } else if (msg.method === 'session/new') {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } })}\n`);
    } else if (msg.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
    }
  }
}
