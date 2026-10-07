import { describe, expect, it } from "vitest";
import { loadEnvFrom } from "../src/config/env.js";

describe("loadEnvFrom", () => {
  it("applies defaults on an empty source", () => {
    const env = loadEnvFrom({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.ACCESS_TOKEN_TTL_SEC).toBe(900);
    expect(env.appKeys).toEqual([]);
  });

  it("parses and trims APP_KEYS, dropping empties", () => {
    const env = loadEnvFrom({ APP_KEYS: " key-a , key-b ,, " });
    expect(env.appKeys).toEqual(["key-a", "key-b"]);
  });

  it("treats empty-string vars as unset (env-file placeholders)", () => {
    const env = loadEnvFrom({ JWT_SIGNING_KEY: "", MEDIA_BASE_URL: "", DATABASE_URL: "" });
    expect(env.JWT_SIGNING_KEY).toBeUndefined();
    expect(env.MEDIA_BASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("fails fast with a readable message on invalid values", () => {
    expect(() => loadEnvFrom({ PORT: "not-a-port" })).toThrow(/Invalid environment configuration/);
    expect(() => loadEnvFrom({ JWT_SIGNING_KEY: "too-short" })).toThrow(/JWT_SIGNING_KEY/);
    expect(() => loadEnvFrom({ DATABASE_URL: "not a url" })).toThrow(/DATABASE_URL/);
  });

  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db:5432/tplace",
    REDIS_URL: "redis://cache:6379",
    JWT_SIGNING_KEY: "a".repeat(64),
    STREAM_TOKEN_SECRET: "b".repeat(64),
    MEDIA_BASE_URL: "https://media.example.com",
    APP_KEYS: "prod-key-1,prod-key-2",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_MEDIA: "tplace-media",
  };

  it("accepts a fully valid production config", () => {
    const env = loadEnvFrom(production);
    expect(env.NODE_ENV).toBe("production");
    expect(env.appKeys).toHaveLength(2);
  });

  it("refuses to boot production without each of its dependencies", () => {
    for (const key of [
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_SIGNING_KEY",
      "APP_KEYS",
      "MEDIA_BASE_URL",
      "STREAM_TOKEN_SECRET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_MEDIA",
    ]) {
      const { [key]: _dropped, ...without } = production as Record<string, string>;
      expect(() => loadEnvFrom(without), key).toThrow(new RegExp(`${key}: required when NODE_ENV=production`));
      // An empty placeholder from an env file counts as missing.
      expect(() => loadEnvFrom({ ...production, [key]: "" }), key).toThrow(/required when NODE_ENV=production/);
    }
  });

  it("requires an R2 endpoint or account id in production", () => {
    const { R2_ACCOUNT_ID: _acct, ...without } = production;
    expect(() => loadEnvFrom(without)).toThrow(/R2_ENDPOINT or R2_ACCOUNT_ID/);
    expect(() => loadEnvFrom({ ...without, R2_ENDPOINT: "http://minio:9000" })).not.toThrow();
  });

  it("leaves development and test runs free to omit dependencies", () => {
    expect(() => loadEnvFrom({ NODE_ENV: "development" })).not.toThrow();
    expect(() => loadEnvFrom({ NODE_ENV: "test" })).not.toThrow();
  });

  it("keeps registration closed and email in the log by default", () => {
    const env = loadEnvFrom({});
    expect(env.registrationOpen).toBe(false);
    expect(env.MAIL_TRANSPORT).toBe("log");
    expect(env.corsOrigins).toEqual([]);
    expect(loadEnvFrom({ REGISTRATION_OPEN: "true" }).registrationOpen).toBe(true);
    expect(() => loadEnvFrom({ REGISTRATION_OPEN: "yes" })).toThrow(/REGISTRATION_OPEN/);
  });

  it("production with registration open must deliver email for real", () => {
    expect(() => loadEnvFrom({ ...production, REGISTRATION_OPEN: "true" })).toThrow(/MAIL_TRANSPORT/);
    expect(() =>
      loadEnvFrom({ ...production, REGISTRATION_OPEN: "true", MAIL_TRANSPORT: "smtp" }),
    ).toThrow(/SMTP_URL/);
    expect(() =>
      loadEnvFrom({
        ...production,
        REGISTRATION_OPEN: "true",
        MAIL_TRANSPORT: "smtp",
        SMTP_URL: "smtps://user:pass@smtp.example:465",
        MAIL_FROM: "Third Place <no-reply@3rd-place.co.jp>",
        ACCOUNT_LINKS_BASE_URL: "https://console.3rd-place.co.jp",
      }),
    ).not.toThrow();
  });
});

describe("loadEnvFrom strict: false", () => {
  it("lets single-purpose tooling run in production with only what it needs", () => {
    const env = loadEnvFrom(
      { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db:5432/tplace" },
      { strict: false },
    );
    expect(env.NODE_ENV).toBe("production");
    expect(env.REDIS_URL).toBeUndefined();
  });
});
