import { resolve } from "node:path";
import { loadConfig, type DaedalusConfig } from "../config";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";

export interface ApplicationContext {
  config: DaedalusConfig;
  logger: JsonLogger;
}

export async function createApplicationContext(
  migrationsDirectory = resolve(import.meta.dir, "../../../../migrations"),
): Promise<ApplicationContext> {
  const config = await loadConfig();
  await runMigrations(config.databasePath, migrationsDirectory);
  return { config, logger: new JsonLogger(config.logsDirectory) };
}
