export type SecretName =
  | "BOT_TOKEN"
  | "DATABASE_URL"
  | "TRON_API_KEY"
  | "TRON_SIGNER_AUTH_TOKEN"
  | "TRON_SIGNER_PRIVATE_KEY"
  | "SECRET_PROVIDER_CREDENTIAL";

export interface SecretProvider {
  readonly name: string;

  getSecret(name: SecretName): Promise<string | undefined>;
}
