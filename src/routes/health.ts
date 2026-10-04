import type { FastifyInstance } from "fastify";

type ProbeResult = "ok" | "down" | "skipped";

/**
 * Races a probe against a hard timeout so /healthz never hangs. `onTimeout`
 * lets the caller cancel the underlying operation — without it, a stalled
 * SELECT would keep its pool connection checked out long after the probe
 * "finished".
 */
async function withTimeout(
  p: Promise<unknown>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error("probe timeout"));
        }, timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness endpoint (spec §2.6). No auth, no app key.
 *
 * Always HTTP 200 while the process is alive — a DB/Redis outage flips
 * `status` to "degraded" but must NOT get the instance restarted (that would
 * turn a dependency outage into a restart storm). Components without a
 * configured URL report "skipped".
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/healthz", async () => {
    let dbProbe: Promise<ProbeResult>;
    if (app.pgSql) {
      const query = app.pgSql`SELECT 1`;
      dbProbe = withTimeout(query.then(() => undefined), 1000, () => {
        query.cancel();
      });
    } else {
      dbProbe = Promise.resolve<ProbeResult>("skipped");
    }

    const redisProbe: Promise<ProbeResult> = app.redis
      ? withTimeout(app.redis.ping(), 1000)
      : Promise.resolve<ProbeResult>("skipped");

    const [db, redis] = await Promise.all([dbProbe, redisProbe]);

    return {
      status: db === "down" || redis === "down" ? "degraded" : "ok",
      checks: { db, redis },
    };
  });
}
