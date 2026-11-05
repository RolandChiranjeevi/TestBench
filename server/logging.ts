/**
 * Logger options for the server. The Authorization header (an API token) and the cookie (a login) are never written to the log, whatever
 * a log line holds: they are replaced before the line is written. Requests are not logged at the level in use (warn); this is the safety net
 * for the day a line does carry them.
 */
export const LOGGER_OPTIONS = {
  level: "warn",
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "headers.authorization", "headers.cookie"], censor: "[redacted]" },
};
