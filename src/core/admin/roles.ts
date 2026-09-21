export const adminRoles = [
  "SUPER_ADMIN",
  "ADMIN",
  "OPERATOR",
  "VIEWER",
] as const;

export type AdminRole = (typeof adminRoles)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (adminRoles as readonly string[]).includes(value);
}
