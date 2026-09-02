import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { currentBranch, UserError } from './git.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Two different questions get asked about a plan file, and they want different
 * answers, so they get different markers. Both live here so they cannot drift.
 *
 * "Has anybody filled the units in?" — SCAFFOLD_SENTINEL.
 *
 * Both `init` and `plan new` write `id: TODO`, so this matches either one while
 * the units are still blank. `plan new` uses it to decide it may overwrite
 * without --force: making someone force-overwrite placeholders would be the
 * first thing they hit after installing, and it would look broken.
 *
 * It also means the scaffold's unit id cannot be made schema-valid. `id: TODO`
 * failing validation is the price of it being recognisable.
 *
 * "Is this the file init left, that nobody has started from?" — the two
 * together, via isInitPlaceholder.
 *
 * Only the init template carries the marker; `plan new` does not reproduce it.
 * That is the whole difference between the two states, which are otherwise
 * identical on disk. `plan check` goes easy on this one and only this one:
 * a plan from `plan new` names a real batch of work and owes an answer about
 * who owns what, so leaving it blank is a genuine problem and exits 2.
 */
export const SCAFFOLD_SENTINEL = 'id: TODO';
export const PLACEHOLDER_MARKER = '# tirithgate:placeholder';

export function isUntouchedScaffold(path) {
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(SCAFFOLD_SENTINEL);
}

/**
 * Both conditions, not just the marker. Somebody who edits the init plan in
 * place instead of running `plan new` has written a real plan, and should be
 * judged on it even though the comment is still sitting at the top of the file.
 */
export function isInitPlaceholder(path) {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  return text.includes(PLACEHOLDER_MARKER) && text.includes(SCAFFOLD_SENTINEL);
}

export function planningDocPath() {
  return join(HERE, '..', 'templates', '.tirithgate', 'PLANNING.md');
}

export function readPlanningDoc() {
  return readFileSync(planningDocPath(), 'utf8');
}

/**
 * Write a fresh plan with the run details already correct.
 *
 * The point of this is to shrink what the agent has to get right. Working out
 * a commit sha and formatting a timestamp are things a machine should do, and
 * an agent that fumbles either of them gets a schema error instead of getting
 * on with the actual job.
 */
export function newPlan({ root, intent, base, force }) {
  const branch = base ?? currentBranch(root) ?? 'main';

  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', branch], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new UserError(
      `Could not find the branch '${branch}'.\n` +
        `Pass --base <branch> with a branch that exists.`
    );
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const slug = slugify(intent ?? 'run');
  const dir = join(root, '.tirithgate');
  const path = join(dir, 'plan.yaml');

  if (existsSync(path) && !force) {
    // A plan straight out of `init` that nobody has filled in is not real work.
    // Making someone pass --force to replace placeholders would be the first
    // thing they hit after installing, and it would look broken.
    if (!isUntouchedScaffold(path)) {
      throw new UserError(
        `${path} already exists.\n` +
          `If the last batch of work is finished, pass --force to start a new plan.\n` +
          `If it is not finished, edit the existing one instead.`
      );
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderPlan({ id: `${day}-${slug}`, branch, sha, now, intent }));
  return path;
}

function slugify(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-');
  return s || 'run';
}

function renderPlan({ id, branch, sha, now, intent }) {
  return `# Who is allowed to touch what, for THIS batch of work.
#
# Short-lived on purpose. Cut a fresh one each time you run agents in parallel.
# Fill in frozen, contract and units, then run: tirithgate plan check
#
# Full instructions: .tirithgate/PLANNING.md

version: 1

run:
  id: "${id}"
  base: ${branch}
  base_sha: "${sha}"
  created: "${now.toISOString()}"
  intent: ${intent ? JSON.stringify(intent) : '"TODO: what this batch of work is for"'}

# Files nobody may touch while this runs. Shared types belong here: if two units
# can both edit them, they will disagree and you find out at merge.
frozen: []

# Names everyone agrees on, so nobody invents a second version of the same idea.
contract: []

# The split. One entry per parallel worker.
# Two units must never own the same path.
units:
  - id: TODO
    intent: TODO
    owns:
      - "src/**"
`;
}

/**
 * Point the repo's AGENTS.md at the planning doc, so agents find it on their own.
 * AGENTS.md is the file most coding agents already read before doing anything.
 */
export function installPointer(root) {
  const path = join(root, 'AGENTS.md');
  const block = `
## Running several agents at once

Before splitting work between parallel agents, sub-agents, or worktrees, read
\`.tirithgate/PLANNING.md\` and write a plan. Then run \`tirithgate plan check\`
and fix whatever it reports before starting any workers.
`;

  if (!existsSync(path)) {
    writeFileSync(path, `# Notes for coding agents\n${block}`);
    return { path, created: true };
  }

  const existing = readFileSync(path, 'utf8');
  if (existing.includes('.tirithgate/PLANNING.md')) {
    return { path, created: false, alreadyThere: true };
  }

  writeFileSync(path, existing.trimEnd() + '\n' + block);
  return { path, created: false };
}
