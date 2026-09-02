import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export class GitError extends Error {}

/** A problem the person can fix. Printed plainly, no stack trace. */
export class UserError extends Error {}

export function repoRoot(cwd = process.cwd()) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    throw new GitError('Not inside a git repository.');
  }
}

/**
 * The commit where this branch split off from the base branch.
 *
 * Everything downstream depends on getting this right. Comparing straight
 * against the tip of main would flag every file that changed on main since you
 * branched, even though this branch never touched them.
 */
export function mergeBase(base, head, cwd) {
  try {
    return git(['merge-base', base, head], cwd);
  } catch {
    throw new GitError(
      `Could not find where '${base}' and '${head}' split apart.\n` +
        `If this is running in CI, the checkout is probably shallow.\n` +
        `Fix: set 'fetch-depth: 0' on actions/checkout.`
    );
  }
}

export function isAncestor(maybeAncestor, descendant, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', maybeAncestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Files touched between the split point and now.
 *
 * A rename shows up as two paths, old and new. That is deliberate: moving a
 * file out of your area is a write to two areas, and both should be checked.
 */
export function changedFiles(from, to, cwd) {
  const raw = git(['diff', '--name-status', '--find-renames', from, to], cwd);
  if (!raw) return [];

  const files = [];
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    const status = parts[0];

    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ path: parts[1], status: 'renamed-from' });
      files.push({ path: parts[2], status: 'renamed-to' });
    } else {
      files.push({ path: parts[1], status: statusName(status) });
    }
  }
  return files;
}

function statusName(code) {
  return { A: 'added', M: 'modified', D: 'deleted', T: 'typechange' }[code[0]] ?? 'changed';
}

export function currentBranch(cwd) {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch {
    return null;
  }
}

export function headMessage(cwd) {
  try {
    return git(['log', '-1', '--pretty=%B'], cwd);
  } catch {
    return '';
  }
}

/**
 * Work out which unit this diff belongs to.
 *
 * Order: the flag you passed, then a line in the commit message, then the
 * branch name. If none of those work we stop rather than guess, because
 * guessing wrong means blaming the wrong unit.
 */
export function attributeUnit({ flag, cwd, unitIds }) {
  if (flag) {
    if (!unitIds.includes(flag)) {
      throw new GitError(
        `--unit '${flag}' is not in the plan. Units in this plan: ${unitIds.join(', ')}`
      );
    }
    return { unitId: flag, source: '--unit flag' };
  }

  const trailer = headMessage(cwd).match(/^Agent-Unit:\s*(\S+)\s*$/m);
  if (trailer && unitIds.includes(trailer[1])) {
    return { unitId: trailer[1], source: 'Agent-Unit commit trailer' };
  }

  const branch = currentBranch(cwd);
  if (branch) {
    const fromBranch = branch.match(/^agent\/([^/]+)\//);
    if (fromBranch && unitIds.includes(fromBranch[1])) {
      return { unitId: fromBranch[1], source: `branch name '${branch}'` };
    }
  }

  return null;
}
