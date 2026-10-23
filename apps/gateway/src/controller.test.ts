import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { loadTenantObjects } from "./controller";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-tenant-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads the chart's tenant files in name order", () => {
  writeFileSync(
    join(dir, "serviceaccount.yaml"),
    "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: runner\nautomountServiceAccountToken: false\n",
  );
  writeFileSync(
    join(dir, "resourcequota.yaml"),
    'apiVersion: v1\nkind: ResourceQuota\nmetadata:\n  name: tenant\nspec:\n  hard:\n    pods: "10"\n',
  );
  writeFileSync(join(dir, "README"), "not yaml");
  expect(loadTenantObjects(dir)).toEqual([
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "tenant" },
      spec: { hard: { pods: "10" } },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "runner" },
      automountServiceAccountToken: false,
    },
  ]);
});

test("refuses kinds the gateway has no right to create", () => {
  writeFileSync(
    join(dir, "role.yaml"),
    "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: x\n",
  );
  expect(() => loadTenantObjects(dir)).toThrow("does not create ClusterRole");
});

test("config needs the in-cluster URL and namespace", () => {
  expect(() => loadConfig({ DAEDALUS_GATEWAY_NAMESPACE: "d" })).toThrow(
    "DAEDALUS_GATEWAY_INTERNAL_URL",
  );
  const config = loadConfig({
    DAEDALUS_GATEWAY_INTERNAL_URL: "http://gw:8080",
    DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
  });
  expect(config.devLogin).toBe(false);
  expect(config.serviceAccount).toBe("daedalus-gateway");
  expect(config.workspace.idleMinutes).toBe("15");
});
