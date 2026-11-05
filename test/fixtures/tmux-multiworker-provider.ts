// Pi 1.5 offline fixture: per-process evidence, no shared writer paths or network.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export default async function (pi: any) {
  const sdk = process.env.TMUX_GATE_SDK!;
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'), 'utf8'));
  assert.equal(pkg.version, '1.5.0');
  const { createJiti } = createRequire(pathToFileURL(sdk))('jiti');
  const { createAssistantMessageEventStream } = await import(createJiti(sdk, { fsCache: false }).esmResolve('@earendil-works/pi-ai'));
  const root = process.env.TMUX_GATE_ROOT!;
  const file = path.join(root, `provider-${process.pid}.json`);
  const calls: string[] = [];
  let phase = 'idle', error: string | null = null, sessionId: string | null = null;
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, sessionId, calls, phase, error }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  pi.on('session_start', (_event: any, ctx: any) => {
    sessionId = ctx.sessionManager.getSessionId(); save();
    fs.writeFileSync(path.join(root, `ui-${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, mode: ctx.mode, hasUI: ctx.hasUI, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY }), { mode: 0o600 });
  });
  pi.registerProvider('multiworker-fixture', {
    baseUrl: 'http://fixture.invalid', apiKey: 'synthetic-not-a-key', api: 'openai-completions',
    models: [{ id: 'fixed', name: 'Offline multiworker fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: 'pending', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const user = [...context.messages].reverse().find((m: any) => m.role === 'user');
          const text = typeof user?.content === 'string' ? user.content : user.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          const envelope = JSON.parse(text), token = envelope.text;
          assert.deepEqual(envelope, { source: 'coordinator', authority: 'delegated-not-human-authorization', text: token });
          assert(calls.length === 0 ? ['A_WAIT', 'B_WAIT'].includes(token) : calls.length === 1 && calls[0] === 'B_WAIT' && token === 'B_REUSE');
          calls.push(token); phase = token; save();
          stream.push({ type: 'start', partial: message });
          const partial = token === 'A_WAIT' ? 'A_PARTIAL' : token === 'B_WAIT' ? 'B_PARTIAL' : 'B_REUSE_OK';
          message.content = [{ type: 'text', text: '' }];
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0].text = partial;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: partial, partial: message });
          const deadline = Date.now() + 60000;
          while (token !== 'B_REUSE' && !options?.signal?.aborted && !(token === 'B_WAIT' && fs.existsSync(path.join(root, `release-${process.pid}`)))) {
            assert(Date.now() < deadline, 'provider_wait_deadline');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          stream.push({ type: 'text_end', contentIndex: 0, content: partial, partial: message });
          if (options?.signal?.aborted) {
            message.stopReason = 'aborted'; message.errorMessage = 'synthetic cancellation';
            stream.push({ type: 'error', reason: 'aborted', error: message });
          } else {
            // Pi's finalized message is authoritative, not the earlier partial preview.
            const final = { ...message, content: [{ type: 'text', text: token === 'B_WAIT' ? 'B_OK' : 'B_REUSE_OK' }], stopReason: 'stop' };
            stream.push({ type: 'done', reason: 'stop', message: final });
          }
          phase = 'settled'; save(); stream.end();
        } catch {
          error = 'fixture_contract_failed'; phase = 'error'; save();
          message.stopReason = 'error'; message.errorMessage = error;
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        }
      })();
      return stream;
    },
  });
}
