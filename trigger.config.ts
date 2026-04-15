import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_ldimmjkyevggdsmijhdy",
  runtime: "node",
  logLevel: "log",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2000,
      maxTimeoutInMs: 30000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
});
