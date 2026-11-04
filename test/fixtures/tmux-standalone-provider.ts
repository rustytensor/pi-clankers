// Synthetic local provider. Expectations fixed by the lead before implementation.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export default async function (pi: any) {
  const sdkPath = process.env.TMUX_GATE_SDK;
  if (!sdkPath || !path.isAbsolute(sdkPath) || !fs.statSync(sdkPath).isFile()) throw Error('Absolute TMUX_GATE_SDK file required');
  const sdkPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdkPath), '../package.json'), 'utf8'));
  if (sdkPackage.name !== '@earendil-works/pi-coding-agent' || sdkPackage.version !== '1.4.0') throw Error('Pi 1.4.0 SDK required');
  const sdkRequire = createRequire(pathToFileURL(sdkPath));
  const { createJiti } = sdkRequire('jiti');
  const { createAssistantMessageEventStream } = await import(createJiti(sdkPath, { fsCache: false }).esmResolve('@earendil-works/pi-ai'));
  const root = process.env.TMUX_GATE_ROOT!;
  const calls: string[] = [], sources: string[] = [];
  let invocations = 0, phase = 'idle', error: string | null = null;
  const save = () => {
    const target = path.join(root, 'provider.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify({ invocations, calls, sources, phase, error }), { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  };
  save();
  pi.registerProvider('standalone-fixture', {
    baseUrl: 'http://fixture.invalid', apiKey: 'synthetic-not-a-key', api: 'openai-completions',
    models: [{ id: 'fixed', name: 'Offline fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
    streamSimple(model: any, context: any, options: any) {
      const ordinal = ++invocations;
      phase = 'invoked'; save();
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: 'pending', usage: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const latest = [...context.messages].reverse().find((m: any) => m.role === 'user');
          const input = typeof latest?.content === 'string' ? latest.content : (latest?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          let envelope: any = null;
          try { envelope = JSON.parse(input); } catch { /* Human text is not JSON. */ }
          const delegated = envelope && envelope.source === 'coordinator' &&
            envelope.authority === 'delegated-not-human-authorization' &&
            typeof envelope.text === 'string' && Object.keys(envelope).sort().join(',') === 'authority,source,text';
          const token = delegated ? envelope.text : input;
          const source = delegated ? 'coordinator' : input === 'HUMAN_ONE' ? 'human' : 'invalid';
          calls.push(token); sources.push(source); save();
          if (token !== ['COORD_ONE', 'WAIT_STEER', 'STEER_ONE', 'HUMAN_ONE', 'WAIT_CANCEL'][ordinal - 1] || source !== (ordinal === 4 ? 'human' : 'coordinator')) throw Error('input');
          stream.push({ type: 'start', partial: message });
          const text = ({ COORD_ONE: 'COORD_ONE_OK', STEER_ONE: 'STEER_ONE_OK', HUMAN_ONE: 'HUMAN_ONE_OK', WAIT_CANCEL: 'PARTIAL_CANCEL' } as Record<string, string>)[token] ?? '';
          if (text) {
            message.content = [{ type: 'text', text: '' }];
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            message.content[0].text = text;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
          }
          if (['WAIT_STEER', 'WAIT_CANCEL', 'HUMAN_ONE'].includes(token)) {
            phase = token; save();
            const deadline = Date.now() + 20000;
            const latch = token === 'WAIT_STEER' ? 'release-steer' : token === 'HUMAN_ONE' ? 'release-human' : null;
            while (!options?.signal?.aborted && !(latch && fs.existsSync(path.join(root, latch)))) {
              if (Date.now() >= deadline) throw Error('deadline');
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          if (text) stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'stop';
          message.rawStopReason = options?.signal?.aborted ? 'fixture_abort' : 'fixture_stop';
          if (options?.signal?.aborted) stream.push({ type: 'error', reason: 'aborted', error: message });
          else stream.push({ type: 'done', reason: 'stop', message });
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
