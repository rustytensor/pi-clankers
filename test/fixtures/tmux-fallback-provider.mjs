// Synthetic offline stream only. No network or live credentials.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
export default async function(pi) {
  const sdk = process.env.TMUX_GATE_SDK, root = process.env.TMUX_GATE_ROOT;
  assert(root.startsWith('/srv/devops/scratch/'));
  const { createJiti } = createRequire(sdk)('jiti');
  const { createAssistantMessageEventStream } = await import(createJiti(sdk, { fsCache: false }).esmResolve('@earendil-works/pi-ai'));
  const calls = []; let sessionId = null, error = null;
  const file = path.join(root, `provider-${process.pid}.json`);
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, sessionId, calls, error }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId(); save();
    fs.writeFileSync(path.join(root, `ui-${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, mode: ctx.mode, hasUI: ctx.hasUI, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, model: ctx.model }), { mode: 0o600 });
  });
  // Match provider-composer.js modelFromJson exactly, including own undefined fields.
  // The extension form spreads descriptors; omitting these changes deep equality.
  const models = ['z-first', 'a-second'].map(id => ({
    id, name: id, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096,
    thinkingLevelMap: undefined, inputLimits: undefined, promptCache: undefined,
    samplingParams: undefined, samplingParamsByThinkingLevel: undefined, compat: undefined,
  }));
  pi.registerProvider('fallback-fixture', {
    baseUrl: 'http://fixture.invalid', apiKey: 'synthetic-not-a-key', api: 'openai-completions', models,
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const msg = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: 'pending', usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => { try {
        const user = [...context.messages].reverse().find(m => m.role === 'user');
        const raw = typeof user.content === 'string' ? user.content : user.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const envelope = JSON.parse(raw), scenario = envelope.text;
        // Record every invocation before checks, so replay or C cannot hide in fixture errors.
        calls.push({ scenario, model, sessionId: options?.sessionId }); save();
        assert.deepEqual(envelope, { source: 'coordinator', authority: 'delegated-not-human-authorization', text: scenario });
        assert.equal(model.provider, 'fallback-fixture'); assert.equal(model.id, 'z-first');
        assert.equal(scenario, ['FIRST', 'SECOND', 'FAIL'][calls.length - 1]);
        assert.equal(options?.sessionId, sessionId);
        stream.push({ type: 'start', partial: msg });
        if (scenario === 'FAIL') {
          msg.stopReason = 'error'; msg.errorMessage = 'Synthetic provider failure; no retry or fallback permitted';
          stream.push({ type: 'error', reason: 'error', error: msg });
        } else {
          const text = scenario === 'FIRST' ? 'FIRST_OK' : 'SECOND_OK';
          msg.content = [{ type: 'text', text: '' }]; stream.push({ type: 'text_start', contentIndex: 0, partial: msg });
          msg.content[0].text = text; stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: msg });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg });
          msg.stopReason = 'stop'; stream.push({ type: 'done', reason: 'stop', message: msg });
        }
        stream.end();
      } catch (exc) {
        error = String(exc); save(); msg.stopReason = 'error'; msg.errorMessage = 'Fixture contract failed';
        stream.push({ type: 'error', reason: 'error', error: msg }); stream.end();
      } })();
      return stream;
    },
  });
}
