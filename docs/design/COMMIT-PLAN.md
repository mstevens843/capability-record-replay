# COMMIT-PLAN

> **SUPERSEDED - HISTORICAL. Read this banner before any number below it.**
>
> This was a plan for commits that have since been made: `9048027` (*docs: README, REPORT and
> evidence bundle for submission*) and `60367a9` (*computer-use capability record/replay for legacy
> back-office apps*). Its opening sentence - *"Nothing here has been committed"* - was true when it
> was written and is false now.
>
> **Several numbers in it are stale and are not corrected in place, because the draft commit messages
> below are a record of what was actually written at the time and editing them would be a
> fabrication.** As measured on 2026-08-30 (`docs/FINAL-REVIEWER-GUIDE.md` and
> `docs/design/SUBMISSION-READY.md` carry the commands): `pnpm lint` reads **317** files, not 313;
> `pnpm test` is **2,032** tests / **109** test files, not 1,843 or 1,921; and the generated demo
> bundle is **278 files**, not 65.
>
> What is still true and still worth reading: the deletion list, the ordering rule (generated
> content before the documents that quote it), and the closing rule - **do not run `pnpm discover`
> in any form** while preparing the push.
>
> §6 below says *"nothing references it"* and offers `rm docs/design/COMMIT-PLAN.md`. That is still
> the cleanest option if the internal design notes are not part of what ships.

A suggested sequence for committing the submission-readiness pass by hand. Nothing here has been
committed - the working tree carries every change and `git status` matches the groups below.

**Run these yourself.** They are ordered so that every commit leaves the tree green, and so that the
one commit whose content is *generated* (§4) lands before the two documents that quote its numbers.

---

## Before the first commit

### Already deleted in the working tree - nothing to do but commit it

Five files whose first line was `// DELETE THIS FILE.` were tracked and would have shipped. They are
already `git rm`'d and gone from disk:

```
packages/conformance/.corpora.mts          430 B   throwaway kill-matrix driver
packages/conformance/probe.ts              474 B   `export {}` + a delete instruction
packages/conformance/src/__probe.ts        511 B   same; its barrel-test ledger entry went with it
packages/discovery/.cost-check.scratch.ts  1,565 B spend-arithmetic scratch check
packages/runtime/.ovcount.mts              398 B   throwaway overlay-count driver
```

Two orphan observation dumps in the live evidence bundle are also already `git rm`'d.
`verification.json` referenced only `journal-e95e0286…`; the other two were left over from earlier
attempts of the run:

```
evidence/discovery-live/verification-evidence/journal-a3351e3f….json
evidence/discovery-live/verification-evidence/journal-f43258ec….json
```

### Still on disk, gitignored, safe to remove - your call

None of these can ship; `git check-ignore` confirms every one. Removing them just makes the tree
match what a reviewer clones.

```bash
rm -rf .scratch packages/core/.scratch packages/conformance/.scratch .turbo
find . -name .DS_Store -not -path './.git/*' -not -path '*/node_modules/*' -delete
```

### Must stay gitignored, and must never be staged

`.env` (live funded credentials), `.private/` (the assignment PDF text and the build brief),
`.scratch/`, `.turbo/`, `node_modules/`, `dist/`, `.DS_Store`. All are covered by `/.gitignore` and
verified with `git check-ignore -v`. **Never `git add -A` without reading `git status` first**, and
never `git add -f` anything in that list.

---

## 1. `chore: delete five tracked scratch files`

```bash
git add packages/conformance/.corpora.mts packages/conformance/probe.ts \
        packages/conformance/src/__probe.ts packages/discovery/.cost-check.scratch.ts \
        packages/runtime/.ovcount.mts packages/conformance/test/barrel.test.ts
git commit
```

> ```
> chore: delete five tracked scratch files
>
> Each began with `// DELETE THIS FILE.` and each was tracked, lint-clean and
> would have shipped in the submission. `.ovcount.mts` was added by the previous
> commit itself.
>
> `__probe.ts` was on the conformance barrel test's NOT_ON_THE_BARREL ledger as a
> recorded defect; that entry is removed with it. The assertion that boxed it in
> ("zero exports, under 800 B") stays and now passes vacuously, so the file
> cannot come back unnoticed.
>
> `pnpm lint` goes 318 -> 313 files. No test, build or typecheck changes.
> ```

## 2. `fix: print a Chromium install command that actually works`

```bash
git add packages/runtime/demo/main.ts packages/discovery/tools/discover.ts \
        packages/runtime/test/support/corebank.ts \
        packages/runtime/test/synthesized-replay.test.ts \
        packages/surface-browser/test/support/corebank.ts \
        packages/conformance/test/heterogeneity.test.ts
git commit
```

> ```
> fix: print a Chromium install command that actually works
>
> `pnpm demo` refusing for lack of Chromium told the reader to run
> `pnpm exec playwright install chromium`, which fails from the repo root with
> `Command "playwright" not found` - playwright is a dependency of the packages
> that need it, not of the workspace root. The README already documented that;
> the program did not.
>
> Six call sites, all now `pnpm -F @crr/surface-browser exec playwright install
> chromium`: the demo's refusal and its generated evidence README, the discovery
> runner's refusal, and three test skip-guards.
> ```

## 3. `fix: the operator console is six routes, and examples is not a workspace member`

```bash
git add packages/runtime/src/console.ts packages/runtime/test/escalation.test.ts \
        docs/SPEC.md docs/design/RUNTIME-STATUS.md pnpm-workspace.yaml
git commit
```

> ```
> fix: the operator console is six routes, and examples is not a workspace member
>
> The console's own header said five routes, SPEC 7.3 said four, and its test
> title said four. The dispatcher exposes six: list, detail (also /view), claim,
> act, handback, abort. All four sites now say six, and SPEC's table splits
> handback and abort into their own rows so the table and the count agree.
>
> `pnpm-workspace.yaml` still declared `examples` with a six-line justification
> for a directory that does not exist, and SPEC 1.2 still listed it as a member.
> Both removed; the workspace is six packages plus two fixture apps.
> ```

## 4. `evidence: drop two orphan journals and regenerate the bundle`

**Run `pnpm demo` once, alone, immediately before this commit.** Two concurrent demo runs interleave
`clearOwned()` and leave both runs' observation files behind - that is how a bundle once reported 73
files. A clean single run reports **65**, and `find evidence -type f | wc -l` must agree.

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
    -u CLAUDE_CODE_OAUTH_TOKEN pnpm demo          # must end DEMO OK, exit 0
find evidence -type f | wc -l                     # must print 65
git add evidence
git commit
```

> ```
> evidence: drop two orphan journals and regenerate the bundle
>
> `verification-evidence/` held three frozen observations and `verification.json`
> referenced one. The other two were left over from earlier attempts of the live
> run - canary-clean and enumerated in MANIFEST.json, so inert, but two dumps
> nothing pointed at in the directory a reviewer reads most carefully.
>
> `discovery-live/README.md` now explains the two content addresses the bundle
> names for one artifact: `verification` is not on ARTIFACT_DIGEST_EXCLUDED_FIELDS,
> so writing the verification stamp moves the digest. The file on disk is
> self-consistent; the addressing is not reproducible from the recording, because
> `verification.runId` and `at` are not deterministic. Named as a gap rather than
> fixed, because the fix moves every committed artifact's digest.
>
> The rest is a clean `pnpm demo`: 65 files, whole-bundle canary CLEAN, 0 hits.
> Observation files are named by the digest of a journal carrying that run's own
> timestamps, so they churn on every run by design.
> ```

## 5. `docs: correct the spend and cache claims, and name four more gaps`

```bash
git add README.md REPORT.md
git commit
```

> ```
> docs: correct the spend and cache claims, and name four more gaps
>
> Two claims were wrong in the direction that costs the most in a repository
> whose pitch is "never claim what you cannot demonstrate":
>
> - "the first two attempts cost $0.00" was false for attempt 2. It threw parsing
>   a response the provider had already produced, so at least one turn was billed
>   that the ledger recorded as $0.00 - the arithmetic cannot see a turn it failed
>   to parse. The provider's console is the authority, not spend.json.
> - the 55.4% cache hit rate is a warm-start figure. All nine turns report
>   cacheCreationInputTokens: 0, so the prefix was warmed by that same failed
>   attempt. A cold run shows a lower rate and a write charge.
>
> Also corrected: "the two corpora together kill all nine; neither does alone" -
> the browser corpus alone kills all nine, only the terminal corpus does not;
> "every member 10041-10047 works" - 10047 is CLOSED and fails closed, which is
> now shown as the asset it is; the demo receipt `7/7 exhibits PASS`, a string the
> demo never prints; REPORT's stability console block, which did not match the
> real output; REPORT's "0 false successes" adjacent to "9 mutants", which read as
> the inverse of the finding; four routes -> the console's real shape; six
> SuspensionReasons -> seven; and "canary CLEAN" -> "canary passes 1-3 CLEAN".
>
> Four gaps that were in the internal status doc and in neither deliverable are
> now in REPORT section 7 and the README's limitations: the gating canary's
> 8-character needle floor against synthesis's 4; the artifact's two content
> addresses; "one contract, two surfaces" is not proved; and no live model has
> ever been refused, got stuck, or raised an intervention. `pnpm preflight` is
> now labelled as having no automated test at the place the README promotes it.
> ```

## 6. `docs: bring the internal status doc in line with the tree it describes`

```bash
git add docs/design/FINAL-STATUS.md docs/design/COMMIT-PLAN.md
git commit
```

> ```
> docs: bring the internal status doc in line with the tree it describes
>
> The five scratch files and the two orphan journals are deleted rather than
> pending; README.md and REPORT.md are committed rather than untracked; lint
> reads 313 files, not 316 or 318; the bundle is 65 files / 1,169,252 bytes, not
> 67 / 1,219,442; the demo prints seven PASS lines rather than `7/7`; and the
> kill-matrix section says plainly that the browser corpus alone kills all nine.
>
> Adds COMMIT-PLAN.md, which is this sequence.
> ```

If you would rather not ship the plan, `rm docs/design/COMMIT-PLAN.md` before this
commit - nothing references it.

---

## After the last commit

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY \
    -u CLAUDE_CODE_OAUTH_TOKEN pnpm test     # 1,843 across 8 members, exit 0
pnpm typecheck                               # 14/14
pnpm lint                                    # Checked 313 files, no fixes applied
pnpm build                                   # 8/8
git status --short                           # must be empty except ignored paths
git log --stat --oneline -6
```

Then confirm the three deliverable paths are in the tree the reviewer clones:

```bash
git ls-files README.md REPORT.md | wc -l     # 2
git ls-files evidence | wc -l                # 65
```

**Do not run `pnpm discover` in any form** while preparing the push. The live run is done and
committed; `.env` in this tree holds live funded credentials, and `loadDotEnv` restores them over an
`env -u` prefix.
