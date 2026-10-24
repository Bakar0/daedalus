import { BootstrapAuth, createAdmin } from "./admin";
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
const relay = new Relay();
const gateway = createGateway({ config, store, controller, relay });
const servers = [
  Bun.serve({ ...gateway.public, hostname: "0.0.0.0", port: config.port }),
  // Only the in-cluster Service exposes this one; runner tokens work here only.
  Bun.serve({
    ...gateway.runner,
    hostname: "0.0.0.0",
    port: config.runnerPort,
  }),
];
// The admin page: off unless its port is set; 127.0.0.1 unless exposed.
if (config.admin) {
  const admin = config.admin;
  servers.push(
    Bun.serve({
      ...createAdmin({
        config: { ...config, admin },
        store,
        controller,
        relay,
        workspaces: gateway.workspaces,
        auth: BootstrapAuth.fromDir(admin.tokenDir),
      }),
      hostname: admin.host,
      port: admin.port,
    }),
  );
}
// Collection: once now, then on a timer, one pass at a time.
let collecting = false;
const collect = () => {
  if (collecting) return;
  collecting = true;
  void gateway
    .collect()
    .catch((error: unknown) =>
      console.log(`Collection failed: ${String(error)}`),
    )
    .finally(() => {
      collecting = false;
    });
};
collect();
setInterval(collect, config.collectMs);
console.log(
  `Gateway listening on ${config.port}, runners on ${config.runnerPort}${config.admin ? `, admin on ${config.admin.host}:${config.admin.port}` : ""}${config.devLogin ? ", with dev login" : ""}`,
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void Promise.all(servers.map((server) => server.stop())).then(() => {
      store.close();
      process.exit(0);
    });
  });
