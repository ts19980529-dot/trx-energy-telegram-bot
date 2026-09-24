import { resolveRuntimeRole } from "./runtime-role.js";

async function main(): Promise<void> {
  const role = resolveRuntimeRole(process.env);

  if (role === "signer") {
    await import("./signer-start.js");
    return;
  }

  await import("./start.js");
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(`Runtime bootstrap failed: ${errorName}`);
  process.exitCode = 1;
});
