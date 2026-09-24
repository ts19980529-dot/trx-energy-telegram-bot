export type RuntimeRole = "bot" | "signer";

export function resolveRuntimeRole(
  env: NodeJS.ProcessEnv,
): RuntimeRole {
  const configured = env.TRX_RUNTIME_ROLE?.trim().toLowerCase();

  if (configured !== undefined && configured !== "") {
    if (configured === "bot" || configured === "signer") {
      return configured;
    }
    throw new Error("TRX_RUNTIME_ROLE must be bot or signer");
  }

  return env.RAILWAY_SERVICE_NAME?.trim() === "tron-signer"
    ? "signer"
    : "bot";
}
