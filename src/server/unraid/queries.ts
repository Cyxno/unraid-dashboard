/**
 * GraphQL operations against the Unraid API.
 * Every field has been verified against the live API on Unraid 7.3.2
 * (introspection + test queries). Do not add fields without checking.
 */

export const IDENTITY_QUERY = /* GraphQL */ `
  query Identity {
    vars {
      name
      version
    }
    owner {
      username
    }
    services {
      name
      uptime {
        timestamp
      }
    }
  }
`;

export const METRICS_QUERY = /* GraphQL */ `
  query Metrics {
    metrics {
      cpu {
        percentTotal
      }
      memory {
        total
        used
        available
        percentTotal
      }
      network {
        name
        rxSec
        txSec
        bytesReceived
        bytesSent
        operstate
      }
    /* sensoren verhuisd naar de aparte traag-pollende query hieronder (standby-aware, 15 min TTL) */
    }
  }
`;

export const TEMPERATURE_QUERY = /* GraphQL */ `
  query Temperature {
    metrics {
      temperature {
        summary {
          hottest {
            current {
              value
            }
          }
          warningCount
          criticalCount
        }
        sensors {
          name
          type
          current {
            value
          }
          warning
          critical
        }
      }
    }
  }
`;

export const SYSTEM_QUERY = /* GraphQL */ `
  query SystemInfo {
    info {
      os {
        hostname
        distro
        kernel
        arch
        uefi
      }
      cpu {
        brand
        cores
        threads
        speed
      }
      memory {
        layout {
          size
        }
      }
      baseboard {
        manufacturer
        model
      }
      system {
        manufacturer
        model
        virtual
      }
    }
  }
`;

export const ARRAY_QUERY = /* GraphQL */ `
  query Array {
    array {
      state
      parityCheckStatus {
        status
        running
        progress
        errors
      }
      capacity {
        kilobytes {
          total
          used
          free
        }
      }
      disks {
        id
        name
        device
        status
        temp
        type
        fsType
        fsSize
        fsFree
        fsUsed
        color
      }
      caches {
        id
        name
        device
        status
        temp
        type
        fsType
        fsSize
        fsFree
        fsUsed
        color
      }
      parities {
        id
        name
        device
        status
        temp
        type
        color
      }
      boot {
        id
        name
        status
        fsType
        fsSize
        fsFree
        fsUsed
        color
      }
    }
  }
`;

export const DOCKER_QUERY = /* GraphQL */ `
  query Docker {
    docker {
      containers {
        id
        names
        image
        state
        status
        created
        autoStart
        isUpdateAvailable
        iconUrl
        webUiUrl
        labels
        ports {
          privatePort
          publicPort
          type
        }
      }
    }
  }
`;

export const NOTIFICATIONS_SUMMARY_QUERY = /* GraphQL */ `
  query NotificationSummary {
    notifications {
      overview {
        unread {
          info
          warning
          alert
        }
      }
      warningsAndAlerts {
        id
        title
        subject
        description
        importance
        type
        formattedTimestamp
      }
    }
  }
`;

export const NOTIFICATIONS_LIST_QUERY = /* GraphQL */ `
  query NotificationList($filter: NotificationFilter!) {
    notifications {
      list(filter: $filter) {
        id
        title
        subject
        description
        importance
        type
        formattedTimestamp
      }
    }
  }
`;

export const VMS_QUERY = /* GraphQL */ `
  query Vms {
    vms {
      domains {
        id
        name
        state
      }
    }
  }
`;

export const NETWORK_INTERFACES_QUERY = /* GraphQL */ `
  query NetworkInterfaces {
    networkInterfaces {
      name
      macAddress
      mtu
      speed
      duplex
      virtual
      operstate
      type
      ipAddress
      netmask
      gateway
      useDhcp
    }
  }
`;

/** Detail query for a single container view: full inspect-ish payload. */
export const DETAIL_QUERY = /* GraphQL */ `
  query ContainerDetail {
    docker {
      containers {
        id
        names
        image
        command
        state
        status
        created
        autoStart
        isUpdateAvailable
        iconUrl
        webUiUrl
        labels
        mounts
        networkSettings
        ports {
          privatePort
          publicPort
          type
        }
      }
    }
  }
`;

export const CONNECTION_PING_QUERY = /* GraphQL */ `
  query ConnectionPing {
    online
    me {
      name
      roles
    }
  }
`;

export const LOG_FILES_QUERY = /* GraphQL */ `
  query LogFiles {
    logFiles {
      name
      path
      size
      modifiedAt
    }
  }
`;

export const LOG_FILE_QUERY = /* GraphQL */ `
  query LogFile($path: String!, $lines: Int, $startLine: Int) {
    logFile(path: $path, lines: $lines, startLine: $startLine) {
      path
      totalLines
      startLine
      content
    }
  }
`;

/** Lightweight docker state sampling for the SSE pipeline. */
export const DOCKER_STATE_QUERY = /* GraphQL */ `
  query DockerState {
    docker {
      containers {
        id
        names
        state
      }
    }
  }
`;
