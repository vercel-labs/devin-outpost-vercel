> ## Documentation Index
> Fetch the complete documentation index at: https://docs.devin.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Devin Outposts

> Run Devin sessions on your own infrastructure

Outposts lets you run Devin sessions inside infrastructure you control — your own VMs, containers, Kubernetes clusters, or even a Mac Mini on your desk. Devin's agent loop (inference and planning) continues to run in Devin's cloud, while all command execution, file edits, and repository access happen on machines you operate.

Use Outposts when you need:

* Sessions to run inside your network, next to internal services, registries, and secrets
* Custom hardware profiles (e.g. GPUs, large memory machines, specific OS images)
* Existing dev box, VM, or Kubernetes infrastructure to host Devin workloads
* Enterprise controls over network access, build outputs, and monitoring

<Frame>
  <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/outposts-diagram.png?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=798dd3f1d9ce57eb530b1c6d7d9e5b4b" alt="Devin's agent loop and the outpost queue run in Devin Cloud; your machines — a GPU box in your lab, a VM in your VPC, or a Mac mini on your desk — serve sessions over an outbound-only connection" width="1242" height="758" data-path="images/onboard-devin/outposts/outposts-diagram.png" />
</Frame>

## How it works

An **outpost** is a named queue of Devin sessions to be served on your own machines. Once you register an outpost (e.g. `gpu-h200` or `dev-boxes`), it appears as a machine option in Devin Cloud alongside Ubuntu, Windows, etc. — Cloud sessions started on an outpost wait in its queue until one of your machines picks them up.

Every machine that serves sessions from an outpost is a **worker**. To turn a machine into a worker, install the [Devin CLI](/work-with-devin/devin-cli) and run:

```bash theme={null}
devin worker start --outpost=<outpost_name>
```

The worker opens an outbound connection to Devin's cloud and watches the outpost's queue. When a session is waiting, the worker claims it and executes its tool calls locally — every command, file edit, and repository operation runs on your machine. When the session ends, the worker goes back to watching the queue for the next session. Scaling out is just running the worker on more machines: N workers serve N concurrent sessions, and any further sessions wait in the queue until a worker becomes available.

Workers only need **outbound** HTTPS access. No inbound ports, public IPs, or VPN tunnels are required.

### Orchestration

Long-lived worker machines are the simplest setup, but with the Outposts API you can also write an **orchestrator**: software that watches the outpost's queue and, for each waiting session, spins up a fresh VM or container, starts the worker inside it, and tears the machine down when the session ends. See [Orchestration](/cloud/outposts/orchestration) to learn how, deploy [devin-outpost-k8s](https://github.com/CognitionAI/devin-outpost-k8s) — our open-source operator that runs the loop on any Kubernetes cluster — or run on a partner platform that already implements it for you (see [Integrations](#integrations)).

## Machine dependencies

Sessions execute directly on your machines, so the worker relies on tools you install there.

| Dependency           | Required | Used for                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git` (on `PATH`)    | Yes      | Cloning and all repository operations                                                                                                                                                                                                                                                                     |
| `ffmpeg` (on `PATH`) | No       | Devin's screen-recording features. Without it, sessions cannot record the screen.                                                                                                                                                                                                                         |
| Chrome or Chromium   | No       | Browser and computer-use features. The worker looks for Chrome in standard install locations by default; set `DEVIN_CHROME_PATH` in the worker's environment to the absolute path of the binary to override (e.g. `DEVIN_CHROME_PATH=/usr/bin/google-chrome`). Without it, browser tools are unavailable. |
| Passwordless `sudo`  | No       | Lets Devin install software it needs during a session (e.g. missing build tools or system packages). Only grant this when the machine is dedicated to Devin and recycled after each session — never on shared or long-lived machines.                                                                     |

## Get started

<CardGroup cols={2}>
  <Card title="Quickstart" icon="rocket" href="/cloud/outposts/quickstart">
    Create an outpost and serve sessions from a single machine with `devin worker start` — no orchestrator required.
  </Card>

  <Card title="Orchestration" icon="diagram-project" href="/cloud/outposts/orchestration">
    Scale to a fleet: poll the queue, claim sessions, provision machines, and run workers automatically.
  </Card>

  <Card title="Reference" icon="book" href="/cloud/outposts/reference">
    The full surface area: CLI commands and flags, fleet API endpoints, binary distribution, and the spawn contract.
  </Card>
</CardGroup>

## Integrations

Partner platforms implement the orchestration loop for you — sessions run on their infrastructure with no worker to run and no orchestrator to build. Each partner documents its own setup:

| Platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What you get                                                                                                                                                 | Docs                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/namespace.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=68efa1dc7c7fd54050b64dd78cac12eb" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="16" height="16" data-path="images/onboard-devin/outposts/logos/namespace.svg" /> Namespace          | First-class macOS environments on Apple silicon — with computer use, Devin builds, runs, and tests iOS apps end to end                                       | [Devin Outposts on Namespace](https://namespace.so/docs/devbox/devin)                                                   |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/modal.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=c4d687cff2da6b23ea3981b1265a07d0" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="16" height="16" data-path="images/onboard-devin/outposts/logos/modal.svg" /> Modal                                              | The same infrastructure you train and serve models on — reproduce failures and profile fixes on production hardware, scaling back to zero                    | [Devin Outposts on Modal](https://modal.com/docs/devin)                                                                 |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/nvidia.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=d8c579390aae20eaca2df6e54be32418" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="28" height="16" data-path="images/onboard-devin/outposts/logos/nvidia.svg" /> OpenShell                                  | A sandbox for every session via the OpenShell runtime — from a single VM to a GPU cluster, built for secure and government environments                      | [Devin Outposts on NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell#supported-agents)                              |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/nvidia.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=d8c579390aae20eaca2df6e54be32418" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="28" height="16" data-path="images/onboard-devin/outposts/logos/nvidia.svg" /> Brev                                       | GPU instances on NVIDIA Brev, deployed as a one-click Launchable                                                                                             | [Devin Outposts on NVIDIA Brev](https://brev.nvidia.com/launchable/deploy?launchableID=env-3Ge1ZXazlZQuJHfQed2od9IT8R5) |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/daytona.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=67c487847268e21d4b4c75fe01814d0f" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="15" height="16" data-path="images/onboard-devin/outposts/logos/daytona.svg" /> Daytona                            | Linux and Windows sandboxes that start in under 90 ms from snapshots — repos, dependencies, and toolchains already in place                                  | [Devin Outposts on Daytona](https://www.daytona.io/docs/en/guides/devin/devin-outposts/)                                |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/e2b.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=aee41e9fcae325e8f0fb06217f8d4f3b" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="36" height="10" data-path="images/onboard-devin/outposts/logos/e2b.svg" /> E2B                                                                | Agent machines at any CPU/RAM configuration with sub-second starts — including access to your private cloud                                                  | [Devin Outposts on E2B](https://e2b.dev/docs/agents/devin)                                                              |
| <img src="https://mintcdn.com/cognitionai/xlfcZs3jVVOLjL3w/images/onboard-devin/outposts/logos/cloudflare.svg?fit=max&auto=format&n=xlfcZs3jVVOLjL3w&q=85&s=621bf440c8f74760d0a4ee40d5fc432c" alt="" style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} noZoom width="28" height="13" data-path="images/onboard-devin/outposts/logos/cloudflare.svg" /> Cloudflare | An isolated sandbox per session, with traffic flowing through customizable proxies and private connectivity to internal services — no VPN or public exposure | [Devin Outposts on Cloudflare](https://developers.cloudflare.com/sandbox/tutorials/devin-outposts/)                     |

## Limitations

* Devin Outposts is available on all Pro, Max, and Teams accounts.
* Devin Outposts is also available on [Dedicated Tenant deployments](/enterprise/deployment/overview) but is off by default, since a few Devin features behave differently when agents run on customer-managed infrastructure. Your account team can go over the details and enable it.
* Outposts shifts significant infrastructure and operational responsibility to the customer. Teams must secure and operate their remote development VMs at scale, including provisioning, isolation, access controls, capacity management, monitoring, and recovery. For security-conscious customers, we recommend [Dedicated Tenant (Dedicated SaaS)](/enterprise/deployment/overview), which provides a customer-isolated environment with security and orchestration managed by Cognition.
