"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, GitBranch, Layers, Lock, RefreshCw, ShieldAlert } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Compose projects panel (v0.7.13): project-level view with read-only
 * update plans and the sequential project update. Pipeline-owned projects
 * are displayed for observability and can NEVER be mutated here.
 */

interface ProjectSummary {
  name: string;
  workingDir: string | null;
  configFiles: string[];
  pipelineOwned: boolean;
  healthState: "healthy" | "degraded" | "down" | "mixed" | "starting";
  serviceCount: number;
  services: Array<{
    container: string;
    service: string;
    image: string;
    state: string;
    health: string | null;
    risk: "LOW" | "MEDIUM" | "HIGH";
    updateStatus: string;
    managementType: string;
  }>;
  networks: string[];
  sharedVolumes: string[];
}

interface PlanStep {
  container: string;
  service: string;
  image: string;
  update_available: boolean;
  risk: string;
  depends_on: string[];
}

interface ProjectPlan {
  project: string;
  pipelineOwned: boolean;
  plan: {
    supported: boolean;
    unsupportedReason: string | null;
    order: PlanStep[];
    blocked: Array<{ container: string; service: string; reason: string }>;
    mutationAllowed: boolean;
    rollbackReady: boolean;
    planHash: string;
  };
}

interface ProjectJob {
  job: {
    phase: string;
    detail?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    lastResult?: { result: string; services?: string[]; error?: string; durationMs?: number };
  } | null;
}

const HEALTH_TONE: Record<ProjectSummary["healthState"], string> = {
  healthy: "text-success",
  starting: "text-info",
  degraded: "text-warning",
  mixed: "text-warning",
  down: "text-danger",
};

export function ComposeProjectsPanel() {
  const projects = usePoll<{ available: boolean; reason?: string; projects: ProjectSummary[] }>("/api/docker/projects", 60_000);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [runningProject, setRunningProject] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);
  const [confirmProject, setConfirmProject] = useState<string | null>(null);

  // While a project update runs, poll its job status (2s) from an async
  // callback (same pattern as the container update machine poll).
  useEffect(() => {
    if (!runningProject) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/docker/project-update/status?project=${encodeURIComponent(runningProject)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const body = (await response.json()) as ProjectJob;
        if (cancelled) return;
        setJobPhase(body.job?.phase ?? "unknown");
        if (body.job?.finishedAt) {
          const result = body.job.lastResult?.result;
          if (result && result !== "success") {
            setRunError(body.job.lastResult?.error ?? `Project update ended: ${result}`);
          }
          setRunningProject(null);
          setJobPhase(null);
          projects.refresh();
        }
      } catch {
        // transient — next tick retries
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningProject, projects]);

  const loadPlan = useCallback(async (project: string) => {
    setPlanFor(project);
    setPlan(null);
    setPlanError(null);
    setPlanLoading(true);
    try {
      const response = await fetch(`/api/docker/projects/plan?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as ProjectPlan & { error?: string };
      if (!response.ok) {
        setPlanError(body.error ?? `Plan failed (HTTP ${response.status}).`);
      } else {
        setPlan(body);
      }
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Plan request failed.");
    } finally {
      setPlanLoading(false);
    }
  }, []);

  const startProjectUpdate = useCallback(
    async (project: string, planHash: string) => {
      setRunError(null);
      setConfirmProject(null);
      setRunningProject(project);
      try {
        const response = await fetch("/api/docker/project-update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, confirm: "yes", planHash }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setRunError(body.error ?? `Project update failed (HTTP ${response.status}).`);
          setRunningProject(null);
        }
      } catch (error) {
        setRunError(error instanceof Error ? error.message : "Project update failed.");
        setRunningProject(null);
      }
    },
    [],
  );

  const data = projects.data;
  const list = data?.projects ?? [];

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="size-4 text-muted-foreground" aria-hidden />
          Compose projects
          <Badge variant="secondary" className="text-[10px]">
            {list.length}
          </Badge>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={projects.refresh} disabled={projects.loading} aria-label="Refresh projects">
          <RefreshCw className={cn("size-4", projects.loading && "animate-spin")} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {projects.error && !data && <p className="text-sm text-danger">{projects.error}</p>}
        {!data && !projects.error && (
          <div className="space-y-2" role="status" aria-label="Loading projects">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        {data && !data.available && <p className="text-sm text-muted-foreground">{data.reason}</p>}
        {data && data.available && list.length === 0 && (
          <p className="text-sm text-muted-foreground">No compose projects detected.</p>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {list.map((project) => (
            <div key={project.name} className="min-w-0 overflow-hidden rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", HEALTH_TONE[project.healthState])} aria-hidden />
                  <span className="truncate font-medium">{project.name}</span>
                  {project.pipelineOwned && (
                    <Badge variant="warning" className="gap-1 text-[10px]">
                      <Lock className="size-3" aria-hidden /> pipeline-owned
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[10px]">
                    {project.serviceCount} services
                  </Badge>
                  {!project.pipelineOwned && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => loadPlan(project.name)} disabled={planLoading}>
                      Plan update
                    </Button>
                  )}
                </div>
              </div>

              {project.pipelineOwned ? (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  Managed by external deployment pipeline — the dashboard detects update state but never mutates this
                  project.
                </p>
              ) : (
                <p className="mt-2 truncate text-xs text-muted-foreground" title={project.workingDir ?? undefined}>
                  {project.workingDir ?? "working dir unknown"}
                  {project.networks.length > 0 ? ` · nets: ${project.networks.slice(0, 3).join(", ")}` : ""}
                  {project.sharedVolumes.length > 0 ? ` · ${project.sharedVolumes.length} volume path(s)` : ""}
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-1">
                {project.services.map((service) => (
                  <Badge
                    key={service.container}
                    variant={service.risk === "HIGH" ? "destructive" : service.updateStatus === "UPDATE_AVAILABLE" ? "success" : "secondary"}
                    className="text-[10px]"
                    title={`${service.container} · ${service.image} · ${service.risk} risk · ${service.updateStatus}`}
                  >
                    {service.service}
                    {service.risk === "HIGH" ? " ⚑" : ""}
                  </Badge>
                ))}
              </div>

              {planFor === project.name && (
                <div className="mt-3 rounded-md border bg-muted/30 p-2.5 text-xs">
                  {planLoading && <p className="text-muted-foreground">Deriving plan…</p>}
                  {planError && <p className="text-danger">{planError}</p>}
                  {plan && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1 font-medium">
                          <GitBranch className="size-3.5" aria-hidden /> Update plan
                        </span>
                        <Badge variant={plan.plan.mutationAllowed ? "success" : "secondary"} className="text-[10px]">
                          {plan.plan.mutationAllowed ? "executable" : plan.plan.supported ? "read-only" : "unsupported"}
                        </Badge>
                      </div>
                      {!plan.plan.supported && (
                        <p className="mt-1 text-warning dark:text-warning">{plan.plan.unsupportedReason}</p>
                      )}
                      {plan.plan.supported && (
                        <>
                          {plan.plan.order.length > 0 ? (
                            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
                              {plan.plan.order.map((step) => (
                                <li key={step.container}>
                                  <span className="font-medium">{step.service}</span>
                                  <span className="text-muted-foreground">
                                    {" "}
                                    ({step.container}, {step.image.split("/").pop()?.split(":")[0]}
                                    {step.update_available ? ", update available" : ", up to date"}
                                    {step.depends_on.length > 0 ? `, after: ${step.depends_on.join(", ")}` : ""})
                                  </span>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <p className="mt-1 text-muted-foreground">Nothing to update — all services current or blocked.</p>
                          )}
                          {plan.plan.blocked.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5">
                              {plan.plan.blocked.map((entry) => (
                                <li key={entry.container} className="text-muted-foreground">
                                  <span className="font-medium">{entry.service}</span>: {entry.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="mt-1.5 text-muted-foreground">
                            Rollback {plan.plan.rollbackReady ? "ready" : "unproven (snapshot taken pre-mutation)"} ·
                            sequential, stops on first failure.
                          </p>
                          {plan.plan.mutationAllowed && plan.plan.order.length > 0 && (
                            <div className="mt-2 flex items-center gap-2">
                              {confirmProject === project.name ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    className="h-7 text-xs"
                                    onClick={() => startProjectUpdate(project.name, plan.plan.planHash)}
                                    disabled={runningProject !== null}
                                  >
                                    Confirm sequential update
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmProject(null)}>
                                    Cancel
                                  </Button>
                                </>
                              ) : (
                                <Button size="sm" className="h-7 text-xs" onClick={() => setConfirmProject(project.name)} disabled={runningProject !== null}>
                                  <Layers className="size-3.5" aria-hidden /> Start sequential update
                                </Button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {(runningProject || jobPhase) && (
          <p className="mt-3 flex items-center gap-2 text-sm" role="status">
            <RefreshCw className="size-4 animate-spin text-muted-foreground" aria-hidden />
            Project update <span className="font-medium">{runningProject}</span> — phase{" "}
            <code className="rounded bg-muted px-1">{jobPhase ?? "…"}</code>
          </p>
        )}
        {runError && (
          <p className="mt-2 break-words text-sm text-danger" role="alert">
            {runError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
