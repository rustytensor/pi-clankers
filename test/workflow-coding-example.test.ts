import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTrustedCodingWorkflowExample } from '../workflow-coding-example.js';
import { validateWorkflowDefinition } from '../workflow-model.js';
import { validateCodingPolicy } from '../workflow-coding.js';

test('public trusted coding example constructs a valid v3 definition and host coding config', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clankers-example-root-'));
  const stagingParent = mkdtempSync(join(tmpdir(), 'clankers-example-stage-'));
  const example = buildTrustedCodingWorkflowExample({ projectRoot, stagingParent, model: 'fake/model' });
  mkdirSync(join(projectRoot, 'src'));
  for (const [path, text] of Object.entries(example.initialFiles)) writeFileSync(join(projectRoot, path), text);

  const definition = validateWorkflowDefinition(example.definition);
  assert.equal(definition.version, 3);
  assert.equal(definition.steps[0]?.coding?.operation, 'investigate');
  assert.equal(definition.steps[1]?.kind, 'repeat');
  assert.equal(definition.steps[2]?.coding?.operation, 'apply');

  const stage = definition.steps[1]!.body!.find((step) => step.id === 'stage')!;
  const check = definition.steps[1]!.body!.find((step) => step.id === 'check')!;
  const review = definition.steps[1]!.body!.find((step) => step.id === 'review')!;
  assert.equal(stage.coding?.operation, 'stage-write');
  assert.equal(check.coding?.checkProfileId, 'python-message-check');
  assert.equal(review.coding?.operation, 'review');

  const policy = validateCodingPolicy(stage.coding!.policy as never);
  assert.deepEqual(policy.capabilities, ['investigate', 'stage-write', 'check', 'review', 'apply']);
  assert.equal(policy.scope.manifest[0]?.path, 'src/message.txt');
  assert.equal(policy.scope.dependencies?.[0]?.path, 'package.json');
  assert.equal(example.coding.enabled, true);
  assert.equal(example.coding.projectRoot, projectRoot);
  assert.equal(example.coding.stagingParent, stagingParent);
  assert.deepEqual(Object.keys(example.coding.checkProfiles ?? {}), ['python-message-check']);
});
