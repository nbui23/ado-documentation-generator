import pino, { type DestinationStream, type Logger } from "pino";

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    name: "agent-docs",
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "token",
        "accessToken",
        "authorization",
        "password",
        "secret",
        "content",
        "prompt",
        "quote",
        "*.token",
        "*.accessToken",
        "*.authorization",
        "*.password",
        "*.secret",
        "*.content",
        "*.prompt",
        "*.quote",
        "req.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      error(error: Error) {
        return { name: error.name };
      },
    },
  };
  return destination ? pino(options, destination) : pino(options, pino.destination(2));
}
