import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

import { newPlan, installPointer, readPlanningDoc } from '../src/plan.js';
import { PlanSchema } from '../src/schema.js';

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ag-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t.com');
  run('config', 'user.name', 'T');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'x');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

test('plan new fills in a real branch, sha and date', () => {
  const root = scratchRepo();
  const path = newPlan({ root, intent: 'Add billing and harden auth' });
  const plan = parseYaml(readFileSync(path, 'utf8'));

  assert.equal(plan.run.base, 'main');
  assert.match(plan.run.base_sha, /^[0-9a-f]{40}$/);
  assert.equal(plan.run.intent, 'Add billing and harden auth');
  assert.match(plan.run.id, /^\d{4}-\d{2}-\d{2}-/);
});

test('the id it builds is short and slug-shaped', () => {
  const root = scratchRepo();
  const path = newPlan({ root, intent: 'Add Billing Endpoints And Harden The Auth Path!!' });
  const plan = parseYaml(readFileSync(path, 'utf8'));
  assert.match(plan.run.id, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
  assert.equal(plan.run.id.split('-').length <= 7, true);
});

test('everything except the units passes the schema straight away', () => {
  const root = scratchRepo();
  const path = newPlan({ root, intent: 'test' });
  const raw = parseYaml(readFileSync(path, 'utf8'));

  // Placeholders are meant to fail, so swap in a real unit and check that the
  // rest of what plan new wrote is already valid.
  raw.units = [{ id: 'auth', intent: 'x', owns: ['src/**'] }];
  const parsed = PlanSchema.safeParse(raw);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('an untouched plan fails, so nobody starts on placeholders', () => {
  const root = scratchRepo();
  const path = newPlan({ root, intent: 'test' });
  const raw = parseYaml(readFileSync(path, 'utf8'));
  assert.equal(PlanSchema.safeParse(raw).success, false);
});

test('a plan with real work in it is not replaced without --force', () => {
  const root = scratchRepo();
  const path = newPlan({ root, intent: 'first' });

  // Someone filled it in. Now it represents real work in progress.
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('- id: TODO', '- id: auth').replace('intent: TODO', 'intent: real work')
  );

  assert.throws(() => newPlan({ root, intent: 'second' }), /already exists/);
  assert.doesNotThrow(() => newPlan({ root, intent: 'second', force: true }));
});

test('an untouched scaffold plan is replaced without complaining', () => {
  const root = scratchRepo();
  newPlan({ root, intent: 'first' });

  // Nobody filled it in, so there is nothing to protect. Making a new user pass
  // --force right after init would look like the tool is broken.
  assert.doesNotThrow(() => newPlan({ root, intent: 'second' }));
  const plan = parseYaml(readFileSync(join(root, '.tirithgate', 'plan.yaml'), 'utf8'));
  assert.equal(plan.run.intent, 'second');
});

test('plan new says so when the branch does not exist', () => {
  const root = scratchRepo();
  assert.throws(() => newPlan({ root, intent: 'x', base: 'nope' }), /Could not find the branch/);
});

test('the pointer creates AGENTS.md when there is none', () => {
  const root = scratchRepo();
  const result = installPointer(root);
  assert.equal(result.created, true);
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /\.tirithgate\/PLANNING\.md/);
});

test('the pointer appends to an existing AGENTS.md without eating it', () => {
  const root = scratchRepo();
  writeFileSync(join(root, 'AGENTS.md'), '# Existing\n\nRun `npm test` before pushing.\n');
  installPointer(root);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /Run `npm test` before pushing/);
  assert.match(text, /\.tirithgate\/PLANNING\.md/);
});

test('running the pointer twice does not duplicate the section', () => {
  const root = scratchRepo();
  installPointer(root);
  const second = installPointer(root);
  assert.equal(second.alreadyThere, true);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(text.split('PLANNING.md').length - 1, 1);
});

test('the planning doc exists and covers the rules that matter', () => {
  const doc = readPlanningDoc();
  assert.match(doc, /tirithgate plan new/);
  assert.match(doc, /tirithgate plan check/);
  assert.match(doc, /No two units may own the same path/);
  assert.match(doc, /Freeze anything shared/);
  // It has to stay short. Agents read this before doing anything, and every
  // line costs tokens that would otherwise go to the actual code.
  assert.equal(doc.split('\n').length < 130, true, 'planning doc is getting too long');
});
