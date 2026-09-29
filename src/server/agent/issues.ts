
/**
 * Agent issue engine (v0.9.4): derives normalized, actionable conditions
 * from data Beacon already collects. Read-only observability.
 *
 * - Deterministic issue IDs (`category:target:condition`) so the same
 *   ongoing condition keeps its identity across polls.
 * - Lifecycle: firstSeen/lastSeen tracked in a bounded in-memory registry;
 *   conditions absent from the current evaluation become `resolved`
 *   (kept briefly for consumers, then pruned).
 * - suggestedChecks are informational strings only — never executable.
 */

export type AgentSeverity = "info" | "warning" | "critical";
export type AgentIssueStatus = "active" | "recovering" | "resolved";

export interface AgentIssue {
  id: string;
  severity: AgentSeverity;
  category: "docker" | "storage" | "system" | "updates" | "automation" | "dependency";
  status: AgentIssueStatus;
  condition: string;
  summary: string;
  target: { type: string; id: string | null; name: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  observedForSeconds: number;
  metrics: Record<string, number | string | null>;
  context: Record<string, string | number | boolean | null>;
  suggestedChecks: string[];
}

interface IssueRecord {
  issue: AgentIssue;
}

const registry = globalThis as unknown as {
  __agentIssues?: Map<string, IssueRecord>;
};

const RESOLVED_TTL_MS = 10 * 60_000;
const MAX_ISSUES = 300;

function issueRegistry(): Map<string, IssueRecord> {
  if (!registry.__agentIssues) registry.__agentIssues = new Map();
  return registry.__agentIssues;
}

export function resetAgentIssues(): void {
  registry.__agentIssues = undefined;
}

interface RawObservation {
  id: string;
  severity: AgentSeverity;
  category: AgentIssue["category"];
  condition: string;
  summary: string;
  target?: AgentIssue["target"];
  metrics?: Record<string, number | string | null>;
  context?: Record<string, string | number | boolean | null>;
  suggestedChecks?: string[];
}

/**
 * Merges current observations into the lifecycle registry and returns the
 * active+resolved issue list (resolved entries retained for a grace window
 * so consumers see explicit resolution instead of inferring from absence).
 */
export function mergeObservations(now: Date, observations: RawObservation[]): AgentIssue[] {
  const reg = issueRegistry();
  const seen = new Set<string>();
  const out: AgentIssue[] = [];

  for (const observation of observations) {
    seen.add(observation.id);
    const existing = reg.get(observation.id);
    const firstSeenAt = existing?.issue.firstSeenAt ?? now.toISOString();
    const issue: AgentIssue = {
      id: observation.id,
      severity: observation.severity,
      category: observation.category,
      status: "active" as AgentIssueStatus,
      condition: observation.condition,
      summary: observation.summary,
      target: observation.target ?? null,
      firstSeenAt,
      lastSeenAt: now.toISOString(),
      resolvedAt: null,
      observedForSeconds: Math.round((now.getTime() - Date.parse(firstSeenAt)) / 1000),
      metrics: observation.metrics ?? {},
      context: observation.context ?? {},
      suggestedChecks: observation.suggestedChecks ?? [],
    };
    reg.set(observation.id, { issue });
    out.push(issue);
  }

  // Everything previously active but not seen now → resolved (grace TTL).
  const nowMs = now.getTime();
  for (const [id, record] of reg) {
    if (seen.has(id)) continue;
    if (record.issue.status !== "resolved") {
      record.issue.status = "resolved";
      record.issue.resolvedAt = now.toISOString();
    }
    const resolvedAge = nowMs - Date.parse(record.issue.resolvedAt ?? now.toISOString());
    if (resolvedAge > RESOLVED_TTL_MS || reg.size > MAX_ISSUES) {
      reg.delete(id);
      continue;
    }
    out.push({ ...record.issue, observedForSeconds: Math.round((nowMs - Date.parse(record.issue.firstSeenAt)) / 1000) });
  }

  return out.sort((a, b) => {
    const severityOrder: Record<AgentSeverity, number> = { critical: 0, warning: 1, info: 2 };
    if (a.status !== b.status) return a.status === "active" || a.status === "recovering" ? -1 : 1;
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity]! - severityOrder[b.severity]!;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Test hook: seed the registry directly. */
export function seedIssueForTest(issue: AgentIssue): void {
  issueRegistry().set(issue.id, { issue });
}

export function currentIssueCount(): number {
  return issueRegistry().size;
}

/* ---- observation builders (pure, from data Beacon already has) ------------ */

export interface DockerIssueInput {
  name: string;
  id: string;
  health: string | null;
  updateAvailable: boolean;
  risk: string;
  managementType: string;
  cpuPercent: number | null;
}

export function dockerIssues(containers: DockerIssueInput[]): RawObservation[] {
  const out: RawObservation[] = [];
  for (const container of containers) {
    if (container.health === "unhealthy") {
      out.push({
        id: `docker:${container.name}:unhealthy`,
        severity: "critical",
        category: "docker",
        condition: "container_unhealthy",
        summary: `Container ${container.name} reports unhealthy`,
        target: { type: "container", id: container.id, name: container.name },
        metrics: { cpuPercent: container.cpuPercent },
        suggestedChecks: ["Inspect container logs", "Check container health command"],
      });
    }
    if (container.updateAvailable && container.risk === "HIGH") {
      out.push({
        id: `docker:${container.name}:high_risk_update`,
        severity: "warning",
        category: "updates",
        condition: "high_risk_update_available",
        summary: `HIGH-risk container ${container.name} has an update available (manual policy)`,
        target: { type: "container", id: container.id, name: container.name },
        metrics: {},
        context: { managementType: container.managementType },
        suggestedChecks: ["Review the update in the Docker page", "Update manually if appropriate"],
      });
    }
  }
  return out;
}

export interface AutomationIssueFacts {
  enabled: boolean;
  paused: boolean;
  queueLength: number;
  cooldownCount: number;
  interventionCount: number;
  helperHealthy: boolean | null;
}

export function automationIssues(facts: AutomationIssueFacts, now: Date): RawObservation[] {
  const out: RawObservation[] = [];
  if (facts.helperHealthy === false) {
    out.push({
      id: "dependency:helper:offline",
      severity: "warning",
      category: "dependency",
      condition: "helper_offline",
      summary: "Update helper is unreachable — updates and rollback are unavailable",
      target: { type: "service", id: "update-helper", name: "update-helper" },
      suggestedChecks: ["Check the unraid-dashboard-helper container", "Verify it binds 127.0.0.1:8790"],
    });
  }
  if (facts.interventionCount > 0) {
    out.push({
      id: "automation:intervention:required",
      severity: "critical",
      category: "automation",
      condition: "manual_intervention_required",
      summary: `${facts.interventionCount} automation target(s) require manual intervention`,
      suggestedChecks: ["Open the Automation page", "Acknowledge after verifying container state"],
    });
  }
  if (facts.cooldownCount > 0) {
    out.push({
      id: "automation:cooldown:active",
      severity: "info",
      category: "automation",
      condition: "automation_cooldown",
      summary: `${facts.cooldownCount} automation target(s) in cooldown`,
      suggestedChecks: ["Review cooldown reasons on the Automation page"],
    });
  }
  if (facts.paused && facts.enabled) {
    out.push({
      id: "automation:state:paused",
      severity: "info",
      category: "automation",
      condition: "automation_paused",
      summary: "Automation is enabled but paused",
      suggestedChecks: ["Resume automation when ready"],
    });
  }
  void now;
  return out;
}

export interface RegistryIssueFacts {
  registryVerified: boolean;
}

export function registryIssues(facts: RegistryIssueFacts): RawObservation[] {
  if (!facts.registryVerified) return [];
  return [
    {
      id: "updates:registry:auth",
      severity: "info",
      category: "updates",
      condition: "registry_auth_unavailable",
      summary: "Registry digest cannot be verified anonymously (private package) — pull probe confirms access",
      suggestedChecks: ["Registry pull access is verified by the helper probe; no action needed"],
    },
  ];
}

/** Compact SHA-256-free correlation id: stable per condition+target. */
export function correlationId(issueId: string): string {
  return issueId;
}
