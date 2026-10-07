// Copy to public/config.js (development) or let the container entrypoint
// write it from environment variables (production). Loaded by index.html
// before the application bundle, so the same build runs against any backend.
window.__TP_CONFIG__ = {
  // Origin of the Third Place backend API, without a trailing slash and
  // without the /api/v1 path. Must list the console's origin in CORS_ORIGINS.
  apiBaseURL: "https://api.example.com",

  // One of the backend's APP_KEYS. Sent as X-App-Key on public catalog reads.
  appKey: "replace-me",
};
