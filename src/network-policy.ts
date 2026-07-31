import type { NetworkPolicy } from "@vercel/sandbox";
import type { QueueEntry } from "./devin.js";

type DevinNetworkPolicy = NonNullable<QueueEntry["spec"]["network_policy"]>;

function cidr(address: string, bits: 32 | 128): string {
  return address.includes("/") ? address : `${address}/${bits}`;
}

/**
 * Translate Devin's effective allowlist into the equivalent Sandbox firewall
 * policy. An enabled policy with no destinations intentionally denies all
 * egress.
 */
export function toSandboxNetworkPolicy(
  policy: DevinNetworkPolicy | undefined,
): NetworkPolicy {
  if (!policy?.enabled) return "allow-all";

  const domains = new Set<string>();
  const subnets = new Set<string>();
  for (const rule of policy.allow) {
    if (rule.hostname) domains.add(rule.hostname);
    if (rule.ipv4) subnets.add(cidr(rule.ipv4, 32));
    if (rule.ipv6) subnets.add(cidr(rule.ipv6, 128));
  }

  if (domains.size === 0 && subnets.size === 0) return "deny-all";
  return {
    ...(domains.size > 0 ? { allow: [...domains] } : {}),
    ...(subnets.size > 0
      ? { subnets: { allow: [...subnets] } }
      : {}),
  };
}
