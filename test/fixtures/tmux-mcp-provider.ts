// Offline synthetic provider. Verifies actual Pi tool results by ID, never completion order.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export default async function (pi: any) {
  const sdk = process.env.TMUX_GATE_SDK!;
  assert(sdk && path.isAbsolute(sdk));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'), 'utf8'));
  assert(pkg.name === '@earendil-works/pi-coding-agent' && pkg.version === '1.4.0');
  const { createJiti } = createRequire(pathToFileURL(sdk))('jiti');
  const { createAssistantMessageEventStream } = await import(createJiti(sdk, { fsCache: false }).esmResolve('@earendil-works/pi-ai'));
  const root = process.env.TMUX_GATE_ROOT!, scenario = process.env.TMUX_MCP_SCENARIO!;
  let invocations = 0, verified = false, error: string | null = null;
  const save = () => {
    fs.writeFileSync(path.join(root, 'provider.json.tmp'), JSON.stringify({ invocations, verified, error }), { mode: 0o600 });
    fs.renameSync(path.join(root, 'provider.json.tmp'), path.join(root, 'provider.json'));
  };
  save();
  const search = (pattern: string) => ({ project: 'synthetic', pattern });
  const calls = [
    { id: 'allowed1', name: 'mcp', arguments: { tool: 'search_text', args: search('gateway') } },
    { id: 'allowed2', name: 'larra', arguments: { tool: 'larra_search_text', args: search('alias') } },
    { id: 'allowed3', name: 'larra_search_text', arguments: search('named') },
    { id: 'denied4', name: 'mcp', arguments: { tool: 'mcp__larra__delete_symbol', args: search('denied4') } },
    { id: 'denied5', name: 'larra', arguments: { tool: 'delete_symbol', args: search('denied5') } },
    { id: 'denied6', name: 'mcp', arguments: { tool: 'clankers_control', args: search('denied6') } },
    { id: 'denied7', name: 'mcp', arguments: { tool: 'zerg_control', args: search('denied7') } },
  ];
  pi.registerProvider('mcp-fixture', {
    baseUrl: 'http://fixture.invalid', apiKey: 'synthetic-not-a-key', api: 'openai-completions',
    models: [{ id: 'fixed', name: 'Offline MCP fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
    streamSimple(model: any, context: any, options: any) {
      const ordinal = ++invocations; save();
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: 'pending', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        try {
          assert(!options?.signal?.aborted);
          const user = [...context.messages].reverse().find((m: any) => m.role === 'user');
          const input = typeof user?.content === 'string' ? user.content : user?.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          const envelope = JSON.parse(input);
          assert.deepEqual(envelope, { source: 'coordinator', authority: 'delegated-not-human-authorization', text: scenario });
          assert(ordinal === 1 || (scenario === 'NORMAL' && ordinal === 2));
          stream.push({ type: 'start', partial: message });
          const text = (value: string) => {
            const i = message.content.length; message.content.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex: i, partial: message });
            message.content[i].text = value;
            stream.push({ type: 'text_delta', contentIndex: i, delta: value, partial: message });
            stream.push({ type: 'text_end', contentIndex: i, content: value, partial: message });
          };
          if (ordinal === 1) {
            if (scenario !== 'NORMAL') text('MCP_PENDING');
            const requested = scenario === 'NORMAL' ? calls : [{ id: 'pending1', name: 'mcp', arguments: { tool: 'search_text', args: search('pending') } }];
            for (const call of requested) {
              const i = message.content.length;
              const block = { type: 'toolCall', ...call, arguments: {} }; message.content.push(block);
              stream.push({ type: 'toolcall_start', contentIndex: i, partial: message });
              block.arguments = call.arguments;
              stream.push({ type: 'toolcall_delta', contentIndex: i, delta: JSON.stringify(call.arguments), partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message });
            }
            message.stopReason = 'toolUse';
          } else {
            const results = context.messages.filter((m: any) => m.role === 'toolResult');
            assert.equal(results.length, 7);
            const byId = new Map(results.map((m: any) => [m.toolCallId, m]));
            assert.equal(byId.size, 7);
            for (const [i, call] of calls.entries()) {
              const result: any = byId.get(call.id);
              assert(result && result.toolName === call.name);
              assert.equal(result.isError, i >= 3);
              if (i < 3) assert.deepEqual(result.content, [{ type: 'text', text: ['GATEWAY_OK', 'ALIAS_OK', 'NAMED_OK'][i] }]);
            }
            verified = true; save(); text('MCP_GATE_OK'); message.stopReason = 'stop';
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        } catch {
          error = 'fixture_contract_failed'; save(); message.stopReason = 'error'; message.errorMessage = error;
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        }
      });
      return stream;
    },
  });
}
