# Routines: failures, retries and callbacks

A routine is a job a Boton runs on a schedule, by hand, or when a webhook starts it. Every run ends in the routine's **Run history** as succeeded, failed or skipped, and nothing is left looking as if it might still run.

## When a run fails or a restart cuts it off

- **Queued** runs (including webhook runs a sender got a 202 for) survive a restart and run afterwards, in order, with their trigger and payload.
- A **network error** in a scheduled or webhook run is retried by itself, `BOTONS_RUN_RETRIES` times with growing waits (the history shows when); a scheduled run's retries stop once its next slot is due.
- A **usage limit** holds the run, and the Boton's chat, until the reset; moving the Boton to another brain in its settings releases them to run there in a new session ([Brains](brains.md#moving-a-boton-to-another-brain)). Paused Botons, including a global pause, need to be resumed before work continues at reset or after a move. Botons never switches a Boton's brain by itself.
- A run that was **running** when the server stopped (past the drain budget, or a crash) is failed as *Interrupted by a restart*, with an error in the chat and a push unless the routine never notifies. It is not run again by itself, because it may have partly run.
- A scheduled slot that comes while the Boton is paused, at a usage limit or still busy with the previous run is **skipped**, with the reason; slots missed while the server was down fire once at the next start.
- A run still going at its **time limit** is stopped and failed as *Ran past its time limit*, marked `meta.timedOut` (with the limit), with an error in the chat and a push unless the routine never notifies. It is not retried by itself, because it may have partly run and would likely run as long again; it is listed to check, and its callback and `GET …/runs/<id>` say `timedOut: true`.

### Time limits

Each routine's limit is `BOTONS_TURN_TIMEOUT_MS` (20 minutes) unless the routine has a shorter one of its own (**Time limit** in its editor, `timeLimitMs` in the API, `botons routine update --time-limit 10m`); the server's setting caps it, so lowering that setting lowers every longer routine limit with it. The limit counts from when the run's agent process starts: time queued behind other work or setting up connectors doesn't count, and a retry in a new session (the first attempt found its session gone) gets what is left. Each network-error retry is a new attempt with the whole limit. Chat turns have the server's limit.

## Cancel

A queued or running run can be **cancelled** from its row in the run history, or from Runs to check while it waits to try again (`POST /api/runs/:id/cancel`, paired devices only, in the audit log). Only that run ends: a queued one never starts (one held to try again is not tried again), and a running one has its agent process stopped while the Boton's chat and its other runs carry on.

A cancelled run is failed with *Cancelled* and marked cancelled (`meta.cancelled`, with whether an attempt at it ran, a held one's earlier attempt included, and so it may have partly run). It is not retried by itself, pushes nothing, is not listed to check, and its callback and `GET …/runs/<id>` say `cancelled: true`. A run ended by the Boton's Stop or a pause is marked the same way. A run that finished before the cancel reached it keeps its own result, and so does one that reached its time limit first: it stays timed out even if the cancel came while its agent process was still exiting.

## Retry

Any failed run can be **retried** from its row in the run history (`POST /api/runs/:id/retry`, paired devices only). The retry is a new run with the same trigger, payload and headers, so a webhook run stays sandboxed, and the Boton is told the earlier run failed and may have partly run. A run is retried once; to try again, retry the newer run. Retries count toward the hourly run limits and are refused while the Boton is paused. A webhook sender that asks for the first run (`GET …/runs/<id>`) sees `retriedAs`, and a redelivery of the same delivery gets the retry instead of starting another run. Retries are in the audit log.

## Callbacks

A routine's **callback** (each finished run's result POSTed to its callback URL) is retried 3 times on errors and timeouts. A run's callback is recorded as owed in the same write that finishes the run, so one still being sent when the server stops or crashes is sent again at the next start, to the routine's callback URL then. Delivery is at-least-once: a receiver may get a result twice, and `X-Boton-Run` names the run.

Results waiting to be sent are kept even past the run history's 20 runs, up to 20 per routine; a run that finishes while 20 are still waiting (a receiver that stays down while runs keep finishing) records its result as not sent instead, and it is listed to resend. A callback that failed every retry can be **sent again** from the run's row once the receiver is fixed (`POST /api/runs/:id/callback`, paired devices only, in the audit log). Callbacks to private hosts need `BOTONS_CALLBACK_ALLOW` ([Configuration](configuration.md)).

## Runs to check

**Settings → Runs to check** lists, across every Boton, the runs that failed in the last 7 days and were not retried (test runs aside), each with its error and a Retry button; the runs waiting to try again by themselves, with when; and the runs whose result never reached the callback URL, with Send it again (`GET /api/runs/attention`, paired devices only). A retried run, or a result sent, leaves the list. `botons doctor` counts all three, and how many runs were interrupted by a restart.
