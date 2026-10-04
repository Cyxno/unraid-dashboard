import { z } from "zod";

/**
 * Runtime contract between the helper /inventory response and the
 * dashboard (v1.3.16). The dashboard previously trusted the response with
 * a blind cast — a helper regression could poison the update model with
 * silently-wrong shapes. This schema is validated on every fetch; failure
 * ⇒ inventory "unavailable" (degraded), never fabricated facts.
 *
 * Backward compatibility: required fields are exactly what v1.3.15
 * production helpers already send; anything NEW on the helper side must
 * be optional/additive here so old dashboards keep working and vice versa.
 */

export const helperContainerFactSchema = z.object({
  id: z.string().min(1),
  /** v1.3.13+ additive identity fields (helpers may omit them). */
  idShort: z.string().min(1).nullable().optional(),
  idFull: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  name: z.string().min(1),
  image: z.string().min(1),
  state: z.string(),
  status: z.string(),
  health: z.string().nullable().optional(),
  imageId: z.string().nullable().optional(),
  repoDigests: z.array(z.string()).default([]),
  created: z.string().nullable().optional(),
  networks: z.array(z.string()).optional(),
  volumeSources: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).default({}),
  unsupported: z.array(z.string()).optional(),
  externallyManaged: z.boolean().optional(),
  snapshotPresent: z.boolean().optional(),
});

export const helperInventorySchema = z.object({
  version: z.string().nullable().optional(),
  containers: z.array(helperContainerFactSchema),
  storage: z.object({
    mode: z.string(),
    source: z.string().nullable(),
  }),
  /** v1.3.13+ additive diagnostics. */
  diagnostics: z
    .object({
      totalContainers: z.number().optional(),
      inspectedContainers: z.number().optional(),
      inspectFailures: z.number().optional(),
      parseErrors: z.number().optional(),
      imageIdCoverage: z.number().optional(),
      repoDigestCoverage: z.number().optional(),
      labelCoverage: z.number().optional(),
      fullIdCoverage: z.number().optional(),
      partial: z.boolean().optional(),
      structurallyDegraded: z.boolean().optional(),
      chunks: z.number().optional(),
      durationMs: z.number().nullable().optional(),
      lastSuccessfulRefresh: z.string().nullable().optional(),
    })
    .optional(),
});

export type HelperInventory = z.infer<typeof helperInventorySchema>;
export type HelperContainerFact = z.infer<typeof helperContainerFactSchema>;

/** Human-readable summary of the first validation issues (no payloads). */
export function describeInventoryIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
