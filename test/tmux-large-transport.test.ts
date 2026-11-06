import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import {
  captureTmuxText, encodeTmuxFrame, parseTmuxRequest, parseTmuxResponse,
  TMUX_TEXT_BYTES, TMUX_FRAME_BYTES, TmuxFrameDecoder, TmuxWorkerLedger,
  type TmuxRequest,
} from '../tmux-protocol.js';

// Real local socket, synthetic text only: not a Pi/provider settlement gate.
test('128KiB prompt and escaped result survive fragmented Unix socket transport with exact identity', { timeout: 15000 }, async () => {
  const directory = await mkdtemp('/srv/devops/tmux-wire-');
  const path = `${directory}/s`;
  const identity = { workerId: 'wire-worker', sessionId: 'wire-session', generation: 'wire-generation', ownerNonce: 'a'.repeat(64), epoch: 0 };
  const job = { ...identity, jobId: 'wire-job', runId: 'wire-run', taskId: 'wire-task', source: 'coordinator' };
  // Independently calculated: 32767 emoji * 4 UTF-8 bytes + four ASCII bytes = 131072.
  const input = '😀'.repeat(32767) + 'TAIL';
  // Worst JSON escaping: 131072 NUL bytes become 786432 payload bytes on the wire.
  const output = '\u0000'.repeat(131072);
  assert.equal(Buffer.byteLength(input), 131072);
  assert.equal(TMUX_TEXT_BYTES, 131072);
  const ledger = new TmuxWorkerLedger(identity);
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const write = async (socket: Socket, frame: Buffer) => {
    for (let offset = 0; offset < frame.length; offset += 4093) {
      if (!socket.write(frame.subarray(offset, offset + 4093))) await once(socket, 'drain');
    }
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => failures.push(error));
    const decoder = new TmuxFrameDecoder();
    socket.on('data', chunk => {
      try {
        for (const frame of decoder.push(chunk)) {
          const request = parseTmuxRequest(frame);
          if (request.action === 'prompt') assert.equal(request.text, input);
          const reply = ledger.accept(request);
          if (request.action === 'prompt') ledger.settle(reply.snapshot.job!, 'completed', output, false);
          void write(socket, encodeTmuxFrame(reply)).catch(error => { failures.push(error); socket.destroy(); });
        }
      } catch (error) { failures.push(error); socket.destroy(); }
    });
  });
  const exchange = async (request: TmuxRequest) => {
    const socket = connect(path);
    sockets.add(socket);
    const decoder = new TmuxFrameDecoder();
    try {
      const received = new Promise<unknown>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('end', () => reject(new Error('Incomplete response')));
        socket.setTimeout(5000, () => reject(new Error('Response deadline')));
        socket.on('data', chunk => {
          try {
            const frames = decoder.push(chunk);
            if (frames.length) { decoder.finish(); assert.equal(frames.length, 1); resolve(frames[0]); }
          } catch (error) { reject(error); }
        });
      });
      await once(socket, 'connect');
      await write(socket, encodeTmuxFrame(request));
      return parseTmuxResponse(await received, request);
    } finally { socket.destroy(); sockets.delete(socket); }
  };
  try {
    server.listen(path);
    await once(server, 'listening');
    const prompt = parseTmuxRequest({ version: 1, requestId: 'prompt', identity, action: 'prompt', expectedJobId: null, job, text: input });
    assert.equal((await exchange(prompt)).status, 'accepted');
    const show = parseTmuxRequest({ version: 1, requestId: 'show', identity, action: 'show', expectedJobId: job.jobId, job: null, text: null });
    const reply = await exchange(show);
    const result = reply.snapshot.result!;
    const observed = process.env.CLANKERS_TMUX_LARGE_PLANTED_FAULT === '1' ? result.text.slice(1) : result.text;
    // Compare length before content so the planted fault cannot print a huge payload.
    assert.equal(observed.length, 131072);
    assert.ok(observed === output);
    assert.deepEqual(result.identity, job);
    assert.equal(result.textClipped, false);
    assert.ok(encodeTmuxFrame(reply).length <= TMUX_FRAME_BYTES);
    assert.throws(() => parseTmuxResponse({ ...reply, expectedJobId: 'replacement-job' }, show), /Mismatched/);
    assert.throws(() => parseTmuxRequest({ ...prompt, text: input + 'x' }), /text/);
    assert.deepEqual(captureTmuxText([{ type: 'text', text: input + '😀' }]), { text: input, clipped: true });
    // A three-byte remaining budget must not split a four-byte code point.
    assert.deepEqual(captureTmuxText([{ type: 'text', text: 'a'.repeat(131069) + '😀' }]), { text: 'a'.repeat(131069), clipped: true });
    assert.deepEqual(failures, []);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
