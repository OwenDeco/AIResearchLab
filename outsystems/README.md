# OutSystems Module — ONE2026

## What is this?

`ONE2026.oml` is the OutSystems Module file for the **ONE2026** application — the OutSystems side of the AI Research Lab integration.

It is built with **OutSystems 13 (ODC)** and was created as demo material for the ONE 2026 event.

## What it does

The module implements the OutSystems half of the **OS Debate Room** feature:

| Component | Description |
|---|---|
| **StartDebate REST API** | `POST /OSAgent/StartDebate` — receives a debate topic, round count, session ID, and optional `finished` flag from the lab backend, then orchestrates the multi-agent debate flow |
| **Host agent** | OutSystems AI agent that opens, moderates, and closes the debate |
| **Optimist agent** | AI agent arguing the pro side of the debate topic |
| **Critic agent** | Calls back to the lab's A2A endpoint (`POST /api/os-debate/a2a`) to generate the critical counterargument using the local LLM |
| **Turn push** | Each agent pushes its turn to the lab backend via `POST /api/os-debate/turn` |
| **Closing flow** | When `finished: true` is passed to `StartDebate`, the host returns a single closing statement instead of running a full round |

## How to use

1. Open **OutSystems Service Studio** (ODC version compatible with OutSystems 13)
2. Go to **File → Open Module from File**
3. Select `ONE2026.oml`
4. Configure the REST API consumer to point to your lab backend:
   - Base URL: your ngrok tunnel URL or `http://localhost:8002`
   - The A2A connection should point to `<base>/api/os-debate/a2a`
5. Publish the module to your ODC environment

## Environment connection

The module calls two endpoints on the AI Research Lab backend:

| Direction | URL | Purpose |
|---|---|---|
| OS → Lab | `POST <base>/api/os-debate/turn` | Push a debate turn (host / optimist / critic) |
| OS → Lab | `POST <base>/api/os-debate/a2a` | Trigger the local critical agent (A2A) |
| Lab → OS | `POST <os-env>/ONE2026/rest/OSAgent/StartDebate` | Start or continue a debate round |

Set `OS_DEBATE_ENDPOINT`, `OS_API_USERNAME`, and `OS_API_PASSWORD` in `backend/.env` to match your ODC environment credentials.
