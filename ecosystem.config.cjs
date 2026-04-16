// ============================================================================
// ecosystem.config.cjs — PM2 process supervisor config
// ----------------------------------------------------------------------------
// Keeps the orchestrator + dashboard alive across crashes, droplet reboots,
// and unhandled errors. Designed for a single droplet deployment; the same
// config works on Windows for dev smoke-tests via `pm2 start ecosystem.config.cjs`.
//
// Install PM2 globally: `pnpm add -g pm2`
//
// Core commands:
//   pm2 start ecosystem.config.cjs        # start both apps
//   pm2 start ecosystem.config.cjs --only headcount-orchestrator
//   pm2 logs headcount-orchestrator       # tail stdout/stderr
//   pm2 status                            # see uptime, restart count, memory
//   pm2 reload all                        # zero-downtime reload after deploy
//   pm2 save                              # persist current process list
//   pm2 startup                           # generate systemd/launchd script to
//                                         # auto-start PM2 on boot (Linux/Mac)
//
// Restart strategy:
//   - max_memory_restart: hard ceiling before PM2 recycles the process
//   - restart_delay: backoff on crash-loops to avoid CPU-thrashing
//   - max_restarts + min_uptime: 10 restarts within 60s → PM2 stops trying
//     and the process stays down (forces human attention, not silent recovery)
// ============================================================================

module.exports = {
  apps: [
    {
      name: "headcount-orchestrator",
      cwd: "./apps/orchestrator",
      // Skip pnpm wrapper — call node directly with tsx's CLI entry. This
      // avoids PM2's known Windows .cmd-shim problems and is also faster on
      // Linux (no pnpm process in the middle).
      script: "node",
      args: "./node_modules/tsx/dist/cli.mjs src/index.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: 60_000,
      kill_timeout: 10_000, // let SIGINT handlers finish
      env: {
        NODE_ENV: "production",
      },
      // Structured logs ship cleaner when stdout + stderr are separate.
      // Session 2 will swap console.log for a proper structured logger that
      // writes to these files; Session 1 just captures the raw stream.
      error_file: "./logs/orchestrator.error.log",
      out_file: "./logs/orchestrator.out.log",
      combine_logs: false,
      time: true, // prepend timestamp to each line
    },
    {
      name: "headcount-dashboard",
      cwd: "./apps/dashboard",
      // Same pattern: call node + the next CLI script directly to avoid
      // pnpm/cmd-shim troubles. Requires `pnpm build` to have produced .next/.
      script: "node",
      args: "./node_modules/next/dist/bin/next start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: 60_000,
      kill_timeout: 5_000,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      error_file: "./logs/dashboard.error.log",
      out_file: "./logs/dashboard.out.log",
      combine_logs: false,
      time: true,
    },
  ],
};
