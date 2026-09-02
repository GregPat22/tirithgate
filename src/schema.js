import { z } from 'zod';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SHA40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// plan.yaml
// ---------------------------------------------------------------------------

const FrozenEntry = z.object({
  path: z.string().min(1),
  reason: z.string().min(1, 'every frozen path needs a reason'),
});

const ContractEntry = z.object({
  symbol: z.string().min(1),
  module: z.string().min(1),
  kind: z.enum(['type', 'function', 'class', 'const', 'interface']).optional(),
  signature: z.string().optional(),
});

const ImpactEntry = z.object({
  feature: z.string().min(1),
  adds: z.array(z.string()).default([]),
  est_loc: z.number().int().nonnegative().optional(),
  new_failure_modes: z.array(z.string()).default([]),
  adr_required: z.boolean().default(false),
});

const Unit = z.object({
  id: z.string().regex(SLUG, 'unit id must be lowercase letters, numbers and dashes'),
  intent: z.string().min(1),
  owns: z.array(z.string().min(1)).min(1, 'a unit must own at least one path'),
  provides: z.array(z.string()).default([]),
  may_call: z.array(z.string()).default([]),
  impact: z.array(ImpactEntry).default([]),
});

export const PlanSchema = z.object({
  version: z.literal(1),
  run: z.object({
    id: z.string().min(1),
    base: z.string().min(1),
    base_sha: z.string().regex(SHA40, 'base_sha must be a full 40-character commit sha'),
    created: z.string().min(1),
    intent: z.string().min(1),
  }),
  frozen: z.array(FrozenEntry).default([]),
  contract: z.array(ContractEntry).default([]),
  units: z.array(Unit).min(1, 'a plan needs at least one unit'),
});

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  version: z.literal(1),
  adr_dir: z.string().default('docs/adr'),
  plan_path: z.string().default('.agentgate/plan.yaml'),
  unattributed: z.enum(['error', 'warn', 'ignore']).default('warn'),
  frozen_severity: z.enum(['error', 'warn']).default('error'),
});

export const DEFAULT_CONFIG = {
  version: 1,
  adr_dir: 'docs/adr',
  plan_path: '.agentgate/plan.yaml',
  unattributed: 'warn',
  frozen_severity: 'error',
};

// ---------------------------------------------------------------------------
// overrides.yaml
// ---------------------------------------------------------------------------

export const OverridesSchema = z.object({
  version: z.literal(1),
  overrides: z
    .array(
      z.object({
        code: z.string().min(1),
        path: z.string().min(1),
        reason: z.string().min(1, 'every override needs a reason'),
        expires: z.string().min(1, 'every override needs an expiry date'),
      })
    )
    .default([]),
});

/**
 * Turn a zod error into short lines a person (or an agent) can act on.
 */
export function formatIssues(error) {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}
