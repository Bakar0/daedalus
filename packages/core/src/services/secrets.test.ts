import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  DaedalusError,
  SECRET_SERVICE,
  SecretService,
  type ApplicationContext,
  type SecretKeychain,
} from "../index";

class FakeKeychain implements SecretKeychain {
  readonly items = new Map<string, string>();
  async write(service: string, account: string, secret: string) {
    this.items.set(`${service}|${account}`, secret);
  }
  async read(service: string, account: string) {
    return this.items.get(`${service}|${account}`);
  }
  async remove(service: string, account: string) {
    this.items.delete(`${service}|${account}`);
  }
}

async function withSecrets(
  run: (input: {
    context: ApplicationContext;
    secrets: SecretService;
    keychain: FakeKeychain;
    home: string;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    const context = await createApplicationContext({
      env: { ...process.env, DAEDALUS_HOME: home },
      reconcile: false,
    });
    const keychain = new FakeKeychain();
    try {
      await run({
        context,
        secrets: new SecretService(
          context.repositories,
          context.workspaces,
          context.config.home,
          keychain,
        ),
        keychain,
        home,
      });
    } finally {
      context.close();
    }
  });
}

const VALUE = 'ghp_"quoted"\\back\nslash é';

describe("SecretService", () => {
  test("stores the value in the Keychain and only the name in SQLite", async () => {
    await withSecrets(async ({ context, secrets, keychain, home }) => {
      const workspace = await context.workspaces.create({ name: "Secrets" });
      await secrets.set(workspace.slug, "GH_TOKEN", VALUE);

      expect((await secrets.list(workspace.slug)).map((s) => s.name)).toEqual([
        "GH_TOKEN",
      ]);
      expect([...keychain.items.keys()]).toEqual([
        `${SECRET_SERVICE}|${context.config.home}#${workspace.id}/GH_TOKEN`,
      ]);
      expect(await secrets.values(workspace.slug, ["GH_TOKEN"])).toEqual({
        GH_TOKEN: VALUE,
      });

      // Nothing Daedalus writes holds the value, the database included.
      context.repositories.database.exec("PRAGMA wal_checkpoint(FULL)");
      const files = await readdir(home, { recursive: true });
      for (const file of files) {
        const path = join(home, file);
        const blob = Bun.file(path);
        if ((await blob.exists()) && blob.size < 50_000_000)
          expect(
            Buffer.from(await blob.arrayBuffer()).includes(
              Buffer.from("quoted"),
            ),
          ).toBe(false);
      }
    });
  });

  test("replacing a value keeps one name", async () => {
    await withSecrets(async ({ context, secrets }) => {
      const workspace = await context.workspaces.create({ name: "Secrets" });
      await secrets.set(workspace.id, "API_KEY", "first-value");
      await secrets.set(workspace.id, "API_KEY", "second-value");
      expect(await secrets.list(workspace.id)).toHaveLength(1);
      expect(await secrets.values(workspace.id, ["API_KEY"])).toEqual({
        API_KEY: "second-value",
      });
    });
  });

  test("refuses bad and reserved names and empty values", async () => {
    await withSecrets(async ({ context, secrets }) => {
      const workspace = await context.workspaces.create({ name: "Secrets" });
      for (const name of ["gh_token", "1TOKEN", "A-B", "PATH", "DAEDALUS_X"])
        await expect(secrets.set(workspace.id, name, "value")).rejects.toThrow(
          DaedalusError,
        );
      await expect(secrets.set(workspace.id, "TOKEN", "")).rejects.toThrow(
        "cannot be empty",
      );
    });
  });

  test("names every missing secret and returns none", async () => {
    await withSecrets(async ({ context, secrets, keychain }) => {
      const workspace = await context.workspaces.create({ name: "Secrets" });
      await secrets.set(workspace.id, "ONE", "value-one");
      await secrets.set(workspace.id, "GONE", "value-gone");
      // Deleted in Keychain Access, behind Daedalus's back.
      keychain.items.delete(
        `${SECRET_SERVICE}|${context.config.home}#${workspace.id}/GONE`,
      );
      const error = await secrets
        .values(workspace.id, ["ONE", "TWO", "GONE"])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DaedalusError);
      expect((error as DaedalusError).code).toBe("NOT_FOUND");
      expect((error as DaedalusError).message).toContain("TWO, GONE");
    });
  });

  test("a secret belongs to one workspace", async () => {
    await withSecrets(async ({ context, secrets }) => {
      const first = await context.workspaces.create({ name: "First" });
      const second = await context.workspaces.create({ name: "Second" });
      await secrets.set(first.id, "TOKEN", "first-token");
      await expect(secrets.values(second.id, ["TOKEN"])).rejects.toThrow(
        "not set",
      );
    });
  });

  test("remove deletes the Keychain item and the name", async () => {
    await withSecrets(async ({ context, secrets, keychain }) => {
      const workspace = await context.workspaces.create({ name: "Secrets" });
      await secrets.set(workspace.id, "TOKEN", "the-token");
      await secrets.remove(workspace.id, "TOKEN");
      expect(keychain.items.size).toBe(0);
      expect(await secrets.list(workspace.id)).toEqual([]);
      await expect(secrets.remove(workspace.id, "TOKEN")).rejects.toThrow(
        "has no secret",
      );
    });
  });

  test("forgetWorkspace deletes every Keychain item of the workspace", async () => {
    await withSecrets(async ({ context, secrets, keychain }) => {
      const first = await context.workspaces.create({ name: "First" });
      const second = await context.workspaces.create({ name: "Second" });
      await secrets.set(first.id, "A_TOKEN", "a-token");
      await secrets.set(first.id, "B_TOKEN", "b-token");
      await secrets.set(second.id, "A_TOKEN", "other");
      await secrets.forgetWorkspace(first.id);
      expect(keychain.items.size).toBe(1);
    });
  });
});
