#!/usr/bin/env bun
const ca = "/etc/fleet/ca/fleet-lab-root.pem";
if (!process.env.NODE_EXTRA_CA_CERTS && (await Bun.file(ca).exists())) {
  process.execve!(
    process.execPath,
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      import.meta.path,
      ...process.argv.slice(2),
    ],
    { ...process.env, NODE_EXTRA_CA_CERTS: ca },
  );
}

// Load command dependencies only after restarting with the CA environment.
await import("./commands.ts");
