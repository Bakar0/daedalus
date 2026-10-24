/**
 * Settings → Cloud → Your own gateway: install a Daedalus gateway on a
 * Kubernetes cluster this Mac can reach, or try one locally with kind, and
 * sign in to it (artifacts/cloud-sessions/gateway-install-api.md).
 *
 * The window sees context names and their API server's host, never a
 * credential. No context is chosen for the user. Nothing is written to a
 * cluster before a preflight, a dry run the user has read, and the context
 * name typed again. Everything that comes from a cluster or a tool is shown
 * as plain, shortened text.
 */
import React, { useEffect, useState } from "react";
import type {
  GatewayCheckDto,
  GatewayDryRunDto,
  GatewayInstallDto,
  GatewayInstallTargetInput,
  GatewayPreflightDto,
  GatewayToolDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { plainLine } from "./dialogs";
import { useRpcQuery } from "./use-rpc";

/** The steps an install goes through, as the window names them. */
const PHASE_LABEL: Record<GatewayInstallDto["phase"], string> = {
  checking: "Checking the cluster",
  cluster: "Creating the local cluster",
  gvisor: "Setting up gVisor",
  images: "Loading the images",
  installing: "Installing the gateway",
  waiting: "Waiting for the gateway to start",
  "signing-in": "Signing in",
  done: "Installed",
  failed: "The install stopped",
};

const CHECK_MARK: Record<GatewayCheckDto["status"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  unknown: "?",
};

/** Text from a cluster or a tool: control characters out, lines kept. */
const plainBlock = (text: string, max = 4000): string => {
  const flat = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .trimEnd();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** An install's progress, or how it ended, until dismissed. */
export function GatewayInstallProgress({
  install,
  onDismiss,
}: {
  install: GatewayInstallDto;
  onDismiss: () => void;
}) {
  const ended = install.phase === "done" || install.phase === "failed";
  const where =
    install.target.kind === "local"
      ? "on this Mac (kind)"
      : `on ${plainLine(install.target.context, 60)}`;
  return (
    <div
      className="gateway-install-progress"
      data-phase={install.phase}
      data-testid="gateway-install-progress"
      role="status"
    >
      <p className="gateway-install-phase">
        <strong>{PHASE_LABEL[install.phase]}</strong>
        <span>{where}</span>
      </p>
      {install.log.length > 0 && (
        <pre className="gateway-install-log" data-testid="gateway-install-log">
          {install.log
            .slice(-12)
            .map((line) => plainLine(line, 200))
            .join("\n")}
        </pre>
      )}
      {install.phase === "failed" && (
        <p className="accounts-error" role="alert">
          {plainLine(install.message ?? "The install stopped.", 300)}
        </p>
      )}
      {install.phase === "done" && install.gatewayUrl && (
        <p className="settings-note" data-testid="gateway-install-done">
          Signed in to <code>{plainLine(install.gatewayUrl, 120)}</code>.
          {install.portForward
            ? " Only this Mac can reach it: Daedalus keeps a port-forward to it open."
            : ""}
        </p>
      )}
      {ended && (
        <div className="cloud-actions">
          <button
            className="quiet"
            data-testid="gateway-install-dismiss"
            onClick={onDismiss}
            type="button"
          >
            {install.phase === "done" ? "Done" : "Dismiss"}
          </button>
        </div>
      )}
    </div>
  );
}

function MissingTools({ tools }: { tools: GatewayToolDto[] }) {
  const missing = tools.filter(
    (tool) => !tool.found || (tool.name === "docker" && tool.running === false),
  );
  if (!missing.length) return null;
  return (
    <ul className="gateway-install-tools" data-testid="gateway-install-tools">
      {missing.map((tool) => (
        <li key={tool.name}>
          <strong>{tool.name}</strong>{" "}
          {tool.found ? "is not running" : "is not installed"}
          {tool.hint ? (
            <>
              : <code>{plainLine(tool.hint, 80)}</code>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Checks({ preflight }: { preflight: GatewayPreflightDto }) {
  return (
    <ul className="gateway-install-checks" data-testid="gateway-install-checks">
      {preflight.checks.map((check) => (
        <li data-check={check.id} data-status={check.status} key={check.id}>
          <span aria-hidden="true" className="gateway-install-mark">
            {CHECK_MARK[check.status]}
          </span>
          <span>
            {plainLine(check.label, 120)}
            {check.detail ? (
              <small>{plainBlock(check.detail, 600)}</small>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The install itself: contexts, then for the chosen one a preflight, a dry
 * run, and the install once its name is typed again. "Try it locally"
 * makes a kind cluster through Docker instead.
 */
export function GatewayInstall({
  client,
  install,
  onSignedIn,
}: {
  client: DesktopClient;
  /** The snapshot's install, while one runs or until dismissed. */
  install?: GatewayInstallDto;
  /** After an install signed this Mac in. */
  onSignedIn: () => void;
}) {
  const [open, setOpen] = useState(Boolean(install));
  useEffect(() => {
    if (install) setOpen(true);
  }, [install]);
  const done = install?.phase === "done";
  useEffect(() => {
    if (done) onSignedIn();
    // `onSignedIn` is a fresh closure on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const dismiss = () => void client.request.gatewayInstallDismiss({});
  return (
    <details
      className="gateway-install"
      data-testid="gateway-install"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <h3>Your own gateway</h3>
      </summary>
      <p className="settings-note">
        Install a Daedalus gateway on a Kubernetes cluster you can reach, then
        this Mac signs in to it. Nothing changes on a cluster until you have
        seen what the install creates and typed the cluster's name.
      </p>
      {install ? (
        <GatewayInstallProgress install={install} onDismiss={dismiss} />
      ) : open ? (
        <GatewayInstallForm client={client} />
      ) : null}
    </details>
  );
}

function GatewayInstallForm({ client }: { client: DesktopClient }) {
  const tools = useRpcQuery(() => client.request.gatewayInstallContexts({}), {
    deps: [client],
  });
  const [context, setContext] = useState<string>();
  const [namespace, setNamespace] = useState("daedalus");
  const [storageClass, setStorageClass] = useState("");
  const [registry, setRegistry] = useState("");
  const [tag, setTag] = useState("");
  const [preflight, setPreflight] = useState<GatewayPreflightDto>();
  const [dryRun, setDryRun] = useState<GatewayDryRunDto>();
  const [email, setEmail] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState<string>();
  const [failure, setFailure] = useState<string>();

  // A change to what would be installed asks for a new check and preview.
  const target = (): GatewayInstallTargetInput => ({
    context: context!,
    ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
    ...(storageClass.trim() ? { storageClass: storageClass.trim() } : {}),
    ...(registry.trim() && tag.trim()
      ? { images: { registry: registry.trim(), tag: tag.trim() } }
      : {}),
  });
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPreflight(undefined);
      setDryRun(undefined);
      setConfirm("");
      setFailure(undefined);
    };

  const run = async <T,>(
    what: string,
    request: () => Promise<
      { ok: true; data: T } | { ok: false; error: { message: string } }
    >,
  ): Promise<T | undefined> => {
    setWorking(what);
    setFailure(undefined);
    try {
      const response = await request();
      if (response.ok) return response.data;
      setFailure(response.error.message);
      return undefined;
    } finally {
      setWorking(undefined);
    }
  };

  const check = async () => {
    setDryRun(undefined);
    setPreflight(
      await run("check", () =>
        client.request.gatewayInstallPreflight(target()),
      ),
    );
  };
  const preview = async () => {
    setDryRun(
      await run("preview", () => client.request.gatewayInstallDryRun(target())),
    );
  };
  const start = async () => {
    if (!dryRun) return;
    await run("install", () =>
      client.request.gatewayInstallStart({
        ...target(),
        dryRunId: dryRun.dryRunId,
        confirm,
        email: email.trim(),
        ...(publicUrl.trim()
          ? { publicUrl: publicUrl.trim(), acknowledgeDevLogin: acknowledged }
          : {}),
      }),
    );
  };
  const tryLocally = async () => {
    await run("local", () =>
      client.request.gatewayInstallLocal({ email: email.trim() }),
    );
  };

  const contexts = tools.data?.contexts ?? [];
  const toolList = tools.data?.tools ?? [];
  const has = (name: GatewayToolDto["name"]) =>
    toolList.some(
      (tool) =>
        tool.name === name &&
        tool.found &&
        (name !== "docker" || tool.running !== false),
    );
  const canCluster = has("kubectl") && has("helm");
  const canLocal = canCluster && has("kind") && has("docker");
  const needsAcknowledgement = Boolean(publicUrl.trim());
  const canInstall =
    Boolean(dryRun) &&
    confirm === context &&
    Boolean(email.trim()) &&
    (!needsAcknowledgement || acknowledged) &&
    !working;

  const emailField = (
    <label className="settings-choice">
      <span>
        <strong>Your email</strong>
        <small>This Mac signs in with it once the gateway is up</small>
      </span>
      <input
        aria-label="Your email"
        autoComplete="email"
        data-testid="gateway-install-email"
        disabled={Boolean(working)}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        type="email"
        value={email}
      />
    </label>
  );

  return (
    <div className="gateway-install-form">
      {tools.error ? (
        <p className="accounts-error" role="alert">
          {tools.error}
        </p>
      ) : null}
      {tools.data && <MissingTools tools={toolList} />}
      {tools.data && contexts.length === 0 ? (
        <div
          className="gateway-install-empty"
          data-testid="gateway-install-empty"
        >
          <p className="settings-note">
            Your kubeconfig has no clusters. Try a gateway on this Mac first, or
            set up a cluster on AWS with the guide.
          </p>
        </div>
      ) : null}
      {contexts.length > 0 && (
        <fieldset
          className="gateway-install-contexts"
          data-testid="gateway-install-contexts"
        >
          <legend>Cluster</legend>
          {contexts.map((one) => (
            <label
              className="settings-row"
              data-context={one.name}
              data-testid="gateway-install-context"
              key={one.name}
            >
              <input
                checked={context === one.name}
                disabled={Boolean(working) || !canCluster}
                name="gateway-install-context"
                onChange={() => changed(setContext)(one.name)}
                type="radio"
              />
              <span>
                <strong>{plainLine(one.name, 80)}</strong>
                <small>{plainLine(one.serverHost, 80)}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {context && (
        <div
          className="gateway-install-target"
          data-testid="gateway-install-target"
        >
          <label className="settings-choice">
            <span>
              <strong>Namespace</strong>
            </span>
            <input
              aria-label="Namespace"
              data-testid="gateway-install-namespace"
              disabled={Boolean(working)}
              onChange={(event) => changed(setNamespace)(event.target.value)}
              value={namespace}
            />
          </label>
          <label className="settings-choice">
            <span>
              <strong>Storage class</strong>
              <small>Only when the cluster has no default one</small>
            </span>
            <input
              aria-label="Storage class"
              data-testid="gateway-install-storage-class"
              disabled={Boolean(working)}
              onChange={(event) => changed(setStorageClass)(event.target.value)}
              placeholder="default"
              value={storageClass}
            />
          </label>
          <label className="settings-choice">
            <span>
              <strong>Images</strong>
              <small>
                The registry you pushed the gateway and runner images to, and
                their tag
              </small>
            </span>
            <span className="gateway-install-images">
              <input
                aria-label="Image registry"
                data-testid="gateway-install-registry"
                disabled={Boolean(working)}
                onChange={(event) => changed(setRegistry)(event.target.value)}
                placeholder="123456789012.dkr.ecr.eu-west-1.amazonaws.com"
                value={registry}
              />
              <input
                aria-label="Image tag"
                data-testid="gateway-install-tag"
                disabled={Boolean(working)}
                onChange={(event) => changed(setTag)(event.target.value)}
                placeholder="0.31.0"
                value={tag}
              />
            </span>
          </label>
          <div className="cloud-actions">
            <button
              data-testid="gateway-install-check"
              disabled={Boolean(working)}
              onClick={() => void check()}
              type="button"
            >
              {working === "check" ? "Checking…" : "Check this cluster"}
            </button>
          </div>
        </div>
      )}
      {preflight && (
        <div className="gateway-install-preflight">
          <Checks preflight={preflight} />
          {preflight.release ? (
            <p className="settings-note" data-testid="gateway-install-upgrade">
              A gateway is already installed in{" "}
              {plainLine(preflight.release.namespace, 60)} (revision{" "}
              {preflight.release.revision}); this upgrades it.
            </p>
          ) : null}
          {preflight.ready ? (
            <div className="cloud-actions">
              <button
                data-testid="gateway-install-preview"
                disabled={Boolean(working)}
                onClick={() => void preview()}
                type="button"
              >
                {working === "preview" ? "Preparing…" : "See what it creates"}
              </button>
            </div>
          ) : (
            <p className="settings-note" data-testid="gateway-install-blocked">
              Fix what is marked ✕, then check again.
            </p>
          )}
        </div>
      )}
      {dryRun && context && (
        <div
          className="gateway-install-dry-run"
          data-testid="gateway-install-dry-run"
        >
          <p className="settings-note">
            {dryRun.upgrade ? "Upgrading" : "Installing"} creates or changes{" "}
            {dryRun.objects.length} objects in {plainLine(dryRun.namespace, 60)}
            :
          </p>
          <ul
            className="gateway-install-objects"
            data-testid="gateway-install-objects"
          >
            {dryRun.objects.map((object, index) => (
              <li key={index}>
                <span>{plainLine(object.kind, 40)}</span>{" "}
                <code>{plainLine(object.name, 80)}</code>
              </li>
            ))}
          </ul>
          {dryRun.notes.trim() ? (
            <details className="gateway-install-notes">
              <summary>Notes from helm</summary>
              <pre>{plainBlock(dryRun.notes)}</pre>
            </details>
          ) : null}
          {emailField}
          <label className="settings-choice">
            <span>
              <strong>Public address</strong>
              <small>
                Your Ingress or load balancer. Leave empty and only this Mac can
                reach it, through a port-forward Daedalus keeps.
              </small>
            </span>
            <input
              aria-label="Public address"
              data-testid="gateway-install-public-url"
              disabled={Boolean(working)}
              onChange={(event) => {
                setPublicUrl(event.target.value);
                setAcknowledged(false);
              }}
              placeholder="https://daedalus.example.com"
              type="url"
              value={publicUrl}
            />
          </label>
          {needsAcknowledgement && (
            <label className="settings-row gateway-install-acknowledge">
              <input
                checked={acknowledged}
                data-testid="gateway-install-acknowledge"
                disabled={Boolean(working)}
                onChange={(event) => setAcknowledged(event.target.checked)}
                type="checkbox"
              />
              <span>
                Anyone who can reach this gateway can sign in as any email until
                company sign-in is set up.
              </span>
            </label>
          )}
          <label className="settings-choice">
            <span>
              <strong>Type {plainLine(context, 80)} to install</strong>
            </span>
            <input
              aria-label="Cluster name to confirm"
              autoComplete="off"
              data-testid="gateway-install-confirm"
              disabled={Boolean(working)}
              onChange={(event) => setConfirm(event.target.value)}
              spellCheck={false}
              value={confirm}
            />
          </label>
          <div className="cloud-actions">
            <button
              className="danger-action"
              data-testid="gateway-install-start"
              disabled={!canInstall}
              onClick={() => void start()}
              type="button"
            >
              {working === "install" ? "Starting…" : "Install on this cluster"}
            </button>
          </div>
        </div>
      )}
      <div
        className="gateway-install-local"
        data-testid="gateway-install-local"
      >
        <p className="settings-note">
          <strong>Try it locally.</strong> A cluster on this Mac through Docker
          (kind), with the gateway installed and signed in. Your kubeconfig is
          left as it is.
        </p>
        {!dryRun && emailField}
        <div className="cloud-actions">
          <button
            className="quiet"
            data-testid="gateway-install-try-local"
            disabled={Boolean(working) || !canLocal || !email.trim()}
            onClick={() => void tryLocally()}
            title={
              canLocal
                ? undefined
                : "Needs kubectl, helm, kind and Docker running"
            }
            type="button"
          >
            {working === "local" ? "Starting…" : "Try it locally"}
          </button>
          <button
            className="quiet link"
            data-testid="gateway-install-aws-guide"
            // The copy the app carries: the repository's is not public yet.
            onClick={() =>
              void run("guide", () =>
                client.request.gatewayInstallGuideOpen({}),
              )
            }
            type="button"
          >
            Set up on AWS (guide)
          </button>
        </div>
      </div>
      {failure ? (
        <p
          className="accounts-error"
          data-testid="gateway-install-error"
          role="alert"
        >
          {plainLine(failure, 300)}
        </p>
      ) : null}
    </div>
  );
}
