import type {
  DockerSummary,
  HealthLevel,
  HealthSummary,
  NotificationsSummary,
  Section,
  StorageUsage,
} from "@/lib/api-types";

/**
 * Derives a coarse health level from real conditions only.
 * No invented score: every non-healthy level comes with concrete reasons.
 */

export interface HealthInputs {
  storage: Section<StorageUsage>;
  docker: Section<DockerSummary>;
  notifications: Section<NotificationsSummary>;
  memoryPercent: number | null;
  temperatureCriticalCount: number | null;
}

/** Array states that are nominal; anything else deserves attention. */
const ARRAY_OK_STATES = new Set(["STARTED"]);
const DISK_OK_STATES = new Set(["DISK_OK", "DISK_NP", "DISK_DSBL_NP"]);

export function deriveHealth(inputs: HealthInputs): HealthSummary {
  const reasons: string[] = [];
  let level: Exclude<HealthLevel, null> = "healthy";

  const escalate = (next: Exclude<HealthLevel, null>, reason: string) => {
    reasons.push(reason);
    const rank = { healthy: 0, attention: 1, critical: 2 } as const;
    if (rank[next] > rank[level]) level = next;
  };

  // Array state
  const storage = inputs.storage.data;
  if (inputs.storage.status === "live" || inputs.storage.status === "stale") {
    if (storage) {
      if (!ARRAY_OK_STATES.has(storage.state)) {
        escalate(
          "critical",
          `Array state is ${storage.state.replaceAll("_", " ").toLowerCase()}`,
        );
      }
      for (const disk of storage.disks) {
        const brokenColor =
          disk.fsColor === "RED" || disk.fsColor === "RED_BALL";
        if (brokenColor || !DISK_OK_STATES.has(disk.state)) {
          escalate(
            "critical",
            `Disk ${disk.name} reports ${disk.state === "DISK_OK" ? disk.fsColor : disk.state.replaceAll("_", " ").toLowerCase()}`,
          );
          break; // one reason per category is enough
        }
      }
      if (storage.parityStatus === "FAILED") {
        escalate("critical", "Parity check failed");
      }
    }
  }

  // Notifications: alerts are critical, warnings are attention
  const notifications = inputs.notifications.data;
  if (notifications) {
    if (notifications.unreadCounts.alert > 0) {
      escalate(
        "critical",
        `${notifications.unreadCounts.alert} alert notification(s)`,
      );
    } else if (notifications.unreadCounts.warning > 0) {
      escalate(
        "attention",
        `${notifications.unreadCounts.warning} warning notification(s)`,
      );
    }
  }

  // Containers
  const docker = inputs.docker.data;
  if (docker) {
    const unhealthy = docker.containers.filter(
      (container) => container.health === "unhealthy",
    );
    if (unhealthy.length > 0) {
      escalate(
        "critical",
        `Container(s) unhealthy: ${unhealthy.slice(0, 3).map((container) => container.name).join(", ")}`,
      );
    }
    const exited = docker.containers.filter(
      (container) =>
        container.state === "EXITED" && container.autoStart,
    );
    if (exited.length > 0) {
      escalate(
        "attention",
        `Autostart container(s) stopped: ${exited.slice(0, 3).map((container) => container.name).join(", ")}`,
      );
    }
  }

  // Resource pressure
  if (inputs.memoryPercent !== null) {
    if (inputs.memoryPercent >= 95) {
      escalate("critical", `Memory at ${Math.round(inputs.memoryPercent)}%`);
    } else if (inputs.memoryPercent >= 90) {
      escalate("attention", `Memory at ${Math.round(inputs.memoryPercent)}%`);
    }
  }

  // Temperature
  if (inputs.temperatureCriticalCount !== null && inputs.temperatureCriticalCount > 0) {
    escalate(
      "critical",
      `${inputs.temperatureCriticalCount} temperature sensor(s) past critical threshold`,
    );
  }

  return { level, reasons };
}
