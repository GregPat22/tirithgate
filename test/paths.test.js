import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, specificity, compare, buildOwnership, resolveOwner, patternsOverlap } from '../src/paths.js';

test('star does not cross a slash, double star does', () => {
  assert.equal(matches('src/*', 'src/a.ts'), true);
  assert.equal(matches('src/*', 'src/auth/a.ts'), false);
  assert.equal(matches('src/**', 'src/auth/a.ts'), true);
  assert.equal(matches('src/**', 'src/auth/deep/a.ts'), true);
});

test('exact paths match only themselves', () => {
  assert.equal(matches('src/types.ts', 'src/types.ts'), true);
  assert.equal(matches('src/types.ts', 'src/types.tsx'), false);
});

test('dotfiles are matched', () => {
  assert.equal(matches('**/.env', '.env'), true);
  assert.equal(matches('config/**', 'config/.hidden'), true);
});

test('more literal text before the wildcard means more specific', () => {
  const a = specificity('src/auth/**');
  const b = specificity('src/**');
  assert.equal(compare(a, b) < 0, true, 'src/auth/** should sort ahead of src/**');
});

test('an exact path beats any wildcard', () => {
  const exact = specificity('src/auth/session.ts');
  const glob = specificity('src/auth/**');
  assert.equal(compare(exact, glob) < 0, true);
});

test('the order patterns are written in does not change who owns a file', () => {
  const planA = {
    units: [
      { id: 'wide', owns: ['src/**'] },
      { id: 'narrow', owns: ['src/auth/**'] },
    ],
  };
  const planB = {
    units: [
      { id: 'narrow', owns: ['src/auth/**'] },
      { id: 'wide', owns: ['src/**'] },
    ],
  };
  const a = resolveOwner(buildOwnership(planA), 'src/auth/session.ts');
  const b = resolveOwner(buildOwnership(planB), 'src/auth/session.ts');
  assert.equal(a.unitId, 'narrow');
  assert.equal(b.unitId, 'narrow');
});

test('a file nobody claims comes back as nobody', () => {
  const claims = buildOwnership({ units: [{ id: 'a', owns: ['src/auth/**'] }] });
  assert.equal(resolveOwner(claims, 'README.md'), null);
});

test('overlapping claims are spotted', () => {
  assert.equal(patternsOverlap('src/**', 'src/auth/**'), true);
  assert.equal(patternsOverlap('src/auth/**', 'src/billing/**'), false);
  assert.equal(patternsOverlap('src/types.ts', 'src/**'), true);
  assert.equal(patternsOverlap('src/**', 'src/**'), true);
  assert.equal(patternsOverlap('docs/**', 'src/**'), false);
});
