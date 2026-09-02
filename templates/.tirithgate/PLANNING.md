# Before you split work between agents

Read this when you are about to run more than one agent, sub-agent, or worktree
on this repo at the same time. Skip it for single-agent work.

You are going to write down how you split the work **before** anyone starts
coding. The split is the thing that decides the shape of the code, so it should
be written down and checked, not left implied.

## The loop

```bash
tirithgate plan new --intent "what this batch of work is for"
# edit .tirithgate/plan.yaml — see below
tirithgate plan check
```

`plan new` fills in the branch, the commit, and the date for you. You only write
the `frozen`, `contract`, and `units` parts.

`plan check` takes about 40 milliseconds and tells you exactly what is wrong.
Run it, read the fix line, edit, run again. Keep going until it says all clear.
Do not start any workers until it does.

## What you write

```yaml
frozen:
  - path: src/types.ts
    reason: Shared types. Every unit builds against these.

contract:
  - symbol: requireUser
    module: src/auth/session.ts
    kind: function
    signature: "(req: Request) => User"

units:
  - id: auth
    intent: Replace ad-hoc session checks with one guard.
    owns:
      - "src/auth/**"
      - "test/auth/**"
    provides: [requireUser]

  - id: billing
    intent: Add invoice endpoints.
    owns:
      - "src/billing/**"
      - "test/billing/**"
    may_call: [requireUser]
    impact:
      - feature: structured-json-output
        adds: [schema validator, retry handler, fallback path]
        est_loc: 330
        new_failure_modes:
          - Validation rejects a reply that was actually fine.
          - Retries run out and a made-up default gets returned as if it worked.
        adr_required: true
```

## Rules

1. **No two units may own the same path.** If two units need the same file, the
   split is wrong. Either move that file into one unit and have the other call
   it, or freeze it and have neither touch it.

2. **Freeze anything shared.** Types, interfaces, and constants that several
   units build against go in `frozen`. If two units can both edit a shared type,
   they will disagree, and you will not find out until merge.

3. **Name the shared surface in `contract` before anyone starts.** If unit B
   needs to check whether a request is authenticated, say so: unit A `provides`
   `requireUser`, unit B `may_call` it. Otherwise B will invent a second auth
   check and you will end up with two.

4. **Every unit needs at least one `owns` pattern, and `intent` in one line.**

5. **Say what the prompt is going to cost.** If a unit's job includes structured
   JSON output, tool calling, or anything that needs validation and retries,
   write an `impact` entry. Asking for structured output is also asking for a
   validator, a retry handler, and a fallback path. Write that down before it
   gets built, and set `adr_required: true` so somebody records the reasoning.

6. **Split by area of the codebase, not by kind of task.** "auth" and "billing"
   are good units. "write the code" and "write the tests" are not — they will
   collide on every file.

## Common mistakes

**Claiming too much.** `owns: ["src/**"]` for one unit means no other unit can do
anything. Claim the folders you actually need.

**Forgetting tests.** If a unit writes `src/auth/`, it almost certainly writes
`test/auth/` too. Claim both, or the check will complain about unclaimed files.

**Freezing nothing.** Almost every repo has a shared types file. If you froze
nothing, look again.

**Writing a plan for work that is not parallel.** One agent doing one thing does
not need this. The plan is for when several agents cannot see each other.

## While the work runs

Each worker should be on a branch named `agent/<unit-id>/something`, or should
put a line `Agent-Unit: <unit-id>` in its commit message. That is how the check
knows which unit a change came from.

If a worker needs something outside its area, it does not take it. It stops and
the plan gets changed.
