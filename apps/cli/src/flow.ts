import {
  DaedalusError,
  FLOW_RELATION_MEANINGS,
  FLOW_RELATION_TYPES,
  FLOW_STAGE_KINDS,
  FLOW_STAGE_MEANINGS,
  parseRelationType,
  parseStageSpecs,
  type AgentSession,
  type ApplicationContext,
  type FlowActor,
  type FlowComponent,
  type FlowMap,
  type FlowMapDetail,
  type FlowShownStage,
  type FlowStageAction,
  type Task,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { parseArguments, printResult, required } from "./arguments";

export const flowHelp = `Flow map commands:
  daedal flow maps [--workspace <workspace>]
  daedal flow new <name> --deliverable <text> [--done-when <text>]
  daedal flow show [--map <map>] [--dropped]
  daedal flow history [--map <map>] [--limit <n>]
  daedal flow add <name> --in <component> --deliverable <text>
      [--done-when <text>] [--stages <flow>]
  daedal flow edit <component> [--name <name>] [--deliverable <text>]
      [--done-when <text>] [--in <component>] [--position <n>]
  daedal flow relate <from> <to> --type <type> [--note <text>]
  daedal flow drop <component|r<n>> --reason <text>
  daedal flow restore <component|r<n>>
  daedal flow delete <component|r<n>> [--with-contents]
  daedal flow stages <component> <flow> [--drop <reason> | --delete]
  daedal flow stage <start|finish|block|skip|reset> <component> <stage>
      [--reason <text>]
  daedal flow decide <component> "<text>"
  daedal flow link <component> (--task <task-ref> | --none)
  daedal flow remove-map <map> --force
  daedal flow types

Every command also takes --workspace <workspace> and --map <map>. Inside a
session they default to the session's workspace and to the workspace's only
map. A map is named by its number (1, #1) or its name. A component is named
by its number (7, #7), a path of names from the root ("API server/Orders
API"), or a name only one component has. A relation is r<n>, as 'flow show'
prints it.

A map belongs to the workspace. It starts as one root component, the idea
or task, and holds components inside components. Each component states its
deliverable: something meaningful on its own, not a step. Relations link any
two components with one of these types:
${FLOW_RELATION_TYPES.map((type) => `  ${type.padEnd(13)} ${FLOW_RELATION_MEANINGS[type]}`).join("\n")}

A component's flow is a list of stages, each once, from this set:
${FLOW_STAGE_KINDS.map((kind) => `  ${kind.padEnd(10)} ${FLOW_STAGE_MEANINGS[kind]}`).join("\n")}
Write a flow as 'research,plan,implement'. A container's stage may lead
with a mode: 'rollup:implement' is worked out from the components inside,
and 'after:validate=integration' starts only once every component inside
finished its validate; '=integration' is the label shown. Stages that
already started and are left out of a new flow need --drop "<reason>", which
keeps them faint on the map, or --delete.

'flow stage start' claims the stage for the session running it. Another
running session's claim is refused, so two agents never run one stage.
A rollup stage cannot be set, and an after stage cannot start before the
components inside reach it.

'drop' keeps a component or relation on the map, faint, with the reason:
use it for something considered and decided against. 'delete' removes it
with no trace: use it for noise such as a typo or a duplicate.

Inside a session, changing a map needs the flow ability ('daedal session
grant <session> flow'); reading does not. Outside a session the change is
the user's.`;

const STAGE_ACTIONS: readonly FlowStageAction[] = [
  "start",
  "finish",
  "block",
  "skip",
  "reset",
];

const RELATION_REFERENCE = /^r[1-9]\d*$/i;

/** The words a stage's state reads as on one line. */
function stageText(
  stage: FlowShownStage,
  sessionName: (id: string) => string | undefined,
): string {
  const name = stage.label ?? stage.kind;
  const mode =
    stage.mode === "rollup"
      ? " (from inside)"
      : stage.mode === "after"
        ? " (after inside)"
        : "";
  const who =
    stage.sessionId && stage.shown !== "todo"
      ? ` by ${sessionName(stage.sessionId) ?? stage.sessionId.slice(0, 8)}`
      : "";
  const note = stage.note ? `: ${stage.note}` : "";
  return `${name}${mode} ${stage.shown}${who}${note}`;
}

/** The map as an indented tree, then its relations. */
export function mapText(
  detail: FlowMapDetail,
  options: {
    showDropped: boolean;
    sessionName: (id: string) => string | undefined;
    taskNumber: (id: string) => number | undefined;
  },
): string {
  const lines: string[] = [
    `Map #${detail.map.number} ${detail.map.name} (updated ${detail.map.updatedAt})`,
  ];
  const byParent = new Map<string | null, FlowComponent[]>();
  for (const component of detail.components)
    byParent.set(component.parentId, [
      ...(byParent.get(component.parentId) ?? []),
      component,
    ]);
  const write = (component: FlowComponent, depth: number) => {
    const pad = "  ".repeat(depth);
    if (component.droppedReason !== null && !options.showDropped) return;
    const task = component.taskId
      ? options.taskNumber(component.taskId)
      : undefined;
    lines.push(
      `${pad}#${component.number} ${component.name}${task ? ` [task #${task}]` : ""}${
        component.droppedReason !== null
          ? ` DROPPED: ${component.droppedReason}`
          : ""
      }`,
    );
    lines.push(`${pad}   delivers: ${component.deliverable}`);
    if (component.doneWhen)
      lines.push(`${pad}   done when: ${component.doneWhen}`);
    const stages = detail.stages.filter(
      (stage) =>
        stage.componentId === component.id &&
        (options.showDropped || stage.droppedReason === null),
    );
    if (stages.length)
      lines.push(
        `${pad}   flow: ${stages
          .map(
            (stage) =>
              `${stageText(stage, options.sessionName)}${stage.droppedReason !== null ? ` [dropped: ${stage.droppedReason}]` : ""}`,
          )
          .join(" → ")}`,
      );
    else lines.push(`${pad}   flow: none yet`);
    for (const decision of detail.decisions.filter(
      (item) => item.componentId === component.id,
    ))
      lines.push(`${pad}   decided (${decision.author}): ${decision.text}`);
    for (const child of byParent.get(component.id) ?? [])
      write(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) write(root, 0);
  const names = new Map(detail.components.map((c) => [c.id, c.name]));
  const relations = detail.relations.filter(
    (relation) => options.showDropped || relation.droppedReason === null,
  );
  if (relations.length) {
    lines.push("Relations:");
    for (const relation of relations)
      lines.push(
        `  r${relation.number} ${names.get(relation.fromId)} ${relation.type} ${names.get(relation.toId)}${
          relation.note ? ` (${relation.note})` : ""
        }${relation.droppedReason !== null ? ` DROPPED: ${relation.droppedReason}` : ""}`,
      );
  }
  const hidden =
    detail.components.filter((c) => c.droppedReason !== null).length +
    detail.relations.filter((r) => r.droppedReason !== null).length;
  if (hidden && !options.showDropped)
    lines.push(`(${hidden} dropped, shown with --dropped)`);
  return lines.join("\n");
}

export async function flowCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  resolveTask: (reference: string, workspace: string) => Promise<Task>,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(flowHelp);
    return 0;
  }
  const known = [
    "maps",
    "new",
    "show",
    "history",
    "add",
    "edit",
    "relate",
    "drop",
    "restore",
    "delete",
    "stages",
    "stage",
    "decide",
    "link",
    "remove-map",
    "types",
  ];
  if (!known.includes(action))
    throw new DaedalusError("VALIDATION", `Unknown flow command '${action}'`);
  const parsed = parseArguments(
    args,
    [
      "workspace",
      "map",
      "deliverable",
      "done-when",
      "in",
      "stages",
      "name",
      "position",
      "type",
      "note",
      "reason",
      "drop",
      "task",
      "limit",
    ],
    ["dropped", "with-contents", "delete", "none", "force"],
  );
  const { positionals, values, flags } = parsed;
  const caller = await callerSession(context);
  const actor: FlowActor = caller
    ? { kind: "session", session: caller }
    : { kind: "user" };

  if (action === "types") {
    const data = {
      stages: FLOW_STAGE_KINDS.map((kind) => ({
        kind,
        meaning: FLOW_STAGE_MEANINGS[kind],
      })),
      relations: FLOW_RELATION_TYPES.map((type) => ({
        type,
        meaning: FLOW_RELATION_MEANINGS[type],
      })),
    };
    printResult(data, json, () => {
      console.log("Stages:");
      for (const stage of data.stages)
        console.log(`  ${stage.kind.padEnd(10)} ${stage.meaning}`);
      console.log("Relation types:");
      for (const relation of data.relations)
        console.log(`  ${relation.type.padEnd(13)} ${relation.meaning}`);
    });
    return 0;
  }

  const workspaceId = await (async () => {
    if (values.workspace)
      return (await context.workspaces.get(values.workspace)).id;
    if (caller) return caller.workspaceId;
    throw new DaedalusError(
      "VALIDATION",
      "--workspace is required outside a Daedalus session",
    );
  })();
  const sessionName = (id: string) => context.repositories.findAgent(id)?.name;
  const taskNumber = (id: string) => context.repositories.findTask(id)?.number;
  const map = (): FlowMap => context.flow.resolveMap(workspaceId, values.map);
  const component = (reference: string | undefined, usage: string) =>
    context.flow.resolveComponent(map().id, required(reference, usage));
  const printMap = (detail: FlowMapDetail) =>
    printResult(detail, json, () =>
      console.log(
        mapText(detail, {
          showDropped: flags.has("dropped"),
          sessionName,
          taskNumber,
        }),
      ),
    );
  const done = (data: unknown, line: string) => {
    printResult(data, json, () => console.log(line));
    return 0;
  };
  const usage = (text: string): never => {
    throw new DaedalusError("VALIDATION", `Usage: daedal flow ${text}`);
  };

  switch (action) {
    case "maps": {
      const maps = context.flow.listMaps(workspaceId);
      printResult(maps, json, () => {
        if (!maps.length) console.log("No flow maps in this workspace.");
        for (const item of maps)
          console.log(
            `#${item.number} ${item.name} (updated ${item.updatedAt})`,
          );
      });
      return 0;
    }
    case "new": {
      const name = positionals.join(" ");
      if (!name.trim()) usage("new <name> --deliverable <text>");
      const detail = context.flow.createMap(actor, workspaceId, {
        name,
        deliverable: required(values.deliverable, "--deliverable"),
        ...(values["done-when"] !== undefined
          ? { doneWhen: values["done-when"] }
          : {}),
      });
      return done(
        detail,
        `Started map #${detail.map.number} ${detail.map.name}`,
      );
    }
    case "show": {
      if (positionals.length) usage("show [--map <map>] [--dropped]");
      printMap(context.flow.detail(map().id));
      return 0;
    }
    case "history": {
      const limit = values.limit === undefined ? 50 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1)
        throw new DaedalusError(
          "VALIDATION",
          "--limit takes a whole number of lines",
        );
      const lines = context.flow.history(map().id, limit);
      printResult(lines, json, () => {
        for (const line of [...lines].reverse())
          console.log(`${line.createdAt} ${line.author}: ${line.text}`);
      });
      return 0;
    }
    case "add": {
      const name = positionals.join(" ");
      if (!name.trim())
        usage("add <name> --in <component> --deliverable <text>");
      const target = map();
      const added = context.flow.addComponent(actor, target.id, {
        parentId: context.flow.resolveComponent(
          target.id,
          required(values.in, "--in <component>"),
        ).id,
        name,
        deliverable: required(values.deliverable, "--deliverable"),
        ...(values["done-when"] !== undefined
          ? { doneWhen: values["done-when"] }
          : {}),
        ...(values.stages !== undefined
          ? { stages: parseStageSpecs(values.stages) }
          : {}),
      });
      return done(added, `Added #${added.number} ${added.name}`);
    }
    case "edit": {
      if (positionals.length !== 1) usage("edit <component> [--name ...]");
      const target = map();
      const subject = context.flow.resolveComponent(target.id, positionals[0]!);
      const position =
        values.position === undefined ? undefined : Number(values.position);
      const edited = context.flow.editComponent(actor, subject.id, {
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.deliverable !== undefined
          ? { deliverable: values.deliverable }
          : {}),
        ...(values["done-when"] !== undefined
          ? { doneWhen: values["done-when"] }
          : {}),
        ...(values.in !== undefined
          ? { parentId: context.flow.resolveComponent(target.id, values.in).id }
          : {}),
        ...(position !== undefined ? { position } : {}),
      });
      return done(edited, `Updated #${edited.number} ${edited.name}`);
    }
    case "relate": {
      if (positionals.length !== 2)
        usage("relate <from> <to> --type <type> [--note <text>]");
      const target = map();
      const relation = context.flow.relate(actor, target.id, {
        fromId: context.flow.resolveComponent(target.id, positionals[0]!).id,
        toId: context.flow.resolveComponent(target.id, positionals[1]!).id,
        type: parseRelationType(required(values.type, "--type")),
        ...(values.note !== undefined ? { note: values.note } : {}),
      });
      return done(relation, `Added relation r${relation.number}`);
    }
    case "drop":
    case "restore":
    case "delete": {
      if (positionals.length !== 1) usage(`${action} <component|r<n>>`);
      const target = map();
      const reference = positionals[0]!;
      if (RELATION_REFERENCE.test(reference)) {
        const relation = context.flow.resolveRelation(target.id, reference);
        const result =
          action === "drop"
            ? context.flow.dropRelation(
                actor,
                relation.id,
                required(values.reason, "--reason"),
              )
            : action === "restore"
              ? context.flow.restoreRelation(actor, relation.id)
              : context.flow.deleteRelation(actor, relation.id);
        return done(result, `${verb(action)} relation r${relation.number}`);
      }
      const subject = context.flow.resolveComponent(target.id, reference);
      const result =
        action === "drop"
          ? context.flow.dropComponent(
              actor,
              subject.id,
              required(values.reason, "--reason"),
            )
          : action === "restore"
            ? context.flow.restoreComponent(actor, subject.id)
            : context.flow.deleteComponent(actor, subject.id, {
                withContents: flags.has("with-contents"),
              });
      return done(result, `${verb(action)} #${subject.number} ${subject.name}`);
    }
    case "stages": {
      if (positionals.length !== 2)
        usage("stages <component> <flow> [--drop <reason> | --delete]");
      if (values.drop !== undefined && flags.has("delete"))
        throw new DaedalusError(
          "VALIDATION",
          "Pass --drop or --delete, not both",
        );
      const subject = component(positionals[0], "<component>");
      const stages = context.flow.setStages(
        actor,
        subject.id,
        parseStageSpecs(positionals[1]!),
        values.drop !== undefined
          ? { kind: "drop", reason: values.drop }
          : flags.has("delete")
            ? { kind: "delete" }
            : undefined,
      );
      return done(
        stages,
        `Flow of #${subject.number} ${subject.name}: ${
          stages
            .filter((stage) => stage.droppedReason === null)
            .map((stage) => stageText(stage, sessionName))
            .join(" → ") || "none"
        }`,
      );
    }
    case "stage": {
      const [move, reference, kind] = positionals;
      if (
        positionals.length !== 3 ||
        !STAGE_ACTIONS.includes(move as FlowStageAction)
      )
        usage(
          "stage <start|finish|block|skip|reset> <component> <stage> [--reason <text>]",
        );
      const subject = component(reference, "<component>");
      const stage = context.flow.moveStage(
        actor,
        subject.id,
        kind!,
        move as FlowStageAction,
        values.reason,
      );
      return done(
        stage,
        `#${subject.number} ${subject.name}: ${stageText(stage, sessionName)}`,
      );
    }
    case "decide": {
      const [reference, ...words] = positionals;
      if (!reference || !words.length) usage('decide <component> "<text>"');
      const subject = component(reference, "<component>");
      const decision = context.flow.decide(actor, subject.id, words.join(" "));
      return done(decision, `Recorded on #${subject.number} ${subject.name}`);
    }
    case "link": {
      if (
        positionals.length !== 1 ||
        (values.task === undefined) === !flags.has("none")
      )
        usage("link <component> (--task <task-ref> | --none)");
      const subject = component(positionals[0], "<component>");
      const task = values.task
        ? await resolveTask(values.task, workspaceId)
        : undefined;
      const linked = context.flow.linkTask(actor, subject.id, task?.id ?? null);
      return done(
        linked,
        task
          ? `Linked #${subject.number} ${subject.name} to task #${task.number}`
          : `Unlinked #${subject.number} ${subject.name}`,
      );
    }
    case "remove-map": {
      if (positionals.length !== 1 || !flags.has("force"))
        usage("remove-map <map> --force");
      const target = context.flow.resolveMap(workspaceId, positionals[0]);
      const removed = context.flow.deleteMap(actor, target.id);
      return done(removed, `Deleted map #${removed.number} ${removed.name}`);
    }
  }
  return 0;
}

const verb = (action: "drop" | "restore" | "delete") =>
  action === "drop" ? "Dropped" : action === "restore" ? "Restored" : "Deleted";

/** A stage `agent spawn --flow-stage` hands to the session it starts. */
export interface SpawnStageClaim {
  map: FlowMap;
  component: FlowComponent;
  kind: string;
  /** Added to the new session's first message. */
  line: string;
}

/**
 * Reads `--flow-stage <component>:<stage>` (and `--flow-map`) before a
 * spawn, and refuses a stage the new session could not claim, so nothing is
 * started for a stage it cannot take.
 */
export function spawnStageClaim(
  context: ApplicationContext,
  workspaceId: string,
  values: Record<string, string>,
): SpawnStageClaim | undefined {
  const value = values["flow-stage"];
  if (value === undefined) {
    if (values["flow-map"] !== undefined)
      throw new DaedalusError(
        "VALIDATION",
        "--flow-map goes with --flow-stage",
      );
    return undefined;
  }
  const split = value.lastIndexOf(":");
  if (split <= 0 || split === value.length - 1)
    throw new DaedalusError(
      "VALIDATION",
      "--flow-stage takes <component>:<stage>, such as 'Orders API:implement'",
    );
  const map = context.flow.resolveMap(workspaceId, values["flow-map"]);
  const component = context.flow.resolveComponent(
    map.id,
    value.slice(0, split),
  );
  const kind = value.slice(split + 1);
  const stage = context.flow.resolveStage(component.id, kind);
  const shown = context.flow
    .detail(map.id)
    .stages.find((item) => item.id === stage.id);
  if (stage.mode === "rollup")
    throw new DaedalusError(
      "VALIDATION",
      `The ${stage.kind} stage of '${component.name}' is worked out from the components inside it; hand out theirs`,
    );
  if (shown?.shown === "waiting")
    throw new DaedalusError(
      "CONFLICT",
      `The ${stage.label ?? stage.kind} stage of '${component.name}' waits for the components inside it`,
    );
  const holder = stage.sessionId
    ? context.repositories.findAgent(stage.sessionId)
    : undefined;
  if (
    holder &&
    !holder.archivedAt &&
    (holder.status === "running" || holder.status === "starting") &&
    (stage.state === "running" || stage.state === "blocked")
  )
    throw new DaedalusError(
      "CONFLICT",
      `The ${stage.kind} stage of '${component.name}' is held by '${holder.name}' (${holder.id})`,
    );
  const reference = `#${component.number}`;
  return {
    map,
    component,
    kind: stage.kind,
    line: `You are working on the ${stage.label ?? stage.kind} stage of '${component.name}' (${reference}) in the flow map '${map.name}'. Daedalus claimed it for you. Read the map with 'daedal flow show --map ${map.number}', and when the stage is done run 'daedal flow stage finish ${reference} ${stage.kind} --map ${map.number}'.`,
  };
}

/** Claims the stage for the session just started. */
export function claimSpawnedStage(
  context: ApplicationContext,
  session: AgentSession,
  claim: SpawnStageClaim,
): void {
  context.flow.moveStage(
    { kind: "session", session },
    claim.component.id,
    claim.kind,
    "start",
  );
}
