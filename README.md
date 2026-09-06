# TirithGate

Keeps parallel coding agents from writing outside their lane.

If you run three agents at once on the same repo, they can't see each other.
Two of them edit the same file, or one quietly rewrites a shared type the other
two are building against, and you find out at merge time when everything is
already written.

TirithGate makes you say up front who's allowed to touch what, then checks the
pull request against that.

```bash
npx tirithgate init
npx tirithgate prompt --install
```

`init` leaves a placeholder plan behind, not a real one. The next command is
`plan new`, which replaces that placeholder without asking — no `--force`,
because nobody has touched it. Running `plan check` on the placeholder is
harmless: it tells you to run `plan new` and exits `0`.

## How it works

There are two steps.

**Before you start the agents**, a plan gets written: a short file that says how
the work is split up.

You don't write this by hand. Your planning agent does, because it already knows
the split — it's the thing deciding which worker gets which files. Point it at
the instructions once:

```bash
npx tirithgate prompt --install
```

That adds a few lines to your repo's `AGENTS.md`, which is the file most coding
agents already read before they start. From then on, when you ask for parallel
work, the agent runs:

```bash
tirithgate plan new --intent "add billing endpoints and harden auth"
```

which writes the plan with the branch, commit and date already filled in, so the
agent only has to fill in the interesting parts:

```yaml
frozen:
  - path: src/types.ts
    reason: Shared types. Every unit is building against these right now.

units:
  - id: auth
    intent: Replace ad-hoc session checks with one guard.
    owns: ["src/auth/**", "test/auth/**"]
    provides: [requireUser]

  - id: billing
    intent: Add invoice endpoints.
    owns: ["src/billing/**", "test/billing/**"]
    may_call: [requireUser]
```

Then it checks its own work:

```bash
tirithgate plan check
```

```
tirithgate: 2 problems

PL002
       Units 'auth' and 'billing' both claim overlapping paths ('src/**' and
       'src/billing/**').

       Fix: Narrow one of them, or give the shared area to a third unit and
       have the other two treat it as read-only.

PL005
       Unit 'billing' wants to call 'formatMoney', but nothing in this plan
       defines it.

       Fix: Add it to the contract list, or have some unit provide it.
```

This takes about 40 milliseconds, so the agent can loop on it: write, check,
fix, check, until it comes back clean. The agent doesn't have to get the plan
right first time. It has to get it right before anyone starts coding, which is a
much easier problem.

The check that pays for the whole thing is `PL002`: two units both claiming
`src/utils/**`. You find that out now, for free, instead of two agent-hours
later.

**After the agents run**, the pull request gets checked against the plan:

```bash
tirithgate check --base main
```

```
tirithgate: 2 problems (run 2026-09-02-billing-auth, unit 'auth')

TG001  src/billing/api.ts
       'src/billing/api.ts' belongs to unit 'billing' (claimed by the pattern
       'src/billing/**'), but this change is attributed to 'auth'.

       Fix: Undo this file here and let 'billing' make the change instead. If
       both units genuinely need it, the plan is wrong — fix the plan.

TG002  src/types.ts
       'src/types.ts' is frozen for this run. Reason given in the plan: "Shared
       types. Every unit is building against these right now."

       Fix: Put this file back the way it was. If the shared thing really has to
       change, stop and re-cut the plan, because every other unit is building
       against the current version right now.
```

Every message has three parts: what happened, why it's a problem, what to do
instead. That's on purpose. Agents read this output and try to fix themselves,
so a message that only complains is a wasted turn.

## What it checks

Before the run:

| | |
|---|---|
| `PL002` | Two units claim overlapping paths |
| `PL003` | A unit claims something that's frozen |
| `PL004` | Two units both say they define the same shared name |
| `PL005` | A unit wants to call something nothing defines |
| `PL006` | A shared thing lives in a file nobody owns and isn't frozen |
| `PL007` | Two units have the same id |

After the run:

| | |
|---|---|
| `TG001` | Someone wrote in another unit's files |
| `TG002` | Someone changed a frozen file |
| `TG005` | A unit promised a decision note and didn't write one |
| `TG006` | A file nobody claimed got changed |
| `TG007` | The plan was cut from a commit that isn't in this history |
| `TG010` | An exception ran out |

## How it knows which unit made the change

In order, first one that works:

1. `--unit auth` on the command line
2. A line `Agent-Unit: auth` in the last commit message
3. A branch named `agent/auth/anything`
4. `--all`, for a branch that already has several units merged into it

If none of those work it stops rather than guessing, because guessing wrong
means blaming the wrong unit. That isn't a rule violation — no rule got as far
as running — so it exits `3` and prints the four ways to fix it, rather than
failing the build as if the code were at fault. With `--format json` you get
the same thing as a parseable object with `"error": "unattributed"`.

## Exceptions

Sometimes the rule is wrong. Two ways out, both need a reason and an end date.

In the pull request description:

```
TIRITHGATE-OVERRIDE: TG001 src/billing/invoice.ts
```

Or in `.tirithgate/overrides.yaml`:

```yaml
overrides:
  - code: TG006
    path: src/shared/format.ts
    reason: Old file, nobody owns it yet. Tracked in issue #412.
    expires: 2026-12-01
```

The end date isn't optional. Exceptions without one pile up, and a rule with
twenty permanent exceptions is decoration.

## One thing that will surprise you

When two patterns both match a file, **the more specific one wins**, and the
order you wrote them in doesn't matter.

GitHub's CODEOWNERS does the opposite: the last matching line wins. We went the
other way because this plan file is meant to be generated by a planning agent,
so the order of the lines is basically random. If order decided who owns a file,
the same plan could mean two different things.

## Isn't this just CODEOWNERS?

Fair question, and if CODEOWNERS is enough for you, use CODEOWNERS. It's built
into GitHub, costs nothing, and needs no install.

Three things it can't do:

**It says who reviews, never who may write right now.** CODEOWNERS is permanent.
Two agents both nominally allowed in `src/utils/**` is exactly the thing that
goes wrong, and CODEOWNERS has nothing to say about it.

**It can't check the split before any code exists.** `tirithgate plan check` runs
on the plan alone, in milliseconds, before an agent burns a single token.

**It doesn't record what a choice costs.** The plan lets a unit say up front that
asking for JSON output also means adding a validator, a retry, and a fallback,
and roughly what that costs. Then the check makes sure somebody wrote that down.

## Isn't this just archfit / dependency-cruiser / ArchUnit?

Those check rules that are **always true**: the domain layer must never import
the HTTP adapter, no import cycles, the public API mustn't drift. Good tools,
been around a while, use them.

They can't catch this: unit B was supposed to call `requireUser` and instead
wrote its own auth check. That breaks no permanent rule. The code is fine. It
breaks *what this particular run was supposed to do*, and right now that
intention only exists in a chat window and then disappears.

## Commands

| | |
|---|---|
| `tirithgate init` | set up `.tirithgate/` and the CI workflow |
| `tirithgate prompt` | print the planning instructions (pipe it, paste it) |
| `tirithgate prompt --install` | point this repo's `AGENTS.md` at those instructions |
| `tirithgate plan new --intent "..."` | start a fresh plan, run details filled in (replaces the placeholder `init` left) |
| `tirithgate plan check` | check the split makes sense, before anyone runs |
| `tirithgate check --base main` | check this branch against the plan |

## Where this came from

The idea is from "Architecture Without Architects: How AI Coding Agents Shape
Software Architecture" by Phongsakon Mark Konrad, Tim Lukas Adam, Riccardo
Terrenzi and Serkan Ayvaz, at the Centre for Industrial Software, University of
Southern Denmark ([arXiv:2604.04990](https://arxiv.org/abs/2604.04990)).

They describe five ways coding agents make architectural decisions that nobody
reviews as architecture. This tool is built on one of them, task decomposition:
"Because decomposition determines module boundaries, the agent designs the
system's modular structure." When an agent splits work across sub-agents or
parallel worktrees, it is drawing module boundaries. That reasoning lives in a
chat window and then it is gone.

TirithGate writes the split down before the agents run and checks it at pull
request time, so the boundary is an artifact you can review instead of
something you discover at merge.

That is one narrow slice of what the paper describes, and it does not solve the
problem the authors lay out. They have not reviewed this and are not connected
to it.

## Status

Early. The ownership and freeze checks work and are tested (68 tests, including
end-to-end runs of the real command against a real repo). Not yet
built:

- Catching two branches that both define a `User` type. Needs real parsing, and
  a version of this with false positives would get the whole tool switched off.
- Checking that a unit only calls what it said it would call.
- Pulling decision notes out of agent transcripts automatically.

## License

MIT
