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

  it("accepts a fully valid production-shaped config", () => {
    const env = loadEnvFrom({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@db:5432/tplace",
      REDIS_URL: "redis://cache:6379",
      JWT_SIGNING_KEY: "a".repeat(64),
      STREAM_TOKEN_SECRET: "b".repeat(64),
      MEDIA_BASE_URL: "https://media.example.com",
      APP_KEYS: "prod-key-1,prod-key-2",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.appKeys).toHaveLength(2);
  });
});
