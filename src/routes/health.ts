import type { FastifyInstance } from "fastify";

type ProbeResult = "ok" | "down" | "skipped";

/**
 * Races a probe against a hard timeout so health endpoints never hang.
 * `onTimeout` lets the caller cancel the underlying operation — without it, a
 * stalled SELECT would keep its pool connection checked out long after the
 * probe "finished".
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

async function probe(app: FastifyInstance): Promise<{ db: ProbeResult; redis: ProbeResult }> {
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
  return { db, redis };
}

/**
 * Health endpoints (spec §2.6). No auth, no app key.
 *
 * /healthz — liveness. Always HTTP 200 while the process is alive: a DB/Redis
 *   outage flips `status` to "degraded" but must NOT get the instance
 *   restarted (that would turn a dependency outage into a restart storm).
 *
 * /readyz — readiness. 200 only when every configured dependency answers, 503
 *   otherwise, so the load balancer stops routing to an instance that cannot
 *   serve requests and resumes when its dependencies return. Components without
 *   a configured URL report "skipped" and do not block readiness.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/healthz", async () => {
    const checks = await probe(app);
    return {
      status: checks.db === "down" || checks.redis === "down" ? "degraded" : "ok",
      checks,
    };
  });

  app.get("/readyz", async (_req, reply) => {
    const checks = await probe(app);
    const ready = checks.db !== "down" && checks.redis !== "down";
    void reply.header("cache-control", "no-store");
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });
}
