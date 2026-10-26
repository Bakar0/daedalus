/**
 * The read views of the Workflows and Custom instructions tabs: each file as
 * an agent takes it in, before anyone opens its markdown. A workflow is its
 * purpose and a numbered line of steps, a step is its instructions and the
 * workflows that use it, and the instructions are the rules for every
 * request and one card per topic.
 */
import type { ReactNode } from "react";
import type { InstructionFilesDto, WorkflowFileDto } from "@daedalus/protocol";
import { MarkdownPreview } from "./markdown-preview";

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

/** A workflow: what it is for, when it fits, and its steps in order. */
export function WorkflowView({
  flow,
  onStep,
  steps,
}: {
  flow: WorkflowFileDto;
  onStep: (name: string) => void;
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
      <h3 className="file-view-heading">Steps</h3>
      {flow.dynamic ? (
        <Empty>
          The agent names its steps each run, for the work in front of it.
        </Empty>
      ) : (
        <ol className="step-timeline">
          {(flow.steps ?? []).map((name, index) => {
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
                    {step?.gate && <span className="workflow-gate">gate</span>}
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
export function StepView({
  flows,
  onFlow,
  step,
}: {
  flows: WorkflowFileDto[];
  onFlow: (name: string) => void;
  step: WorkflowFileDto;
}) {
  const usedBy = flows.filter((flow) => flow.steps?.includes(step.name));
  return (
    <>
      {step.description && <p className="file-view-lede">{step.description}</p>}
      <div className="file-view-fields">
        {step.gate && (
          <Field label="Gate">
            Waits for your approval in the Workflow pane before it starts.
          </Field>
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
      </div>
      <h3 className="file-view-heading">What the agent does</h3>
      {step.body?.trim() ? (
        <div className="file-view-notes">
          <MarkdownPreview source={step.body} />
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

/** The index: rules for every request, then one card per topic. */
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
      <h3 className="file-view-heading">
        Topics <small>{plural(topics.length, "topic")}</small>
      </h3>
      {topics.length ? (
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
      ) : (
        <Empty>
          No topics yet. Rules about one subject, such as git or code review, go
          in a topic of their own; agents open it only when it applies.
        </Empty>
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
