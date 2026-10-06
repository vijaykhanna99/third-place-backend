/**
 * Application error type. Every intentionally returned error in the API is an
 * AppError; the global error handler converts it to the spec's error shape:
 *
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Anything that is NOT an AppError is treated as an unexpected 500 and its
 * details are logged but never leaked to the client.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Common constructors, so codes stay consistent across modules (spec §2.3).
export const errors = {
  validationFailed: (message = "Request validation failed") =>
    new AppError(400, "validation_failed", message),
  unauthenticated: (message = "Authentication required") =>
    new AppError(401, "unauthenticated", message),
  invalidToken: (message = "Invalid or expired token") =>
    new AppError(401, "invalid_token", message),
  forbidden: (message = "Forbidden") => new AppError(403, "forbidden", message),
  appKeyRequired: (message = "Missing or invalid app key") =>
    new AppError(403, "app_key_required", message),
  registrationClosed: (message = "Registration is not open") =>
    new AppError(403, "registration_closed", message),
  notFound: (message = "Resource not found") => new AppError(404, "not_found", message),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  rateLimited: (message = "Too many requests") => new AppError(429, "rate_limited", message),
  internal: (message = "Internal server error") => new AppError(500, "internal_error", message),
  /** A dependency (queue, object storage) is down; the same request can be retried later. */
  unavailable: (message = "Service temporarily unavailable") =>
    new AppError(503, "service_unavailable", message),
} as const;
