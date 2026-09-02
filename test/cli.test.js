import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// These tests run the real binary against a real git repository.
//
// Everything else in this suite calls the checking functions directly, which
// says nothing about the thing CI actually depends on: the exit code. A tool
// that returns 1 when it meant 3 blocks every merge on a crash, and a tool that
// returns 0 when it meant 1 waves violations through. Both are silent.
//
// So: spawn the CLI, look at the number it exits with.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.js');

const OK = 0;
const VIOLATIONS = 1;
const BAD_PLAN = 2;
const TOOL_ERROR = 3;

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function agentgate(repo, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    // Otherwise a run inside CI appends Actions annotations to stdout and the
    // output assertions below start matching things they did not mean to.
    env: { ...process.env, GITHUB_ACTIONS: 'false', AGENTGATE_PR_BODY: '' },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

function write(repo, relPath, contents) {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

function emptyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentgate-'));
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test Person');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

const SOUND_PLAN = (sha) => `version: 1
run:
  id: "2026-09-02-test"
  base: main
  base_sha: "${sha}"
  created: "2026-09-02T00:00:00.000Z"
  intent: "a test run"
frozen:
  - path: src/types.ts
    reason: Shared types. Every unit builds against these.
contract: []
units:
  - id: auth
    intent: One auth guard.
    owns:
      - "src/auth/**"
  - id: billing
    intent: Invoice endpoints.
    owns:
      - "src/billing/**"
`;

/**
 * A repo with a small source tree and a plan that already passes `plan check`.
 * Committed in two steps so the plan's base_sha is a real ancestor, which is
 * what AG007 looks for.
 */
function seededRepo(planYaml = SOUND_PLAN) {
  const repo = emptyRepo();
  write(repo, 'src/auth/session.ts', 'export const session = 1;\n');
  write(repo, 'src/billing/api.ts', 'export const api = 1;\n');
  write(repo, 'src/shared/format.ts', 'export const format = 1;\n');
  write(repo, 'src/types.ts', 'export type User = { id: string };\n');
  commitAll(repo, 'seed');

  const sha = git(repo, 'rev-parse', 'HEAD');
  write(repo, '.agentgate/plan.yaml', typeof planYaml === 'function' ? planYaml(sha) : planYaml);
  commitAll(repo, 'add plan');
  return repo;
}

function withRepo(make, fn) {
  const repo = make();
  try {
    return fn(repo);
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A leftover temp dir is not worth failing a passing test over.
    }
  }
}

// ---------------------------------------------------------------------------
// Exit 0 — nothing to complain about.
// ---------------------------------------------------------------------------

test('a sound plan exits 0', () => {
  withRepo(seededRepo, (repo) => {
    const r = agentgate(repo, 'plan', 'check');
    assert.equal(r.code, OK, r.all);
    assert.match(r.out, /all clear/);
  });
});

test('a unit that stayed in its own lane exits 0', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'tighten the guard');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
    assert.equal(r.code, OK, r.all);
    assert.match(r.out, /all clear/);
  });
});

test('a warning alone does not fail the build', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    // Nobody owns src/shared/. The default config calls that a warning, on the
    // grounds that a fresh install on an existing repo would otherwise be a
    // wall of errors.
    write(repo, 'src/shared/format.ts', 'export const format = 2;\n');
    commitAll(repo, 'touch an unowned file');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
    assert.equal(r.code, OK, r.all);
    assert.match(r.out, /AG006/);
    assert.match(r.out, /1 warning/);
  });
});

test('prompt prints the planning doc and exits 0', () => {
  withRepo(seededRepo, (repo) => {
    const r = agentgate(repo, 'prompt');
    assert.equal(r.code, OK, r.all);
    assert.match(r.out, /Before you split work between agents/);
  });
});

// ---------------------------------------------------------------------------
// Exit 1 — the rules said no.
// ---------------------------------------------------------------------------

test('writing in another unit files exits 1 with AG001', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/billing/api.ts', 'export const api = 2;\n');
    commitAll(repo, 'reach into billing');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
    assert.equal(r.code, VIOLATIONS, r.all);
    assert.match(r.out, /AG001/);
    assert.match(r.out, /src\/billing\/api\.ts/);
  });
});

test('changing a frozen file exits 1 with AG002', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/types.ts', 'export type User = { id: number };\n');
    commitAll(repo, 'change the shared type');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
    assert.equal(r.code, VIOLATIONS, r.all);
    assert.match(r.out, /AG002/);
    // The reason from the plan should be in the message, not just the code.
    assert.match(r.out, /Every unit builds against these/);
  });
});

test('an unclaimed file exits 1 once the config says error', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, '.agentgate/config.yaml', 'version: 1\nunattributed: error\n');
    write(repo, 'src/shared/format.ts', 'export const format = 2;\n');
    commitAll(repo, 'touch an unowned file');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
    assert.equal(r.code, VIOLATIONS, r.all);
    assert.match(r.out, /AG006/);
  });
});

// ---------------------------------------------------------------------------
// Exit 2 — the plan itself is broken, so there is nothing to check against.
// ---------------------------------------------------------------------------

test('two units claiming the same ground exits 2 with PL002', () => {
  const overlapping = (sha) => `version: 1
run:
  id: "2026-09-02-test"
  base: main
  base_sha: "${sha}"
  created: "2026-09-02T00:00:00.000Z"
  intent: "a test run"
frozen: []
contract: []
units:
  - id: auth
    intent: One auth guard.
    owns: ["src/**"]
  - id: billing
    intent: Invoice endpoints.
    owns: ["src/billing/**"]
`;
  withRepo(
    () => seededRepo(overlapping),
    (repo) => {
      const r = agentgate(repo, 'plan', 'check');
      assert.equal(r.code, BAD_PLAN, r.all);
      assert.match(r.out, /PL002/);
    }
  );
});

test('a missing plan exits 2', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');

    const r = agentgate(repo, 'plan', 'check');
    assert.equal(r.code, BAD_PLAN, r.all);
    assert.match(r.err, /No plan file found/);
  });
});

test('a plan that is not valid YAML exits 2', () => {
  withRepo(
    () => seededRepo('version: 1\nrun: [this is: not\n  valid yaml at all\n'),
    (repo) => {
      const r = agentgate(repo, 'plan', 'check');
      assert.equal(r.code, BAD_PLAN, r.all);
      assert.match(r.err, /isn't valid/);
    }
  );
});

test('a plan that misses the schema exits 2 and names the field', () => {
  withRepo(
    () =>
      seededRepo(`version: 1
run:
  id: "2026-09-02-test"
  base: main
  base_sha: "not-a-real-sha"
  created: "2026-09-02T00:00:00.000Z"
  intent: "a test run"
units:
  - id: auth
    intent: One auth guard.
    owns: ["src/auth/**"]
`),
    (repo) => {
      const r = agentgate(repo, 'plan', 'check');
      assert.equal(r.code, BAD_PLAN, r.all);
      assert.match(r.err, /base_sha/);
    }
  );
});

test('check stops at the plan and exits 2 rather than reporting on the diff', () => {
  const overlapping = (sha) => `version: 1
run:
  id: "2026-09-02-test"
  base: main
  base_sha: "${sha}"
  created: "2026-09-02T00:00:00.000Z"
  intent: "a test run"
frozen: []
contract: []
units:
  - id: auth
    intent: One auth guard.
    owns: ["src/**"]
  - id: billing
    intent: Invoice endpoints.
    owns: ["src/billing/**"]
`;
  withRepo(
    () => seededRepo(overlapping),
    (repo) => {
      git(repo, 'checkout', '-b', 'agent/auth/guard');
      write(repo, 'src/billing/api.ts', 'export const api = 2;\n');
      commitAll(repo, 'reach into billing');

      const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth');
      assert.equal(r.code, BAD_PLAN, r.all);
      assert.match(r.all, /PL002/);
      // A broken plan means the diff was never judged, so no AG codes.
      assert.doesNotMatch(r.all, /AG001/);
    }
  );
});

// ---------------------------------------------------------------------------
// Exit 3 — the tool could not run. Kept apart from 1 on purpose.
// ---------------------------------------------------------------------------

test('no way to attribute the change exits 3 and lists the unit ids', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'feature/nothing-to-go-on');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'a commit with no trailer');

    const r = agentgate(repo, 'check', '--base', 'main');
    assert.equal(r.code, TOOL_ERROR, r.all);
    assert.match(r.err, /Could not work out which unit/);
    assert.match(r.err, /auth, billing/);
  });
});

test('a --unit that is not in the plan exits 3', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'work');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'shipping');
    assert.equal(r.code, TOOL_ERROR, r.all);
    assert.match(r.err, /not in the plan/);
  });
});

test('running outside a git repository exits 3', () => {
  withRepo(
    () => mkdtempSync(join(tmpdir(), 'agentgate-nogit-')),
    (dir) => {
      // The temp dir can itself sit inside a repository — a home directory that
      // someone ran 'git init' in once will swallow it, and then git finds a
      // toplevel and this test asserts nothing. Stop the upward walk at the
      // temp root so the assertion means what it says.
      const ceiling = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = tmpdir();
      try {
        const r = agentgate(dir, 'check');
        assert.equal(r.code, TOOL_ERROR, r.all);
        assert.match(r.err, /Not inside a git repository/);
      } finally {
        if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = ceiling;
      }
    }
  );
});

test('an unknown command exits 3', () => {
  withRepo(seededRepo, (repo) => {
    const r = agentgate(repo, 'frobnicate');
    assert.equal(r.code, TOOL_ERROR, r.all);
    assert.match(r.err, /Unknown command/);
  });
});

// ---------------------------------------------------------------------------
// Attribution, end to end. None of this is reachable without a real repo.
// ---------------------------------------------------------------------------

test('a branch named agent/<id>/... attributes the change', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'work with no trailer');

    const r = agentgate(repo, 'check', '--base', 'main', '--format', 'json');
    assert.equal(r.code, OK, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.unit, 'auth');
    assert.match(result.attributed_by, /branch/);
  });
});

test('an Agent-Unit trailer attributes the change', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'feature/no-hint-in-the-name');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'tighten the guard\n\nAgent-Unit: auth\n');

    const r = agentgate(repo, 'check', '--base', 'main', '--format', 'json');
    assert.equal(r.code, OK, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.unit, 'auth');
    assert.match(result.attributed_by, /trailer/);
  });
});

test('the --unit flag wins over the branch name', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/billing/invoices');
    write(repo, 'src/billing/api.ts', 'export const api = 2;\n');
    commitAll(repo, 'work');

    // The branch says billing and the file belongs to billing, so if the branch
    // won this would pass. The flag says auth, so it must not.
    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth', '--format', 'json');
    assert.equal(r.code, VIOLATIONS, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.unit, 'auth');
    assert.equal(result.attributed_by, '--unit flag');
    assert.equal(result.violations[0].code, 'AG001');
  });
});

test('--all skips attribution and still catches a frozen file', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'feature/several-units-merged');
    write(repo, 'src/types.ts', 'export type User = { id: number };\n');
    commitAll(repo, 'change the shared type');

    const r = agentgate(repo, 'check', '--base', 'main', '--all', '--format', 'json');
    assert.equal(r.code, VIOLATIONS, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.unit, null);
    assert.equal(result.violations[0].code, 'AG002');
  });
});

// ---------------------------------------------------------------------------
// Machine-readable output.
// ---------------------------------------------------------------------------

test('--format json gives a parseable report of a violation', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'agent/auth/guard');
    write(repo, 'src/billing/api.ts', 'export const api = 2;\n');
    commitAll(repo, 'reach into billing');

    const r = agentgate(repo, 'check', '--base', 'main', '--unit', 'auth', '--format', 'json');
    assert.equal(r.code, VIOLATIONS, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.stage, 'check');
    assert.equal(result.clean, false);
    assert.equal(result.files_changed, 1);
    assert.equal(result.violations[0].code, 'AG001');
    assert.equal(result.violations[0].path, 'src/billing/api.ts');
  });
});

test('--format json still says something when attribution fails', () => {
  withRepo(seededRepo, (repo) => {
    git(repo, 'checkout', '-b', 'feature/nothing-to-go-on');
    write(repo, 'src/auth/session.ts', 'export const session = 2;\n');
    commitAll(repo, 'a commit with no trailer');

    const r = agentgate(repo, 'check', '--base', 'main', '--format', 'json');
    // Still 3: no rule ran, so this is not "the rules said no".
    assert.equal(r.code, TOOL_ERROR, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.error, 'unattributed');
    assert.equal(result.clean, false);
    assert.deepEqual(result.unit_ids, ['auth', 'billing']);
    assert.deepEqual(result.violations, []);
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init writes the whole scaffold and exits 0', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');

    const r = agentgate(repo, 'init');
    assert.equal(r.code, OK, r.all);
    for (const f of [
      '.agentgate/plan.yaml',
      '.agentgate/config.yaml',
      '.agentgate/overrides.yaml',
      '.agentgate/PLANNING.md',
      '.github/workflows/agents-gate.yml',
      'docs/adr/0000-template.md',
    ]) {
      assert.ok(existsSync(join(repo, f)), `init should have written ${f}`);
    }
  });
});

test('init refuses to overwrite without --force', () => {
  withRepo(seededRepo, (repo) => {
    const r = agentgate(repo, 'init');
    assert.equal(r.code, TOOL_ERROR, r.all);
    assert.match(r.err, /already exists/);
  });
});

// The scaffold ships `id: TODO`, which cannot pass the schema — unit ids must
// be lowercase. That is deliberate and cannot be "fixed" by giving the scaffold
// a valid id, because the literal string `id: TODO` is the sentinel that lets
// `plan new` replace an untouched scaffold without --force. Make the id valid
// and that sentinel stops matching, so `plan new` would start demanding --force
// on a file the user never wrote.
//
// So `plan check` special-cases it instead: say what to run, exit 0. The
// special case is keyed off the marker in the init template AS WELL AS the
// sentinel, so it covers this state and not the one after `plan new` — see the
// two tests further down.
test('plan check on the untouched scaffold points at plan new and exits 0', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');

    const r = agentgate(repo, 'plan', 'check');
    assert.equal(r.code, OK, r.all);
    assert.match(r.out, /placeholder plan/);
    assert.match(r.out, /agentgate plan new/);
    // It must not pretend the plan was actually checked and found good.
    assert.doesNotMatch(r.out, /all clear/);
  });
});

test('the placeholder plan reports as a placeholder in json', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');

    const r = agentgate(repo, 'plan', 'check', '--format', 'json');
    assert.equal(r.code, OK, r.all);
    const result = JSON.parse(r.out);
    assert.equal(result.stage, 'plan');
    assert.equal(result.status, 'placeholder');
    assert.deepEqual(result.violations, []);
    // No `clean` either way: nothing was checked, so both answers would lie.
    assert.equal('clean' in result, false);
  });
});

test('plan new replaces the untouched scaffold without --force', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');

    const r = agentgate(repo, 'plan', 'new', '--intent', 'add billing endpoints');
    assert.equal(r.code, OK, r.all);
  });
});

// The state the two markers exist to tell apart. On disk this file still says
// `id: TODO`, exactly like the scaffold — but somebody has now named a real
// batch of work and not said who owns what, and the planning agent loops on
// this exit code. A 0 here would tell it to go start workers.
test('a plan from plan new with the units still blank exits 2, not 0', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'README.md', 'hi\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');
    agentgate(repo, 'plan', 'new', '--intent', 'add billing endpoints');

    const r = agentgate(repo, 'plan', 'check');
    assert.equal(r.code, BAD_PLAN, r.all);
    // And it should say what to do, not just fail the schema at them — with the
    // useful part above the schema detail, not buried under it.
    assert.match(r.err, /Fill in the units/);
    assert.ok(
      r.err.indexOf('Fill in the units') < r.err.indexOf('units.0.id'),
      `the advice should come before the schema detail:\n${r.err}`
    );
    assert.doesNotMatch(r.all, /placeholder plan that init wrote/);
  });
});

// The marker alone must not be enough. Editing the init plan in place instead
// of running `plan new` is a reasonable thing to do, and leaves the comment
// sitting at the top of a plan that is now real.
test('a filled-in plan is judged for real even with the marker still in it', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'src/auth/session.ts', 'export const session = 1;\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');

    const planPath = join(repo, '.agentgate', 'plan.yaml');
    const edited = readFileSync(planPath, 'utf8').replace(
      /units:[\s\S]*$/,
      `units:
  - id: auth
    intent: One auth guard.
    owns: ["src/**"]
  - id: billing
    intent: Invoices.
    owns: ["src/billing/**"]
`
    );
    writeFileSync(planPath, edited);
    assert.match(edited, /agentgate:placeholder/, 'the marker should still be there');

    const r = agentgate(repo, 'plan', 'check');
    assert.equal(r.code, BAD_PLAN, r.all);
    assert.match(r.out, /PL002/);
  });
});

test('check still refuses to judge a diff against the placeholder', () => {
  withRepo(emptyRepo, (repo) => {
    write(repo, 'src/thing.ts', 'export const a = 1;\n');
    commitAll(repo, 'seed');
    agentgate(repo, 'init');
    commitAll(repo, 'add agentgate');

    git(repo, 'checkout', '-b', 'feature/work');
    write(repo, 'src/thing.ts', 'export const a = 2;\n');
    commitAll(repo, 'work');

    // Stage 2 has a real diff in front of it, and a placeholder cannot judge
    // one. The soft landing is for `plan check` only.
    const r = agentgate(repo, 'check', '--base', 'main', '--all');
    assert.equal(r.code, BAD_PLAN, r.all);
  });
});

// ---------------------------------------------------------------------------

test('the four exit codes stay distinct', () => {
  assert.equal(new Set([OK, VIOLATIONS, BAD_PLAN, TOOL_ERROR]).size, 4);
});
