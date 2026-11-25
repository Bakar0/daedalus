/**
 * The read views of the Workflows and Custom instructions tabs: each file as
 * an agent takes it in, before anyone opens its markdown. A workflow is its
 * purpose and a numbered line of steps, a step is its instructions and the
 * workflows that use it, and the instructions are the rules for every
 * request and one card per topic.
 */
import type { ReactNode } from "react";
import type {
  InstructionFilesDto,
  StepMemoryDto,
  WorkflowFileDto,
} from "@daedalus/protocol";
import { MarkdownPreview } from "./markdown-preview";
import { GATE_LABELS } from "./workflow-gates";
import { WorkflowIcon } from "./WorkflowPane";

/** A rule is a top-level bullet or numbered item; indented lines belong to it. */
const isRule = (line: string) => /^(?:[-*+]|\d+[.)])\s+\S/.test(line);

/** The lines under a `## Heading` of a markdown file, up to the next one. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line),
  );
  if (start === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s/.test(line),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Each rule with the lines that continue it, as markdown. */
function rules(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (isRule(line)) found.push(line);
    else if (found.length && /^\s+\S/.test(line))
      found[found.length - 1] += `\n${line}`;
  }
  return found;
}

/** The rules of a topic file: everything after its `# Heading`. */
const topicBody = (text: string) => text.replace(/^#\s+.+\n?/m, "").trim();

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** The rules under the index's `## Always`. */
export const alwaysRules = (index: string) => rules(section(index, "Always"));

/**
 * Each topic as the list and its card show it: its heading, what the index
 * says it covers, and how many rules it holds.
 */
export function topicFacts(instructions: InstructionFilesDto) {
  const covers = new Map(
    section(instructions.index.text, "Topics").flatMap((line) => {
      const match = /\]\(([^)]+)\.md\):\s*(.+)$/.exec(line);
      return match ? [[match[1]!, match[2]!.trim()] as const] : [];
    }),
  );
  return instructions.topics.map((topic) => ({
    name: topic.name,
    heading: /^#\s+(.+)$/m.exec(topic.text)?.[1]?.trim() ?? topic.name,
    covers: covers.get(topic.name),
    rules: rules(topicBody(topic.text).split("\n")).length,
  }));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="file-view-field">
      <span className="file-view-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="file-view-empty">{children}</p>;
}

/**
 * A workflow: what it is for, when it fits, and its steps in order. An
 * included workflow (`@name`) is a card of its own that opens it.
 */
export function WorkflowView({
  flow,
  flows,
  onFlow,
  onStep,
  showSteps = true,
  steps,
}: {
  flow: WorkflowFileDto;
  flows: WorkflowFileDto[];
  onFlow: (name: string) => void;
  onStep: (name: string) => void;
  /** False where the steps are drawn beside it, as on the Workflows page. */
  showSteps?: boolean;
  steps: WorkflowFileDto[];
}) {
  return (
    <>
      {flow.description && <p className="file-view-lede">{flow.description}</p>}
      <div className="file-view-fields">
        {flow.when && <Field label="When">{flow.when}</Field>}
        {flow.loop && (
          <Field label="Repeats">
            From {flow.loop}
            {flow.until ? `, until ${flow.until}` : ""}
          </Field>
        )}
      </div>
      {flow.body?.trim() && (
        <div className="file-view-notes">
          <MarkdownPreview source={flow.body} />
        </div>
      )}
      {showSteps && <h3 className="file-view-heading">Steps</h3>}
      {!showSteps ? null : flow.dynamic ? (
        <Empty>
          The agent names its steps each run, for the work in front of it.
        </Empty>
      ) : (
        <ol className="step-timeline">
          {(flow.steps ?? []).map((name, index) => {
            if (name.startsWith("@")) {
              const included = flows.find(
                (item) => item.name === name.slice(1),
              );
              return (
                <li key={name}>
                  <span aria-hidden="true" className="step-timeline-number">
                    {index + 1}
                  </span>
                  <button
                    className="step-timeline-card included"
                    onClick={() => onFlow(name.slice(1))}
                    type="button"
                  >
                    <span className="step-timeline-name">
                      <WorkflowIcon />
                      {name.slice(1)}
                      <span className="workflow-tag">workflow</span>
                      {flow.loop === name && (
                        <span className="workflow-tag">↻ loops back here</span>
                      )}
                    </span>
                    {included ? (
                      <>
                        {included.description && (
                          <span className="step-timeline-description">
                            {included.description}
                          </span>
                        )}
                        <span className="step-timeline-preview">
                          {included.dynamic
                            ? "steps: dynamic"
                            : (included.steps ?? []).join(" → ")}
                        </span>
                      </>
                    ) : (
                      <span className="step-timeline-missing">
                        No workflow file; a run cannot start until there is one.
                      </span>
                    )}
                  </button>
                </li>
              );
            }
            const step = steps.find((item) => item.name === name);
            return (
              <li key={name}>
                <span aria-hidden="true" className="step-timeline-number">
                  {index + 1}
                </span>
                <button
                  className="step-timeline-card"
                  onClick={() => onStep(name)}
                  type="button"
                >
                  <span className="step-timeline-name">
                    {name}
                    {step?.gate && (
                      <span
                        className="workflow-gate"
                        title={GATE_LABELS[step.gate].title}
                      >
                        {GATE_LABELS[step.gate].tag}
                      </span>
                    )}
                    {flow.loop === name && (
                      <span className="workflow-tag">↻ loops back here</span>
                    )}
                  </span>
                  {step ? (
                    <>
                      {step.description && (
                        <span className="step-timeline-description">
                          {step.description}
                        </span>
                      )}
                      {step.body?.trim() && (
                        <span className="step-timeline-preview">
                          {step.body.trim()}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="step-timeline-missing">
                      No step file; a run cannot start until there is one.
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/** A step: its instructions, whether it waits for you, and who uses it. */
export type StepMemoryAction = "accept" | "forget" | "promote";

const runsText = (memory: StepMemoryDto) =>
  `Seen in ${memory.runs} ${memory.runs === 1 ? "run" : "runs"}, last ${memory.lastSeen}${memory.workflow ? ` in ${memory.workflow}` : ""}`;

/**
 * What a step learned from runs. A proposed memory waits here for the user:
 * agents starting the step see it only after Accept. Promote writes it into
 * the step's instructions and takes it out of the memory.
 */
export function StepMemoryList({
  busy,
  memories,
  onChange,
  problem,
}: {
  /** The text of the memory a change is being saved for. */
  busy?: string | undefined;
  memories: StepMemoryDto[];
  onChange: (text: string, action: StepMemoryAction) => void;
  problem?: string | undefined;
}) {
  const proposed = memories.filter((memory) => memory.status === "proposed");
  // Proposals first: they are what the user is here to decide.
  const sorted = [
    ...proposed,
    ...memories.filter((memory) => memory.status === "accepted"),
  ];
  return (
    <section aria-label="Step memory" className="step-memory">
      <h3 className="file-view-heading">
        Memory
        <small>
          {proposed.length
            ? `${proposed.length} to review`
            : "What this step learned from earlier runs"}
        </small>
      </h3>
      {problem && <p className="workflows-refusal">{problem}</p>}
      {!problem && sorted.length === 0 && (
        <Empty>
          Nothing yet. An agent proposes a memory when a run teaches this step
          something, and it applies after you accept it.
        </Empty>
      )}
      <ul className="step-memory-list">
        {sorted.map((memory) => (
          <li
            className={`step-memory-item status-${memory.status}`}
            key={memory.text}
          >
            <div className="step-memory-text">
              <span className={`step-memory-status status-${memory.status}`}>
                {memory.status === "proposed" ? "Proposed" : "Accepted"}
              </span>
              {memory.text}
            </div>
            <p className="step-memory-why">{memory.why}</p>
            <div className="step-memory-foot">
              <span className="step-memory-seen">
                {runsText(memory)}
                {memory.only ? ` · only in ${memory.only}` : ""}
                {memory.acceptedOn ? ` · accepted ${memory.acceptedOn}` : ""}
              </span>
              <span className="step-memory-actions">
                {memory.status === "proposed" ? (
                  <button
                    className="primary"
                    disabled={busy === memory.text}
                    onClick={() => onChange(memory.text, "accept")}
                    type="button"
                  >
                    Accept
                  </button>
                ) : (
                  <button
                    className="quiet"
                    disabled={busy === memory.text}
                    onClick={() => onChange(memory.text, "promote")}
                    title="Write it into the step's instructions and remove it from the memory"
                    type="button"
                  >
                    Promote to instructions
                  </button>
                )}
                <button
                  className="quiet"
                  disabled={busy === memory.text}
                  onClick={() => onChange(memory.text, "forget")}
                  type="button"
                >
                  Forget
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StepView({
  flows,
  memoryBusy,
  onFlow,
  onMemory,
  onTool,
  step,
  tools,
}: {
  flows: WorkflowFileDto[];
  memoryBusy?: string | undefined;
  onFlow: (name: string) => void;
  /** Absent where the memory is not shown, such as a file preview. */
  onMemory?: (text: string, action: StepMemoryAction) => void;
  /** Opens a tool the step suggests. */
  onTool?: (name: string) => void;
  step: WorkflowFileDto;
  /** Every tool file, to say what each suggested tool is for. */
  tools?: WorkflowFileDto[];
}) {
  const usedBy = flows.filter((flow) => flow.steps?.includes(step.name));
  return (
    <>
      {step.description && <p className="file-view-lede">{step.description}</p>}
      <div className="file-view-fields">
        {step.gate && (
          <Field label="Gate">{GATE_LABELS[step.gate].field}</Field>
        )}
        <Field label="Used by">
          {usedBy.length ? (
            <span className="file-view-chips">
              {usedBy.map((flow) => (
                <button
                  className="workflows-chip"
                  key={flow.name}
                  onClick={() => onFlow(flow.name)}
                  type="button"
                >
                  {flow.name}
                </button>
              ))}
            </span>
          ) : (
            "No workflow yet"
          )}
        </Field>
        {step.tools?.length ? (
          <Field label="Tools">
            <span className="file-view-chips">
              {step.tools.map((name) => {
                const tool = tools?.find((item) => item.name === name);
                return tool || !tools ? (
                  <button
                    className="workflows-chip tool"
                    key={name}
                    onClick={() => onTool?.(name)}
                    title={tool?.description || name}
                    type="button"
                  >
                    {name}
                  </button>
                ) : (
                  <span
                    className="workflows-chip missing"
                    key={name}
                    title="No tool file with this name. The step still runs; the agent is told nothing about it."
                  >
                    {name} · no file
                  </span>
                );
              })}
            </span>
          </Field>
        ) : null}
      </div>
      <h3 className="file-view-heading">What the agent does</h3>
      {step.body?.trim() ? (
        <div className="file-view-notes">
          <MarkdownPreview source={step.body} />
        </div>
      ) : (
        <Empty>No instructions yet.</Empty>
      )}
      {onMemory && (
        <StepMemoryList
          busy={memoryBusy}
          memories={step.memories ?? []}
          onChange={onMemory}
          problem={step.memoryProblem}
        />
      )}
    </>
  );
}

/**
 * A tool: what it is for, the steps that suggest it, and the instructions an
 * agent reads before using it. A step's suggestion is a push, never a limit.
 */
export function ToolView({
  onStep,
  steps,
  tool,
}: {
  onStep: (name: string) => void;
  steps: WorkflowFileDto[];
  tool: WorkflowFileDto;
}) {
  const suggestedBy = steps.filter((step) => step.tools?.includes(tool.name));
  return (
    <>
      {tool.description && <p className="file-view-lede">{tool.description}</p>}
      <div className="file-view-fields">
        <Field label="Steps">
          {suggestedBy.length ? (
            <span className="file-view-chips">
              {suggestedBy.map((step) => (
                <button
                  className="workflows-chip"
                  key={step.name}
                  onClick={() => onStep(step.name)}
                  type="button"
                >
                  {step.name}
                </button>
              ))}
            </span>
          ) : (
            "No step yet. An agent can still find it with daedal tool list."
          )}
        </Field>
      </div>
      <h3 className="file-view-heading">How to use it</h3>
      {tool.body?.trim() ? (
        <div className="file-view-notes">
          <MarkdownPreview source={tool.body} />
        </div>
      ) : (
        <Empty>No instructions yet.</Empty>
      )}
    </>
  );
}

/** A file shown as the markdown it is, such as the choosing rules. */
export function MarkdownView({ empty, text }: { empty: string; text: string }) {
  return text.trim() ? (
    <div className="file-view-notes">
      <MarkdownPreview source={text} />
    </div>
  ) : (
    <Empty>{empty}</Empty>
  );
}

/**
 * The index: rules for every request. A topic file that did not become a tool
 * shows as a card under them.
 */
export function InstructionsIndexView({
  instructions,
  onTopic,
}: {
  instructions: InstructionFilesDto;
  onTopic: (name: string) => void;
}) {
  const always = alwaysRules(instructions.index.text);
  const topics = topicFacts(instructions);
  return (
    <>
      <p className="file-view-lede">
        Every session reads these, in every workspace.
      </p>
      <h3 className="file-view-heading">
        Always <small>{plural(always.length, "rule")}</small>
      </h3>
      {always.length ? (
        <ul className="rule-list">
          {always.map((rule, index) => (
            <li key={index}>
              <MarkdownPreview
                source={rule.replace(/^(?:[-*+]|\d+[.)])\s+/, "")}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          No rules for every request yet. Tell an agent "always …" and it adds
          one here.
        </Empty>
      )}
      {topics.length > 0 && (
        <>
          <h3 className="file-view-heading">
            Not moved to tools <small>{plural(topics.length, "topic")}</small>
          </h3>
          <div className="topic-cards">
            {topics.map((topic) => (
              <button
                className="topic-card"
                key={topic.name}
                onClick={() => onTopic(topic.name)}
                type="button"
              >
                <span className="topic-card-name">{topic.heading}</span>
                <span className="topic-card-covers">
                  {topic.covers ?? "Not listed in the index yet"}
                </span>
                <span className="topic-card-count">
                  {plural(topic.rules, "rule")}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** A topic: what the index says it covers, then its rules, each a card. */
export function TopicView({ covers, text }: { covers?: string; text: string }) {
  const found = rules(topicBody(text).split("\n"));
  return (
    <>
      {covers && <p className="file-view-lede">{covers}</p>}
      <h3 className="file-view-heading">
        Rules <small>{plural(found.length, "rule")}</small>
      </h3>
      {found.length ? (
        <ul className="rule-list">
          {found.map((rule, index) => (
            <li key={index}>
              <MarkdownPreview
                source={rule.replace(/^(?:[-*+]|\d+[.)])\s+/, "")}
              />
            </li>
          ))}
        </ul>
      ) : (
        <MarkdownView
          empty="No rules in this topic yet."
          text={topicBody(text)}
        />
      )}
    </>
  );
}
