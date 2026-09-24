import { once } from "node:events";

import { createPostgresResource } from "../adapters/database/postgres.js";
import { PostgresTronDelegationSigner } from "../adapters/signer/postgres-tron-delegation-signer.js";
import { PostgresTronReclaimSigner } from "../adapters/signer/postgres-tron-reclaim-signer.js";
import { parseSignerRuntimeConfig } from "./signer-config.js";
import { createSignerHttpServer } from "./signer-http-server.js";
import {
  createSecretProvider,
  loadSignerRuntimeSecrets,
} from "./secret-provider.js";

async function main(): Promise<void> {
  const config = parseSignerRuntimeConfig(process.env);
  const secretProvider = createSecretProvider(
    config.secretProvider,
    process.env,
  );

  if (secretProvider.name !== config.secretProvider) {
    throw new Error("SecretProvider configuration mismatch");
  }

  const secrets = await loadSignerRuntimeSecrets(
    secretProvider,
    process.env,
  );
  const postgres = createPostgresResource(secrets.databaseUrl);

  try {
    await postgres.ping();
    await postgres.assertSchemaReady();

    const signer = new PostgresTronDelegationSigner(
      postgres.db,
      config.ownerAddress,
      secrets.privateKey,
    );
    const reclaimSigner = new PostgresTronReclaimSigner(
      postgres.db,
      config.ownerAddress,
      secrets.privateKey,
    );
    const server = createSignerHttpServer({
      signer,
      reclaimSigner,
      authToken: secrets.authToken,
    });

    server.listen(config.port, "::");
    await once(server, "listening");

    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      server.close();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    console.info("TRON signer runtime initialized");

    try {
      await once(server, "close");
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await postgres.close();
  }
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(`Signer startup failed: ${errorName}`);
  process.exitCode = 1;
});
