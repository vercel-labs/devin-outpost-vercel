/**
 * Minimal client for the Devin Outposts fleet API.
 * Contract: https://docs.devin.ai/cloud/outposts/reference (mirrored in
 * research/outposts-reference.md). All endpoints live under
 * `/opbeta/outposts/` and take a bearer token.
 */

export type SessionStatus = "pending" | "running" | "suspended" | "terminated";
export type QueuePhase = "pending" | "claimed";

export interface NetworkPolicyRule {
  hostname?: string;
  ipv4?: string;
  ipv6?: string;
}

export interface QueueEntry {
  metadata: {
    session_id: string;
    outpost_id: string;
    created_at: number;
    updated_at: number;
  };
  spec: {
    kind: "new" | "resume";
    platform: string;
    remote_binary_sha: string | null;
    network_policy?: { enabled: boolean; allow: NetworkPolicyRule[] };
  };
  status: {
    phase: QueuePhase;
    acceptor_id: string | null;
    claim_deadline: number | string | null;
    session_status: SessionStatus;
    /** Only present on a successful claim response. */
    connect_token?: string;
    /** Only present on a successful claim response. */
    gateway_url?: string;
  };
}

interface ListResponse {
  items: QueueEntry[];
  cursor: string;
  has_next_page: boolean;
  total: number;
}

/** Another worker won the atomic claim CAS (HTTP 409). Normal operation. */
export class ClaimLostError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was claimed by another worker`);
    this.name = "ClaimLostError";
  }
}

export class DevinFleetClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${this.apiUrl}/opbeta/outposts${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * List pending sessions for an outpost, following cursor pagination.
   * Delivery is at-least-once: entries are deduped by session_id.
   */
  async listPending(outpostId: string): Promise<QueueEntry[]> {
    const seen = new Map<string, QueueEntry>();
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ outpost: outpostId, phase: "pending" });
      if (cursor) params.set("cursor", cursor);
      const res = await this.request("GET", `/devins?${params}`);
      if (!res.ok) {
        throw new Error(`List queue failed: ${res.status} ${await res.text()}`);
      }
      const page = (await res.json()) as ListResponse;
      for (const entry of page.items) seen.set(entry.metadata.session_id, entry);
      if (!page.has_next_page) return [...seen.values()];
      cursor = page.cursor;
    }
  }

  /** Get one queue entry; null when the entry no longer exists. */
  async getEntry(sessionId: string): Promise<QueueEntry | null> {
    const res = await this.request("GET", `/devins/${sessionId}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Get queue entry failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as QueueEntry;
  }

  /**
   * Atomically claim a session. Success returns the entry carrying
   * status.connect_token and status.gateway_url; a 409 raises ClaimLostError.
   */
  async claim(sessionId: string, acceptorId: string): Promise<QueueEntry> {
    const res = await this.request("POST", `/devins/${sessionId}/claim`, {
      acceptor_id: acceptorId,
    });
    if (res.status === 409) throw new ClaimLostError(sessionId);
    if (!res.ok) {
      throw new Error(`Claim failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as QueueEntry;
  }

  /** Release a claim so the session returns to the queue immediately. */
  async release(sessionId: string, acceptorId: string): Promise<void> {
    const res = await this.request("POST", `/devins/${sessionId}/release`, {
      acceptor_id: acceptorId,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Release failed: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * Resolve the devin-remote git SHA to run: the session's pinned
 * spec.remote_binary_sha when present, otherwise the latest published SHA.
 */
export async function resolveRemoteSha(
  staticBaseUrl: string,
  pinnedSha: string | null,
): Promise<string> {
  if (pinnedSha) return pinnedSha;
  const res = await fetch(`${staticBaseUrl}/latest_linux_x64`);
  if (!res.ok) {
    throw new Error(`Failed to resolve latest devin-remote SHA: ${res.status}`);
  }
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) {
    throw new Error(`Unexpected SHA from latest_linux_x64: ${JSON.stringify(sha)}`);
  }
  return sha;
}
