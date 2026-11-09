# HTTP API reference

The web app talks to the server over a JSON API under `/api`. These are the endpoints the docs describe, for scripts and for checking what the app does. Unless noted, each needs a paired device's token, and Boton tokens are refused. The contract between server and web app is `shared/types.ts`.

| Endpoint | What it does | Described in |
| --- | --- | --- |
| `GET /api/health` | 200 when the database, the scheduler and at least one CLI work, else 503 with what failed (details for paired devices) | [operations.md](../operations.md#health-and-logs) |
| `GET /api/events` | The server-sent event stream every page listens to (`sidebar.updated`, `message.updated`, …) | [access.md](../access.md#https-for-the-whole-app) |
| `GET /api/operations` | Health, push, disk and backup status, without paths or error text | [backups.md](../backups.md#health-and-backups-in-settings) |
| `POST /api/backups/rehearse` | Rehearse restoring a backup (`latest` or a name) | [backups.md](../backups.md#rehearse-a-restore) |
| `GET /api/logs` | Known server events (`level`, `q`, `botons`, `before`) | [operations.md](../operations.md#server-events) |
| `GET /api/audit` | The audit log | [using-botons.md](../using-botons.md#what-each-boton-may-do-and-the-audit-log) |
| `GET /api/providers` | Brains and their `readiness` (`?recheck=1` checks again) | [brains.md](../brains.md#readiness) |
| `POST /api/bots/:id/switch-preview` | Preview moving a Boton to another brain | [brains.md](../brains.md#moving-a-boton-to-another-brain) |
| `GET /api/bots/:id/connector-notices` | Connectors a Boton's turns went without, and why | [connectors.md](../connectors.md#every-connector-is-botons-own) |
| `GET`, `PUT /api/bots/:id/spending` | A Boton's spending caps on an API key | [api-keys.md](../api-keys.md#botons-on-an-api-key) |
| `POST`, `DELETE /api/bots/:id/messages/:messageId/reactions[/:emoji]` | React to a Boton's message, or take it off | [using-botons.md](../using-botons.md#reactions) |
| `GET /api/reactions/export`, `POST /api/reactions/import` | Reactions as a file of their own | [using-botons.md](../using-botons.md#reactions) |
| `GET /api/sidebar` and `/api/sidebar/…` | The sidebar's groups, pins and order | [using-botons.md](../using-botons.md#the-sidebar) |
| `GET /api/sidebar/export`, `POST /api/sidebar/import` | The sidebar layout as a file of its own | [using-botons.md](../using-botons.md#the-sidebar) |
| `POST /api/runs/:id/cancel`, `/retry`, `/callback` | Cancel or retry a run, or send its callback again | [routines.md](../routines.md) |
| `GET /api/runs/attention` | Runs to check | [routines.md](../routines.md#runs-to-check) |
| `GET`, `PUT /api/connectors/:id/access` | Which Botons have a connector | [connectors.md](../connectors.md#connect-a-service) |
| `POST /api/connectors/:id/test` | Test a connector by listing its tools | [connectors.md](../connectors.md#test) |
| `GET /api/api-keys`, `PUT`, `DELETE /api/api-keys/:provider`, `POST /api/api-keys/:provider/test` | Saved API keys | [api-keys.md](../api-keys.md#api-keys) |
| `GET /api/config/export` | Your configuration, without secrets | [backups.md](../backups.md#moving-your-configuration-to-another-server) |
| `POST /api/config/import/preview`, `POST /api/config/import` | Preview and import a configuration | [backups.md](../backups.md#moving-your-configuration-to-another-server) |

Webhooks are served under `/hooks`, on the app's port and, if set, on `BOTONS_HOOKS_PORT` alone ([Configuration](../configuration.md)). OAuth sign-ins come back to `/oauth/callback` ([Connectors](../connectors.md#the-https-callback)).
