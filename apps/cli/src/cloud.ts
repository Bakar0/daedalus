import {
  cloudHostId,
  DaedalusError,
  type ApplicationContext,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

type CloudWorkspace = Awaited<ReturnType<ApplicationContext["cloud"]["get"]>>;

export const cloudHelp = `Cloud workspace commands:
  daedal cloud login <gateway-url> --email <email>
  daedal cloud status
  daedal cloud logout
  daedal cloud create <workspace> [--cpu <cpu>] [--memory <memory>]
  daedal cloud list
  daedal cloud get <workspace>
  daedal cloud sleep <workspace>
  daedal cloud wake <workspace>
  daedal cloud delete <workspace> --force
  daedal cloud spawn <workspace> [--terminal] [--task <task-ref>] [--name <name>] [--model <model>] [--message <text>]
  daedal cloud spawn <workspace> --team <lead> [--task <task-ref>] [--name <name>] [--model <model>] [--message <instructions>]

A cloud workspace is a local workspace with a pod of its own on a Daedalus
gateway: sessions run there, and this Mac keeps the board, the database and
every decision. 'login' signs in with the gateway's dev login, which only a
gateway installed with gateway.devLogin offers.

'create' makes the pod for a local workspace, under the same id. 'spawn'
starts Claude in the workspace root of the pod, or a shell with --terminal.
With --team it starts Claude as a member of that lead's team, which must lead
from the same workspace; team messages are typed into it at its prompt.
Its hooks and its 'daedal' calls come back to this Mac, which runs only the
commands a session needs to report on itself and work its own workspace's
tasks.

'sleep' removes the pod and keeps its volume; the sessions running there end,
and 'daedal agent revive' resumes them after 'wake'. 'delete' removes the pod,
its volume and its token; the local workspace stays.

The Daedalus app holds this Mac's connection to the gateway. With the app
closed, a command that needs a runner connects for as long as it runs.`;

function printWorkspace(workspace: CloudWorkspace): void {
  console.log(
    [
      workspace.workspaceId,
      workspace.name,
      workspace.status,
      workspace.runnerOnline ? "runner online" : "runner offline",
      workspace.reason ?? "",
    ]
      .filter(Boolean)
      .join("\t"),
  );
}

export async function cloudCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(cloudHelp);
    return 0;
  }
  const { cloud } = context;

  if (action === "login") {
    const parsed = parseArguments(args, ["email"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal cloud login <gateway-url> --email <email>",
    );
    const email = parsed.values.email;
    if (!email)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal cloud login <gateway-url> --email <email>",
      );
    const user = await cloud.devLogin(parsed.positionals[0]!, email);
    printResult(user, json, () =>
      console.log(`Signed in as ${user.email} (${user.id})`),
    );
    return 0;
  }
  if (action === "status") {
    expectPositionals(
      parseArguments(args, []).positionals,
      0,
      "daedal cloud status",
    );
    const status = await cloud.status();
    printResult(status, json, () =>
      console.log(
        status
          ? `Signed in to ${status.gatewayUrl} as ${status.user.email}`
          : "Not signed in to a cloud gateway",
      ),
    );
    return 0;
  }
  if (action === "logout") {
    expectPositionals(
      parseArguments(args, []).positionals,
      0,
      "daedal cloud logout",
    );
    await cloud.logout();
    printResult({ signedOut: true }, json, () => console.log("Signed out"));
    return 0;
  }
  if (action === "list") {
    expectPositionals(
      parseArguments(args, []).positionals,
      0,
      "daedal cloud list",
    );
    const workspaces = await cloud.list();
    printResult(workspaces, json, () => {
      if (!workspaces.length) console.log("No cloud workspaces");
      for (const workspace of workspaces) printWorkspace(workspace);
    });
    return 0;
  }
  if (action === "create") {
    const parsed = parseArguments(args, ["cpu", "memory"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal cloud create <workspace> [--cpu <cpu>] [--memory <memory>]",
    );
    const resources = {
      ...(parsed.values.cpu ? { cpu: parsed.values.cpu } : {}),
      ...(parsed.values.memory ? { memory: parsed.values.memory } : {}),
    };
    const workspace = await cloud.create(
      parsed.positionals[0]!,
      Object.keys(resources).length ? resources : undefined,
    );
    printResult(workspace, json, () => printWorkspace(workspace));
    return 0;
  }
  if (
    action === "get" ||
    action === "sleep" ||
    action === "wake" ||
    action === "delete"
  ) {
    const parsed = parseArguments(args, [], ["force"]);
    expectPositionals(
      parsed.positionals,
      1,
      `daedal cloud ${action} <workspace>${action === "delete" ? " --force" : ""}`,
    );
    const reference = parsed.positionals[0]!;
    if (action === "delete") {
      if (!parsed.flags.has("force"))
        throw new DaedalusError(
          "VALIDATION",
          "Deleting a cloud workspace removes its pod and its volume; pass --force",
        );
      await cloud.delete(reference);
      printResult({ deleted: reference }, json, () =>
        console.log(`Deleted the cloud workspace ${reference}`),
      );
      return 0;
    }
    const workspace =
      action === "get"
        ? await cloud.get(reference)
        : action === "sleep"
          ? await cloud.sleep(reference)
          : await cloud.wake(reference);
    printResult(workspace, json, () => printWorkspace(workspace));
    return 0;
  }
  if (action === "spawn") {
    const parsed = parseArguments(
      args,
      ["task", "name", "model", "message", "team"],
      ["terminal"],
    );
    expectPositionals(
      parsed.positionals,
      1,
      "daedal cloud spawn <workspace> [--terminal | --team <lead>] [--task <task-ref>] [--name <name>] [--model <model>] [--message <text>]",
    );
    if (parsed.values.team && parsed.flags.has("terminal"))
      throw new DaedalusError(
        "VALIDATION",
        "A team member runs Claude; leave out --terminal",
      );
    const workspace = await context.workspaces.getActive(
      parsed.positionals[0]!,
    );
    const cloudId = context.repositories.cloudWorkspaceId(workspace.id);
    if (!cloudId)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace '${workspace.name}' has no cloud workspace; run 'daedal cloud create'`,
      );
    const task = parsed.values.task
      ? context.tasks.get(parsed.values.task)
      : undefined;
    if (parsed.values.team) {
      const team = context.teams.get(parsed.values.team);
      if (team.lead.workspaceId !== workspace.id)
        throw new DaedalusError(
          "VALIDATION",
          `Members start in the lead's workspace, '${team.lead.workspaceId}'`,
        );
      const result = await context.teams.spawnMember({
        team: team.id,
        addedBy: "user",
        host: cloudHostId(cloudId),
        ...(task ? { taskId: task.id } : {}),
        ...(parsed.values.name ? { name: parsed.values.name } : {}),
        ...(parsed.values.model ? { model: parsed.values.model } : {}),
        ...(parsed.values.message
          ? { instructions: parsed.values.message }
          : {}),
      });
      printResult({ ...result.session, teamHandle: result.handle }, json, () =>
        console.log(
          `${result.session.id}\t${result.session.name}\t${result.session.status}\t@${result.handle}`,
        ),
      );
      return 0;
    }
    const session = await context.agents.spawn({
      workspace: workspace.id,
      host: cloudHostId(cloudId),
      ...(task ? { taskId: task.id } : {}),
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
      ...(parsed.values.message ? { message: parsed.values.message } : {}),
      ...(parsed.flags.has("terminal") ? { terminal: true } : {}),
    });
    printResult(session, json, () =>
      console.log(`${session.id}\t${session.name}\t${session.status}`),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown cloud command '${action}'`);
}
