import type { SupportBundlePayload } from "@/lib/api-types";
import { getBuildInfo } from "@/server/version";
import { currentIncidentSnapshot } from "./cycle";
import { getPersistenceHealth } from "./persistence-check";
import { getAllSourceHealth } from "./source-health";
import { redactValue } from "./redact";
import { lastIncidentsSaveError } from "./store";
import { operationsForEntity } from "@/server/remediation/operations";

/**
 * Support bundle (v1.5.0 Fase 28): a bounded, sanitized diagnostics
 * snapshot a user can paste into an issue. Built from provenance-only
 * fields, then scrubbed through the redactor regardless (Fase 29).
 *
 * NEVER included: API keys, VAPID private key, cookies, auth headers,
 * raw push endpoints, passwords, container environment, log contents.
 */

export function buildSupportBundle(): SupportBundlePayload {
  const snapshot = currentIncidentSnapshot();
  const sources = getAllSourceHealth();
  const active = snapshot.active;

  const recentSafeErrors = sources
    .filter((source) => source.safeError)
    .slice(0, 8)
    .map((source) => `${source.source}: ${source.safeError?.slice(0, 120)}`);

  const bundle: SupportBundlePayload = {
    generatedAt: new Date().toISOString(),
    version: getBuildInfo(),
    sourceHealth: sources.map((source) => ({
      ...source,
      safeError: source.safeError ? source.safeError.slice(0, 160) : null,
      detail: source.detail ? source.detail.slice(0, 160) : null,
    })),
    confidence: snapshot.confidence,
    incidents: {
      active: snapshot.counts.active,
      critical: snapshot.counts.critical,
      warning: snapshot.counts.warning,
      info: snapshot.counts.info,
    },
    activeIncidents: active.slice(0, 25).map((incident) => ({
      id: incident.id,
      entity: incident.entity,
      kind: incident.kind,
      severity: incident.severity,
      firstSeenAt: incident.firstSeenAt,
      lastSeenAt: incident.lastSeenAt,
      title: incident.title,
    })),
    persistence: {
      dataDirWritable: null,
      lastSuccessfulPersistAt: null,
      incidentsFileBytes: null,
      notificationsFileBytes: null,
    },
    inventoryDiagnostics: null,
    recentSafeErrors,
    counts: { sources: sources.length, activeIncidents: active.length },
  };

  /* v1.7.0: recent remediation operations — safe metadata only (no
     tokens, no auth, no push details; the redactor runs regardless). */
  try {
    const entities = new Set<string>();
    for (const incident of active) entities.add(incident.entity);
    const collected: NonNullable<SupportBundlePayload["remediationOperations"]> = [];
    for (const entity of Array.from(entities).slice(0, 10)) {
      for (const operation of operationsForEntity(entity, 3)) {
        collected.push({
          id: operation.id,
          entity: operation.entity,
          operation: operation.operation,
          state: operation.state,
          startedAt: operation.startedAt,
          message: operation.message ? operation.message.slice(0, 160) : null,
        });
      }
    }
    bundle.remediationOperations = collected.slice(0, 15);
  } catch {
    bundle.remediationOperations = [];
  }

  return redactValue(bundle);
}

/** Async variant that includes the persistence self-check + inventory
 *  diagnostics (both already sanitized/bounded upstream). */
export async function buildSupportBundleFull(): Promise<SupportBundlePayload> {
  const bundle = buildSupportBundle();
  try {
    const persistence = await getPersistenceHealth();
    bundle.persistence = {
      dataDirWritable: persistence.dataDirWritable,
      lastSuccessfulPersistAt: persistence.lastPersistAt,
      incidentsFileBytes: null,
      notificationsFileBytes: null,
    };
  } catch {
    // persistence probe failing is itself diagnostic; keep nulls honest
    bundle.persistence.dataDirWritable = null;
  }
  const saveError = lastIncidentsSaveError();
  if (saveError && bundle.recentSafeErrors.length < 10) {
    bundle.recentSafeErrors.push(`persistence: ${saveError.message.slice(0, 120)}`);
  }
  try {
    const { peekInventoryLkg } = await import("@/server/docker/updates");
    const lkg = peekInventoryLkg();
    bundle.inventoryDiagnostics = lkg
      ? redactValue({ containersTracked: lkg.containers.length, at: new Date(lkg.at).toISOString() })
      : null;
  } catch {
    bundle.inventoryDiagnostics = null;
  }
  return bundle;
}
