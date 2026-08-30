import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BandDivergence,
  type CapabilityOverlay,
  type Observation,
  type RoutePattern,
  crossTenantDivergence,
  mergeOverlay,
  renderDivergence,
} from "@crr/core";
import { renderCanaryReport, runRedactionCanary } from "../src/canary.js";
import { ed25519Trust } from "../src/approval.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay, type ReplayOutput } from "../src/replay.js";
import {
  CROSS_TENANT_SCREENS,
  RIVERBEND_TENANT,
  SUMMIT_BASE_PATH,
  SUMMIT_TENANT,
  summitAllowlist,
  summitOverlay,
} from "../test/fixtures/corebank-summit.js";
import {
  APPROVER_KEY_ID,
  FIXTURE_MEMBER_ID,
  approverPublicKey,
  corebankAllowlist,
  sharePositionArtifact,
  sharePositionContract,
} from "../test/fixtures/corebank.js";
import type { CorebankSession } from "../test/support/corebank.js";
import { chromiumAvailable, openCorebankSession } from "../test/support/corebank.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OUT = join(REPO, "evidence/multi-tenant-overlay");
const PLACEHOLDER_ORIGIN = "http://placeholder.invalid";

interface ScenarioSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly overlay: "none" | "summit";
  readonly status: string;
  readonly failureClass?: string;
  readonly failureAtStep?: string;
  readonly stepsExecuted: number;
  readonly artifactDigest: string;
  readonly overlayDigest: string | null;
  readonly effectiveDigest: string;
  readonly drift: unknown;
  readonly outputs?: readonly string[];
  readonly note: string;
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function scrubEvidenceValue(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(FIXTURE_MEMBER_ID, "<memberId>");
  if (Array.isArray(value)) return value.map(scrubEvidenceValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubEvidenceValue(entry)]),
    );
  }
  return value;
}

function mergedRoutes(overlay: CapabilityOverlay): readonly RoutePattern[] {
  const merged = mergeOverlay(sharePositionArtifact, overlay);
  if (merged.problems.length > 0) {
    throw new Error(`overlay did not merge: ${merged.problems.map((p) => p.message).join("; ")}`);
  }
  return (merged.document.flow as { readonly routes: readonly RoutePattern[] }).routes;
}

async function runAgainst(args: {
  readonly id: string;
  readonly session: CorebankSession;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly overlay: CapabilityOverlay | null;
  readonly allowlist: typeof corebankAllowlist;
  readonly note: string;
}): Promise<{ readonly output: ReplayOutput; readonly summary: ScenarioSummary }> {
  const dir = join(OUT, args.id);
  const evidence = new MemoryEvidenceSink();
  let journal!: MemoryJournal;
  const output = await replay({
    contract: sharePositionContract,
    artifact: sharePositionArtifact,
    overlay: args.overlay,
    args: { memberId: FIXTURE_MEMBER_ID },
    tenant: args.tenant,
    allowlist: args.allowlist,
    broker: args.session.broker,
    trust: ed25519Trust([{ keyId: APPROVER_KEY_ID, publicKey: approverPublicKey }]),
    ids: sequentialIds(`overlay-${args.id}`),
    evidence,
    journal: (runId, clock) => {
      journal = new MemoryJournal({ runId, clock });
      return journal;
    },
    perceiveDeadlineMs: 15_000,
    onIntervention: "fail",
  });

  writeJson(join(dir, "journal.json"), journal.events);
  for (const ref of evidence.refs()) {
    writeJson(join(dir, "evidence", `${ref.replaceAll(":", "-")}.json`), evidence.get(ref));
  }

  const result = output.result;
  const failure =
    result.status === "failed"
      ? {
          failureClass: result.failure.class,
          ...(result.failure.atStep === null ? {} : { failureAtStep: result.failure.atStep }),
        }
      : {};
  const outputs =
    result.status === "ok" ? { outputs: Object.keys(result.outputs).sort() } : {};
  const summary: ScenarioSummary = {
    id: args.id,
    tenantId: args.tenant.tenantId,
    overlay: args.overlay === null ? "none" : "summit",
    status: result.status,
    ...failure,
    stepsExecuted: result.run.stepsExecuted,
    artifactDigest: result.run.artifact.digest,
    overlayDigest: result.run.artifact.overlayDigest,
    effectiveDigest: result.run.artifact.effectiveDigest,
    drift: scrubEvidenceValue(result.run.drift),
    ...outputs,
    note: args.note,
  };
  writeJson(join(dir, "result-summary.json"), summary);
  return { output, summary };
}

async function perceiveScreens(session: CorebankSession): Promise<readonly Observation[]> {
  const out: Observation[] = [];
  for (const screen of CROSS_TENANT_SCREENS) {
    await session.gotoContent(screen.path);
    const perceived = await session.surface.perceive({ deadlineMs: 15_000 });
    if (!perceived.ok) throw new Error(`perceive failed for ${screen.screen}`);
    out.push(perceived.observation);
  }
  return out;
}

function compactBand(band: BandDivergence): unknown {
  return {
    band: band.band,
    leftNodes: band.leftNodes,
    rightNodes: band.rightNodes,
    shared: band.shared,
    union: band.union,
    divergence: band.divergence,
    changed: scrubEvidenceValue(band.changed.slice(0, 12)),
    changedTruncated: band.changedTruncated,
  };
}

function overlaySemantics(overlay: CapabilityOverlay): unknown {
  const raw = overlay as unknown as {
    readonly vocabulary?: Readonly<Record<string, readonly string[]>>;
    readonly routeBasePath?: Readonly<Record<string, string>>;
    readonly steps?: Readonly<Record<string, unknown>>;
  };
  const text = JSON.stringify(overlay);
  return {
    vocabularyTokens: Object.keys(raw.vocabulary ?? {}).sort(),
    routeBasePathRoutes: Object.keys(raw.routeBasePath ?? {}).sort(),
    settleOverrideSteps: Object.keys(raw.steps ?? {}).sort(),
    forbiddenSemanticFieldsAbsent:
      !text.includes('"outcomes"') &&
      !text.includes('"instruction"') &&
      !text.includes('"effect"') &&
      !text.includes('"extract"'),
  };
}

function scan(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scan(full));
    else out.push(full);
  }
  return out;
}

function writeReadme(): void {
  writeText(
    join(OUT, "README.md"),
    [
      "# multi-tenant overlay evidence",
      "",
      "Generated by `pnpm -F @crr/runtime exec tsx demo/multi-tenant-overlay.ts`.",
      "",
      "This exhibit uses one browser artifact recorded for Riverbend and replays it at Summit",
      "through a per-tenant overlay. The overlay changes labels, route base paths and two settle",
      "budgets. It does not add steps, instructions, effects, extractors or outcome detectors.",
      "",
      "`tenant-b-no-overlay/` is the negative control: the same tenant invocation without the",
      "overlay fails at link time before any step executes, because the base artifact is not scoped",
      "to Summit.",
      "",
      "`divergence.txt` and `divergence-summary.json` are measured from paired observations of the",
      "same four product screens at both tenants. No threshold ships; the report is evidence for a",
      "human specialization decision, not an automatic verdict.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  if (!chromiumAvailable()) {
    throw new Error(
      "no Chromium build found; run `pnpm -F @crr/surface-browser exec playwright install chromium`",
    );
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const riverbend = await openCorebankSession(sharePositionArtifact.flow.routes);
  let summit: CorebankSession | null = null;
  let summitNoOverlay: CorebankSession | null = null;
  try {
    const base = await runAgainst({
      id: "tenant-a",
      session: riverbend,
      tenant: RIVERBEND_TENANT,
      overlay: null,
      allowlist: corebankAllowlist,
      note: "The base artifact runs at the tenant it was recorded against with no overlay.",
    });
    if (base.output.result.status !== "ok") {
      throw new Error(`tenant-a expected ok, got ${base.output.result.status}`);
    }

    const overlay = summitOverlay(PLACEHOLDER_ORIGIN);
    summit = await openCorebankSession(mergedRoutes(overlay), { basePath: SUMMIT_BASE_PATH });
    const liveOverlay = summitOverlay(summit.fixture.origin);
    writeJson(join(OUT, "overlay.json"), liveOverlay);
    writeJson(join(OUT, "overlay-summary.json"), overlaySemantics(liveOverlay));

    const summitRun = await runAgainst({
      id: "tenant-b-with-overlay",
      session: summit,
      tenant: SUMMIT_TENANT,
      overlay: liveOverlay,
      allowlist: summitAllowlist,
      note: "The same base artifact runs at Summit through overlay-only vocabulary, route and settle-budget changes.",
    });
    if (summitRun.output.result.status !== "ok") {
      throw new Error(`tenant-b-with-overlay expected ok, got ${summitRun.output.result.status}`);
    }
    if (summitRun.output.result.run.artifact.digest !== base.output.result.run.artifact.digest) {
      throw new Error("overlay changed the base artifact digest");
    }

    summitNoOverlay = await openCorebankSession(sharePositionArtifact.flow.routes, {
      basePath: SUMMIT_BASE_PATH,
    });
    const noOverlay = await runAgainst({
      id: "tenant-b-no-overlay",
      session: summitNoOverlay,
      tenant: SUMMIT_TENANT,
      overlay: null,
      allowlist: summitAllowlist,
      note: "Without Summit's overlay, the linker refuses before any step executes because the base artifact is not scoped to Summit.",
    });
    if (
      noOverlay.output.result.status !== "failed" ||
      noOverlay.output.result.failure.class !== "link-error"
    ) {
      throw new Error(
        `tenant-b-no-overlay expected failed/link-error, got ${noOverlay.output.result.status}`,
      );
    }

    const left = await perceiveScreens(riverbend);
    const right = await perceiveScreens(summit);
    const divergence = crossTenantDivergence({
      leftTenantId: RIVERBEND_TENANT.tenantId,
      rightTenantId: SUMMIT_TENANT.tenantId,
      screens: CROSS_TENANT_SCREENS.map((screen, i) => ({
        screen: screen.screen,
        left: left[i] as Observation,
        right: right[i] as Observation,
      })),
    });
    writeText(join(OUT, "divergence.txt"), `${renderDivergence(divergence)}\n`);
    writeJson(join(OUT, "divergence-summary.json"), {
      leftTenantId: divergence.leftTenantId,
      rightTenantId: divergence.rightTenantId,
      needsSpecialization: divergence.needsSpecialization,
      overall: {
        all: compactBand(divergence.overall.all),
        interactive: compactBand(divergence.overall.interactive),
      },
      screens: divergence.screens.map((screen) => ({
        screen: screen.screen,
        all: compactBand(screen.all),
        interactive: compactBand(screen.interactive),
      })),
    });

    const summaries = [base.summary, summitRun.summary, noOverlay.summary];
    writeReadme();
    const report = runRedactionCanary({
      bundleDir: OUT,
      secrets: [{ label: "OVERLAY_MEMBER_ID", value: FIXTURE_MEMBER_ID }],
    });
    writeJson(join(OUT, "redaction-canary.json"), report);
    writeText(join(OUT, "redaction-canary.txt"), renderCanaryReport(report));
    writeJson(join(OUT, "MANIFEST.json"), {
      generatedBy: "packages/runtime/demo/multi-tenant-overlay.ts",
      scenarioCount: summaries.length,
      scenarios: summaries,
      overlaySemantics: overlaySemantics(liveOverlay),
      divergence: {
        overallAll: divergence.overall.all.divergence,
        overallInteractive: divergence.overall.interactive.divergence,
        needsSpecialization: divergence.needsSpecialization,
      },
      redaction: {
        clean: report.clean,
        filesScanned: report.filesScanned,
        hits: report.hits.length,
        forbidden: report.forbidden.length,
      },
      files: scan(OUT).map((path) => path.slice(OUT.length + 1).replaceAll("\\", "/")).sort(),
    });

    const finalReport = runRedactionCanary({
      bundleDir: OUT,
      secrets: [{ label: "OVERLAY_MEMBER_ID", value: FIXTURE_MEMBER_ID }],
    });
    if (!finalReport.clean) {
      throw new Error(`multi-tenant overlay evidence redaction failed: ${finalReport.hits.length} hits`);
    }
    process.stdout.write(
      `multi-tenant overlay evidence: ${summaries.length} scenarios, canary clean\n`,
    );
  } finally {
    await riverbend.close();
    await summit?.close();
    await summitNoOverlay?.close();
  }
}

await main();
