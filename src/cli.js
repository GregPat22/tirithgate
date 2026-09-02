#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { execFileSync } from 'node:child_process';

import { PlanSchema, ConfigSchema, OverridesSchema, DEFAULT_CONFIG, formatIssues } from './schema.js';
import { checkPlan, checkDiff, parsePrOverrides } from './checks.js';
import { repoRoot, mergeBase, changedFiles, attributeUnit, currentBranch, GitError, UserError } from './git.js';
import { renderText, renderJson, renderSarif, renderAnnotations } from './output.js';
import { newPlan, readPlanningDoc, installPointer, isInitPlaceholder } from './plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Exit codes. Keeping "the rules said no" apart from "the tool broke" matters:
// if they are the same number, a crashed tool silently blocks every merge and
// someone deletes it that afternoon.
const OK = 0;
const VIOLATIONS = 1;
const BAD_PLAN = 2;
const TOOL_ERROR = 3;

function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (!command || flags.help || command === 'help') return usage();
  if (flags.version || command === '--version') {
    console.log(readJson(join(HERE, '..', 'package.json')).version);
    return OK;
  }

  try {
    if (command === 'init') return cmdInit(flags);
    if (command === 'prompt') return cmdPrompt(flags);
    if (command === 'plan') return cmdPlan(flags, rest);
    if (command === 'check') return cmdCheck(flags);
    console.error(`Unknown command '${command}'. Try: agentgate help`);
    return TOOL_ERROR;
  } catch (err) {
    if (err instanceof GitError || err instanceof UserError) {
      console.error(err.message);
      return TOOL_ERROR;
    }
    console.error(`agents-gate hit an unexpected problem:\n${err.stack ?? err.message}`);
    return TOOL_ERROR;
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

function cmdPrompt(flags) {
  const root = flags.cwd ?? process.cwd();

  if (flags.install) {
    const result = installPointer(root);
    if (result.alreadyThere) {
      console.log(`AGENTS.md already points at .agentgate/PLANNING.md. Nothing to do.`);
    } else if (result.created) {
      console.log(`Created AGENTS.md pointing at .agentgate/PLANNING.md.

Most coding agents read AGENTS.md before they start, so they will now find the
planning instructions on their own.`);
    } else {
      console.log(`Added a section to AGENTS.md pointing at .agentgate/PLANNING.md.

Most coding agents read AGENTS.md before they start, so they will now find the
planning instructions on their own.`);
    }
    return OK;
  }

  // Straight to stdout, so it can be piped or pasted into a chat.
  process.stdout.write(readPlanningDoc());
  return OK;
}

// ---------------------------------------------------------------------------

function cmdInit(flags) {
  const root = flags.cwd ?? process.cwd();
  const target = join(root, '.agentgate');

  if (existsSync(target) && !flags.force) {
    console.error(`.agentgate already exists. Pass --force to overwrite it.`);
    return TOOL_ERROR;
  }

  cpSync(join(HERE, '..', 'templates', '.agentgate'), target, { recursive: true });

  // Fill the plan in with real values, so what init writes actually passes.
  // A scaffold that fails the moment you run it is how tools get abandoned.
  const branch = currentBranch(root) ?? 'main';
  let sha = '0'.repeat(40);
  try {
    sha = execFileSync('git', ['rev-parse', branch], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    /* not a git repo yet, leave the placeholder */
  }
  const planFile = join(target, 'plan.yaml');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    planFile,
    readFileSync(planFile, 'utf8')
      .replaceAll('__RUN_ID__', `${today}-example`)
      .replaceAll('__BASE_BRANCH__', branch)
      .replaceAll('__BASE_SHA__', sha)
      .replaceAll('__CREATED__', new Date().toISOString())
  );

  const workflowDir = join(root, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  cpSync(
    join(HERE, '..', 'templates', '.github', 'workflows', 'agents-gate.yml'),
    join(workflowDir, 'agents-gate.yml')
  );

  const adrDir = join(root, 'docs', 'adr');
  mkdirSync(adrDir, { recursive: true });
  cpSync(join(HERE, '..', 'templates', 'docs', 'adr', '0000-template.md'), join(adrDir, '0000-template.md'));

  console.log(`Set up agents-gate:

  .agentgate/plan.yaml          who is allowed to touch what, this run
  .agentgate/config.yaml        settings that rarely change
  .agentgate/overrides.yaml     exceptions, each with an expiry date
  .agentgate/PLANNING.md        instructions your planning agent reads
  .github/workflows/            runs the check on every pull request
  docs/adr/0000-template.md     template for decision notes

The plan in there is a placeholder, not a real one.

When you are about to run agents in parallel, start a real plan:

  npx agentgate plan new --intent "what this batch of work is for"

That fills in the branch, commit and date, and replaces the placeholder
without asking. Then fill in frozen, contract and units, and run:

  npx agentgate plan check

Next, so your agents find the planning instructions on their own:

  npx agentgate prompt --install`);
  return OK;
}

// ---------------------------------------------------------------------------

function cmdPlan(flags, rest) {
  const sub = rest[0];
  const root = flags.cwd ?? process.cwd();

  if (sub === 'new') {
    const path = newPlan({
      root,
      intent: typeof flags.intent === 'string' ? flags.intent : null,
      base: typeof flags.base === 'string' ? flags.base : null,
      force: !!flags.force,
    });
    console.log(`Wrote ${rel(root, path)} with the run details filled in.

Now fill in three things:

  frozen:     shared files nobody may touch while this runs
  contract:   names everyone agrees on, so nobody invents a second version
  units:      one entry per parallel worker, and no two may own the same path

The instructions are in .agentgate/PLANNING.md.

When you think it is right:

  agentgate plan check`);
    return OK;
  }

  if (sub !== 'check') {
    console.error(`Usage: agentgate plan new [--intent "..."]\n       agentgate plan check`);
    return TOOL_ERROR;
  }

  const config = loadConfig(root);
  const planPath = join(root, flags.plan ?? config.plan_path);

  // Somebody who ran `init` and then reached for `plan check` instead of
  // `plan new` has done nothing wrong. Land them softly rather than making them
  // decode a schema error about a placeholder they never wrote.
  //
  // Deliberately narrow: only the file `init` left. A blank plan from `plan new`
  // falls through and gets judged, because there somebody has started a real
  // batch of work and owes an answer about who owns what.
  if (isInitPlaceholder(planPath)) return reportPlaceholderPlan(flags);

  const plan = loadPlan(planPath);
  if (!plan.ok) return reportBadPlan(root, planPath, plan);

  const problems = checkPlan(plan.value);
  const result = {
    version: 1,
    stage: 'plan',
    run_id: plan.value.run.id,
    unit: null,
    clean: problems.length === 0,
    violations: problems,
  };

  emit(result, flags);
  return problems.length ? BAD_PLAN : OK;
}

// ---------------------------------------------------------------------------

function cmdCheck(flags) {
  const cwd = flags.cwd ?? process.cwd();
  const root = repoRoot(cwd);
  const config = loadConfig(root);
  const planPath = join(root, flags.plan ?? config.plan_path);

  const plan = loadPlan(planPath);
  if (!plan.ok) return reportBadPlan(root, planPath, plan);

  const planProblems = checkPlan(plan.value);
  if (planProblems.length) {
    console.error(`The plan itself has problems, so there is nothing to check against.\n`);
    console.error(renderText({ run_id: plan.value.run.id, unit: null, violations: planProblems }));
    return BAD_PLAN;
  }

  const base = flags.base ?? plan.value.run.base;
  const head = flags.head ?? 'HEAD';
  const mb = mergeBase(base, head, root);
  const files = changedFiles(mb, head, root);

  const unitIds = plan.value.units.map((u) => u.id);
  let attributed = null;

  if (!flags.all) {
    attributed = attributeUnit({ flag: flags.unit, cwd: root, unitIds });
    if (!attributed) return reportUnattributed({ flags, plan: plan.value, unitIds });
  }

  const overrides = [
    ...loadOverrides(root),
    ...parsePrOverrides(flags['pr-body'] ? readFileSync(flags['pr-body'], 'utf8') : process.env.AGENTGATE_PR_BODY),
  ];

  const violations = checkDiff({
    plan: plan.value,
    config,
    files,
    attributedUnit: attributed?.unitId ?? null,
    mergeBaseSha: mb,
    cwd: root,
    overrides,
  });

  const result = {
    version: 1,
    stage: 'check',
    run_id: plan.value.run.id,
    unit: attributed?.unitId ?? null,
    attributed_by: attributed?.source ?? null,
    base,
    merge_base: mb,
    files_changed: files.length,
    clean: violations.length === 0,
    violations,
  };

  emit(result, flags);

  const hasErrors = violations.some((v) => v.severity === 'error');
  return hasErrors ? VIOLATIONS : OK;
}

// ---------------------------------------------------------------------------

/**
 * The plan is still the placeholder `init` wrote, so there is nothing to check.
 *
 * Exits 0, not 2. A placeholder is not claiming anything, so there is nothing
 * for it to be wrong about. Note that `check` (stage 2) still exits 2 on the
 * same file, because there a placeholder genuinely cannot judge a real diff.
 *
 * No `clean` field in the JSON: it would be a lie either way round, since no
 * rule ran.
 */
function reportPlaceholderPlan(flags) {
  if (flags.format === 'json') {
    console.log(renderJson({ version: 1, stage: 'plan', status: 'placeholder', violations: [] }));
    return OK;
  }

  console.log(`agents-gate: this is still the placeholder plan that init wrote.

There is nothing to check yet. When you are about to run agents in parallel,
start a real plan:

  agentgate plan new --intent "what this batch of work is for"

That fills in the branch, commit and date, and replaces this placeholder
without asking — no --force needed, precisely because nobody has touched it.

Then fill in frozen, contract and units, and run this command again. The
instructions are in .agentgate/PLANNING.md.`);
  return OK;
}

/**
 * We could not work out which unit made these changes, so nothing was checked.
 *
 * This is deliberately not a violation code. No rule ran, there is no file to
 * point at, and the fix is in how the command was invoked rather than in the
 * code. Reporting it as a violation would mean either exiting 1 and claiming
 * the rules said no, or putting an entry in the violations list that does not
 * exit 1 — and the whole point of keeping the exit codes apart is that neither
 * of those should be able to happen.
 *
 * It still gets a body when the caller asked for JSON. A CI job that parses
 * stdout and finds an empty string has no way to say why the run stopped.
 */
function reportUnattributed({ flags, plan, unitIds }) {
  const message =
    `Could not work out which unit this change belongs to.\n\n` +
    `Any one of these fixes it:\n` +
    `  - run with --unit <id>       (ids in this plan: ${unitIds.join(', ')})\n` +
    `  - add a line 'Agent-Unit: <id>' to the last commit message\n` +
    `  - name the branch agent/<id>/something\n` +
    `  - run with --all if this branch already has several units merged into it`;

  if (flags.format === 'json') {
    console.log(
      renderJson({
        version: 1,
        stage: 'check',
        run_id: plan.run.id,
        unit: null,
        attributed_by: null,
        error: 'unattributed',
        message,
        unit_ids: unitIds,
        clean: false,
        violations: [],
      })
    );
  } else {
    console.error(message);
  }
  return TOOL_ERROR;
}

function emit(result, flags) {
  const format = flags.format ?? 'text';
  if (format === 'json') console.log(renderJson(result));
  else if (format === 'sarif') console.log(renderSarif(result));
  else console.log(renderText(result));

  if (process.env.GITHUB_ACTIONS === 'true' && format === 'text' && result.violations.length) {
    console.log(renderAnnotations(result));
  }
}

function loadPlan(path) {
  if (!existsSync(path)) {
    return { ok: false, problems: [`No plan file found at ${path}. Run 'agentgate init' first.`] };
  }
  let raw;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`This file isn't valid YAML: ${err.message}`] };
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    // A fresh plan that nobody filled in yet is the most common case by far.
    // Flag it so the caller can lead with that instead of a schema error.
    return {
      ok: false,
      problems: formatIssues(parsed.error),
      hasTodo: JSON.stringify(raw).includes('TODO'),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Say why a plan could not be used.
 *
 * When the plan is just unfinished, lead with that. "units.0.id: unit id must
 * be lowercase letters, numbers and dashes" is a true thing to say about a file
 * that still says TODO, and a useless one — it describes the symptom and leaves
 * the reader to infer the cause. Put the cause first and demote the schema
 * detail to a footnote for whoever actually wants it.
 */
function reportBadPlan(root, planPath, plan) {
  if (plan.hasTodo) {
    console.error(`This plan still has TODO placeholders in it, so there is nothing to check yet.

Fill in the units — and usually frozen and contract too. The instructions are
in .agentgate/PLANNING.md.

If you want the detail, the schema said:
`);
    for (const line of plan.problems) console.error(`  ${line}`);
    return BAD_PLAN;
  }

  console.error(`The plan at ${rel(root, planPath)} isn't valid:\n`);
  for (const line of plan.problems) console.error(`  ${line}`);
  return BAD_PLAN;
}

function loadConfig(root) {
  const path = join(root, '.agentgate', 'config.yaml');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const parsed = ConfigSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    console.error(`Warning: .agentgate/config.yaml is not valid, using defaults.`);
    return DEFAULT_CONFIG;
  }
  return parsed.data;
}

function loadOverrides(root) {
  const path = join(root, '.agentgate', 'overrides.yaml');
  if (!existsSync(path)) return [];
  const parsed = OverridesSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    console.error(`Warning: .agentgate/overrides.yaml is not valid, ignoring it.`);
    return [];
  }
  return parsed.data.overrides;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(root, path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function usage() {
  console.log(`agents-gate — keeps parallel coding agents inside their own lane.

  agentgate init                    set up .agentgate/ and the CI workflow
  agentgate prompt                  print the instructions for a planning agent
  agentgate prompt --install        point this repo's AGENTS.md at those instructions
  agentgate plan new                start a fresh plan with the run details filled in
  agentgate plan check              check the plan makes sense, before anyone runs
  agentgate check                   check this branch's changes against the plan

Options for plan new:
  --intent "..."      what this batch of work is for
  --base <branch>     branch to cut the plan from (defaults to the current one)
  --force             replace an existing plan

Options for check:
  --base <branch>     what to compare against (defaults to the plan's base)
  --unit <id>         say which unit made these changes
  --all               this branch already has several units merged in
  --format <kind>     text (default), json, or sarif
  --plan <path>       use a different plan file

Exit codes:
  0  fine
  1  the rules said no
  2  the plan itself is broken
  3  the tool could not run`);
  return OK;
}

process.exit(main(process.argv.slice(2)));
