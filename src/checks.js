import { buildOwnership, resolveOwner, resolveFrozen, patternsOverlap, matches } from './paths.js';
import { isAncestor } from './git.js';

// ---------------------------------------------------------------------------
// Stage 1 — check the plan on its own. No git needed. Runs in milliseconds.
// ---------------------------------------------------------------------------

export function checkPlan(plan) {
  const problems = [];

  const add = (code, message, fix) => problems.push({ code, message, fix, severity: 'error' });

  // PL002 — two units claiming the same ground.
  // This is the one that pays for the whole stage.
  for (let i = 0; i < plan.units.length; i++) {
    for (let j = i + 1; j < plan.units.length; j++) {
      const a = plan.units[i];
      const b = plan.units[j];
      for (const pa of a.owns) {
        for (const pb of b.owns) {
          if (patternsOverlap(pa, pb)) {
            add(
              'PL002',
              `Units '${a.id}' and '${b.id}' both claim overlapping paths ` +
                `('${pa}' and '${pb}').`,
              `Narrow one of them, or give the shared area to a third unit and ` +
                `have the other two treat it as read-only.`
            );
          }
        }
      }
    }
  }

  // PL003 — a unit claims something that is frozen.
  for (const unit of plan.units) {
    for (const pattern of unit.owns) {
      for (const frozen of plan.frozen) {
        if (matches(pattern, frozen.path) || patternsOverlap(pattern, frozen.path)) {
          add(
            'PL003',
            `Unit '${unit.id}' claims '${pattern}', which covers frozen path '${frozen.path}'.`,
            `Frozen paths belong to nobody during a run. Remove the claim or unfreeze the path.`
          );
        }
      }
    }
  }

  // PL004 — two units both say they define the same public name.
  const providers = new Map();
  for (const unit of plan.units) {
    for (const symbol of unit.provides) {
      if (providers.has(symbol)) {
        add(
          'PL004',
          `'${symbol}' is provided by both '${providers.get(symbol)}' and '${unit.id}'.`,
          `Exactly one unit should define a shared name. The other should call it.`
        );
      } else {
        providers.set(symbol, unit.id);
      }
    }
  }

  // PL005 — a unit wants to call something nothing defines.
  const known = new Set([...providers.keys(), ...plan.contract.map((c) => c.symbol)]);
  for (const unit of plan.units) {
    for (const symbol of unit.may_call) {
      if (!known.has(symbol)) {
        add(
          'PL005',
          `Unit '${unit.id}' wants to call '${symbol}', but nothing in this plan defines it.`,
          `Add it to the contract list, or have some unit provide it.`
        );
      }
    }
  }

  // PL006 — a shared thing lives in a file nobody owns and that is not frozen.
  const claims = buildOwnership(plan);
  for (const entry of plan.contract) {
    const owner = resolveOwner(claims, entry.module);
    const frozen = resolveFrozen(plan, entry.module);
    if (!owner && !frozen) {
      add(
        'PL006',
        `Shared symbol '${entry.symbol}' lives in '${entry.module}', which no unit ` +
          `owns and which is not frozen.`,
        `Freeze that file, or give it to one unit. Otherwise every unit will feel ` +
          `free to edit it and they will disagree.`
      );
    }
  }

  // PL007 — duplicate unit ids.
  const seen = new Set();
  for (const unit of plan.units) {
    if (seen.has(unit.id)) {
      add('PL007', `Two units share the id '${unit.id}'.`, `Unit ids must be unique.`);
    }
    seen.add(unit.id);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Stage 2 — check a diff against the plan.
// ---------------------------------------------------------------------------

export function checkDiff({ plan, config, files, attributedUnit, mergeBaseSha, cwd, overrides }) {
  const violations = [];
  const claims = buildOwnership(plan);

  const add = (code, path, message, fix, severity = 'error') => {
    if (isOverridden(overrides, code, path)) return;
    violations.push({ code, path, message, fix, severity });
  };

  // TG007 — the plan was cut from a commit that is no longer behind us.
  if (mergeBaseSha && !isAncestor(plan.run.base_sha, mergeBaseSha, cwd)) {
    add(
      'TG007',
      null,
      `This plan says it was cut from ${plan.run.base_sha.slice(0, 7)}, but that commit ` +
        `is not in the history you are merging into.`,
      `Usually this means the base branch got rewritten, or the plan was copied ` +
        `over from somewhere else. Cut a fresh plan from the current base: ` +
        `set base_sha to the output of 'git rev-parse ${plan.run.base}'.`
    );
  }

  const adrPrefix = config.adr_dir.replace(/\/$/, '') + '/';

  for (const file of files) {
    // Decision notes belong to everyone. The tool asks units to write these,
    // so it would be silly to then complain that nobody owns the folder.
    if (file.path.startsWith(adrPrefix)) continue;

    // The plan and its settings are not something a unit gets to own either.
    if (file.path.startsWith('.tirithgate/')) continue;

    // Frozen beats everything.
    const frozen = resolveFrozen(plan, file.path);
    if (frozen) {
      add(
        'TG002',
        file.path,
        `'${file.path}' is frozen for this run. Reason given in the plan: ` +
          `"${frozen.reason}"`,
        `Put this file back the way it was. If the shared thing really has to ` +
          `change, stop and re-cut the plan, because every other unit is building ` +
          `against the current version right now.`,
        config.frozen_severity
      );
      continue;
    }

    const owner = resolveOwner(claims, file.path);

    // TG006 — nobody claimed this file.
    if (!owner) {
      if (config.unattributed === 'ignore') continue;
      add(
        'TG006',
        file.path,
        `'${file.path}' is not claimed by any unit in this plan.`,
        `Add it to a unit's 'owns' list, freeze it, or leave it alone.`,
        config.unattributed
      );
      continue;
    }

    // TG001 — someone else's file.
    if (attributedUnit && owner.unitId !== attributedUnit) {
      add(
        'TG001',
        file.path,
        `'${file.path}' belongs to unit '${owner.unitId}' ` +
          `(claimed by the pattern '${owner.pattern}'), but this change is ` +
          `attributed to '${attributedUnit}'.`,
        `Undo this file here and let '${owner.unitId}' make the change instead. ` +
          `If both units genuinely need it, the plan is wrong — fix the plan.`
      );
    }
  }

  // TG005 — a unit promised an ADR and did not write one.
  const changedPaths = files.map((f) => f.path);
  const unitsToCheck = attributedUnit
    ? plan.units.filter((u) => u.id === attributedUnit)
    : plan.units;

  for (const unit of unitsToCheck) {
    for (const impact of unit.impact) {
      if (!impact.adr_required) continue;
      const wroteOne = changedPaths.some(
        (p) => p.startsWith(config.adr_dir.replace(/\/$/, '') + '/') && p.endsWith('.md')
      );
      if (!wroteOne) {
        add(
          'TG005',
          null,
          `Unit '${unit.id}' said up front that '${impact.feature}' would need a ` +
            `written decision note, and there isn't one.`,
          `Add a short file under ${config.adr_dir}/ saying what was chosen and why. ` +
            (impact.new_failure_modes.length
              ? `The plan already listed what to cover: ` +
                impact.new_failure_modes.map((m) => `"${m}"`).join(' ')
              : '')
        );
      }
    }
  }

  // TG010 — an override that has run out.
  const today = new Date().toISOString().slice(0, 10);
  for (const o of overrides) {
    if (o.expires < today) {
      violations.push({
        code: 'TG010',
        path: o.path,
        message: `An exception for ${o.code} on '${o.path}' expired on ${o.expires}.`,
        fix: `Either fix the underlying problem or extend the date on purpose, with a reason.`,
        severity: 'error',
      });
    }
  }

  return violations;
}

function isOverridden(overrides, code, path) {
  if (!path) return false;
  const today = new Date().toISOString().slice(0, 10);
  return overrides.some((o) => o.code === code && o.path === path && o.expires >= today);
}

/**
 * Exceptions written straight into the pull request description.
 * Shape:  TIRITHGATE-OVERRIDE: TG001 src/billing/invoice.ts
 */
export function parsePrOverrides(body) {
  if (!body) return [];
  const out = [];
  const far = '2999-12-31';
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*TIRITHGATE-OVERRIDE:\s*(\S+)\s+(\S+)\s*$/);
    if (m) out.push({ code: m[1], path: m[2], reason: 'declared in the PR body', expires: far });
  }
  return out;
}
