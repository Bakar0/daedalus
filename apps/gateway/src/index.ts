import { loadConfig } from "./config";
import { Controller, loadTenantObjects } from "./controller";
import { inClusterKube } from "./kube";
import { Relay } from "./relay";
import { createGateway } from "./server";
import { Store } from "./store";

const config = loadConfig(process.env);
const store = new Store(config.dbPath);
const controller = new Controller(
  inClusterKube(process.env),
  config,
  loadTenantObjects(config.tenantDir),
);
const gateway = createGateway({
  config,
  store,
  controller,
  relay: new Relay(),
});
const server = Bun.serve({
  ...gateway,
  hostname: "0.0.0.0",
  port: config.port,
});
console.log(
  `Gateway listening on ${server.port}${config.devLogin ? " with dev login" : ""}`,
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void server.stop().then(() => {
      store.close();
      process.exit(0);
    });
  });
