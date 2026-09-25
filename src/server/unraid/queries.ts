/**
 * GraphQL operations against the Unraid API.
 * Field names verified against `generated-schema.graphql` in the unraid/api
 * monorepo (Unraid 7.2+ built-in API).
 */

/** Server identity: owner username, OS version and uptime via services. */
export const SERVER_IDENTITY_QUERY = /* GraphQL */ `
  query ServerIdentity {
    owner {
      username
    }
    vars {
      name
      version
    }
    services {
      name
      uptime {
        timestamp
      }
    }
    online
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
    }
    info {
      cpu {
        brand
        cores
        threads
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
        autoStart
        isUpdateAvailable
      }
    }
  }
`;

export const NOTIFICATIONS_QUERY = /* GraphQL */ `
  query Notifications {
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
        formattedTimestamp
        timestamp
      }
    }
  }
`;
