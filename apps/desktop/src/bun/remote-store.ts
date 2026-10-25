// The Mac's device identity moved to core, so the CLI reaches cloud
// workspaces as the same Mac the phone pairs with.
export {
  type AuditEntry,
  defaultVault,
  type DeviceSecrets,
  excludeFromBackups,
  KeychainVault,
  type PairedPhone,
  RemoteAudit,
  RemoteStore,
  type SecretVault,
} from "@daedalus/core";
