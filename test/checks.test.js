import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, checkDiff, parsePrOverrides } from '../src/checks.js';
import { DEFAULT_CONFIG } from '../src/schema.js';

const basePlan = () => ({
  version: 1,
  run: {
    id: 'test',
    base: 'main',
    base_sha: 'a'.repeat(40),
    created: '2026-01-01T00:00:00Z',
    intent: 'test',
  },
  frozen: [{ path: 'src/types.ts', reason: 'shared' }],
  contract: [{ symbol: 'requireUser', module: 'src/auth/session.ts' }],
  units: [
    { id: 'auth', intent: 'a', owns: ['src/auth/**'], provides: ['requireUser'], may_call: [], impact: [] },
    { id: 'billing', intent: 'b', owns: ['src/billing/**'], provides: [], may_call: ['requireUser'], impact: [] },
  ],
});

const config = { ...DEFAULT_CONFIG, unattributed: 'error' };

function codes(list) {
  return list.map((v) => v.code).sort();
}

test('a sensible plan passes', () => {
  assert.deepEqual(checkPlan(basePlan()), []);
});

test('two units claiming the same ground is caught before anyone runs', () => {
  const plan = basePlan();
  plan.units[1].owns.push('src/**');
  assert.equal(codes(checkPlan(plan)).includes('PL002'), true);
});

test('a unit cannot claim a frozen file', () => {
  const plan = basePlan();
  plan.units[0].owns = ['src/**'];
  plan.units[1].owns = ['docs/**'];
  assert.equal(codes(checkPlan(plan)).includes('PL003'), true);
});

test('two units cannot both provide the same name', () => {
  const plan = basePlan();
  plan.units[1].provides = ['requireUser'];
  assert.equal(codes(checkPlan(plan)).includes('PL004'), true);
});

test('calling something nothing defines is caught', () => {
  const plan = basePlan();
  plan.units[1].may_call = ['doesNotExist'];
  assert.equal(codes(checkPlan(plan)).includes('PL005'), true);
});

test('a shared symbol in an unowned, unfrozen file is caught', () => {
  const plan = basePlan();
  plan.contract = [{ symbol: 'fmt', module: 'src/shared/format.ts' }];
  assert.equal(codes(checkPlan(plan)).includes('PL006'), true);
});

const diffArgs = (over = {}) => ({
  plan: basePlan(),
  config,
  files: [],
  attributedUnit: 'auth',
  mergeBaseSha: null,
  cwd: '/tmp',
  overrides: [],
  ...over,
});

test('staying in your own lane passes', () => {
  const v = checkDiff(diffArgs({ files: [{ path: 'src/auth/session.ts', status: 'modified' }] }));
  assert.deepEqual(v, []);
});

test('writing another unit file is AG001', () => {
  const v = checkDiff(diffArgs({ files: [{ path: 'src/billing/api.ts', status: 'modified' }] }));
  assert.deepEqual(codes(v), ['AG001']);
});

test('touching a frozen file is AG002', () => {
  const v = checkDiff(diffArgs({ files: [{ path: 'src/types.ts', status: 'modified' }] }));
  assert.deepEqual(codes(v), ['AG002']);
});

test('a file nobody claims is AG006', () => {
  const v = checkDiff(diffArgs({ files: [{ path: 'README.md', status: 'modified' }] }));
  assert.deepEqual(codes(v), ['AG006']);
});

test('unattributed set to ignore turns AG006 off', () => {
  const v = checkDiff(
    diffArgs({
      config: { ...config, unattributed: 'ignore' },
      files: [{ path: 'README.md', status: 'modified' }],
    })
  );
  assert.deepEqual(v, []);
});

test('a promised decision note that never showed up is AG005', () => {
  const plan = basePlan();
  plan.units[0].impact = [
    { feature: 'structured-json-output', adds: [], new_failure_modes: [], adr_required: true },
  ];
  const v = checkDiff(diffArgs({ plan, files: [{ path: 'src/auth/session.ts', status: 'modified' }] }));
  assert.deepEqual(codes(v), ['AG005']);
});

test('writing the decision note clears AG005', () => {
  const plan = basePlan();
  plan.units[0].impact = [
    { feature: 'structured-json-output', adds: [], new_failure_modes: [], adr_required: true },
  ];
  const v = checkDiff(
    diffArgs({
      plan,
      files: [
        { path: 'src/auth/session.ts', status: 'modified' },
        { path: 'docs/adr/0012-json.md', status: 'added' },
      ],
    })
  );
  assert.deepEqual(v, []);
});

test('a live exception suppresses the problem', () => {
  const v = checkDiff(
    diffArgs({
      files: [{ path: 'src/billing/api.ts', status: 'modified' }],
      overrides: [
        { code: 'AG001', path: 'src/billing/api.ts', reason: 'agreed', expires: '2999-01-01' },
      ],
    })
  );
  assert.deepEqual(v, []);
});

test('an expired exception does not suppress, and is itself a problem', () => {
  const v = checkDiff(
    diffArgs({
      files: [{ path: 'src/billing/api.ts', status: 'modified' }],
      overrides: [
        { code: 'AG001', path: 'src/billing/api.ts', reason: 'agreed', expires: '2020-01-01' },
      ],
    })
  );
  assert.deepEqual(codes(v), ['AG001', 'AG010']);
});

test('exceptions can be written in the pull request description', () => {
  const parsed = parsePrOverrides('some text\nAGENTGATE-OVERRIDE: AG001 src/billing/api.ts\nmore');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].code, 'AG001');
  assert.equal(parsed[0].path, 'src/billing/api.ts');
});
