// main.ts — entrypoint: start the forge, announce it to the env, wait
// until the trial is over, then leave quietly.
//
// The lifecycle, step by step:
//   1. Read MAKEFUN_ENV_URL. With no env to talk to there is no trial,
//      so bail out with exit code 1 right away.
//   2. Build the app (app.ts) and listen on port 0, letting the kernel
//      pick a free port. Port 8080 belongs to the env — never bind it.
//   3. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register.
//      The first registration wins; a 409 just means somebody else won
//      first, and is not an error for us. A 400/405 means our request
//      itself is wrong, so stop. Anything else (env still starting,
//      network hiccup) is worth retrying.
//   4. Poll GET $MAKEFUN_ENV_URL/done. The env answers immediately with
//      {"done": false} while the suite is still running, so keep asking
//      until it says {"done": true}. Never exit early, and never hold a
//      request open waiting for the answer.
//   5. Shut the server down and exit 0.
//
// Retries back off exponentially (250 ms, doubling, capped at 2 s) and
// every env call gives up after 30 s. This file imports the app and
// nothing else from the entry; it makes no model calls.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Give up on one env call after this long, then treat it as a failure to retry. */
const CALL_BUDGET_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Pause after the `n`th failed attempt: exponential, capped. */
function backoffMs(n: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(n, 8));
}

/**
 * Tell the env which port we bound. Returns once the env has accepted the
 * registration (200) or tells us another entry registered first (409).
 * Throws on a 400/405 contract error; anything else is retried forever.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // A network error or a timeout: the env may still be starting.
    }
    await pause(backoffMs(attempt));
  }
}

/** Ask GET /done over and over until the env says the trial is finished. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the poll timed out: not done, so ask again.
    }
    await pause(backoffMs(attempt));
  }
}

/** The whole life of the process: bind, announce, wait, shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
