import { useEffect, useRef, useState } from "react";
import {
  decodePairingOffer,
  type PairedMac,
  pairWithMac,
} from "@daedalus/remote-protocol";
import { Account } from "./Account";
import { Home } from "./Home";
import { Shell } from "./Shell";
import {
  addMac,
  pairedMacs,
  pendingPair,
  phoneIdentity,
  removeMac,
  setPendingPair,
  setToken,
  storedToken,
} from "./storage";

const SIGN_IN_ERRORS: Record<string, string> = {
  invite_required: "This Google account is new here. Enter your invite code.",
  invite_invalid: "That invite code is not valid or was already used.",
  google_failed: "Google did not confirm the sign-in. Try again.",
  cancelled: "Sign-in was cancelled.",
};

/** A readable phone name for the Mac's list of paired phones. */
function phoneName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(agent);
  if (android?.[1] && android[1] !== "K") return android[1].trim();
  if (/Android/.test(agent)) return "Android phone";
  return "Browser";
}

/**
 * Reads what the address brought: a session token or error from a sign-in
 * (in the fragment, which no server sees), or a pairing code from a scanned
 * QR code (`/pair#…`). Both are taken out of the address at once.
 */
function takeFromAddress(): { error?: string } {
  const fragment = location.hash.slice(1);
  if (location.pathname === "/pair" && fragment) {
    setPendingPair(fragment);
    history.replaceState(null, "", "/");
    return {};
  }
  const params = new URLSearchParams(fragment);
  const token = params.get("token");
  const error = params.get("error");
  if (token) setToken(token);
  if (token || error) history.replaceState(null, "", location.pathname);
  return error ? { error } : {};
}

export function App() {
  const [{ error: signInError }] = useState(takeFromAddress);
  const [token, setTokenState] = useState(storedToken);
  const [macs, setMacs] = useState(pairedMacs);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"home" | "account">("home");

  const signOut = () => {
    setToken(undefined);
    setTokenState(undefined);
  };

  if (!token) return <SignIn error={signInError} />;

  const pending = pendingPair();
  if (pending)
    return (
      <Pairing
        code={pending}
        token={token}
        onDone={(mac) => {
          setPendingPair(undefined);
          if (mac) {
            addMac(mac);
            setMacs(pairedMacs());
            setSelected(mac.macId);
          } else setMacs(pairedMacs());
        }}
      />
    );

  if (view === "account")
    return (
      <Account
        macs={macs}
        onBack={() => setView("home")}
        onSignOut={signOut}
        token={token}
      />
    );

  if (macs.length === 0)
    return (
      <Shell onAccount={() => setView("account")} title="Daedalus">
        <section className="empty">
          <h2>Pair your Mac</h2>
          <ol>
            <li>On your Mac, open Daedalus › Settings › Remote.</li>
            <li>Turn on Allow phone access.</li>
            <li>Tap Show pairing code and scan it with this phone's camera.</li>
          </ol>
        </section>
      </Shell>
    );

  const mac = macs.find((item) => item.macId === selected) ?? macs[0]!;
  return (
    <Home
      key={mac.macId}
      mac={mac}
      macs={macs}
      onAccount={() => setView("account")}
      onForget={() => {
        removeMac(mac.macId);
        setMacs(pairedMacs());
      }}
      onSelectMac={setSelected}
      onSignOut={signOut}
      token={token}
    />
  );
}

function SignIn({ error }: { error?: string }) {
  const [invite, setInvite] = useState("");
  const [showInvite, setShowInvite] = useState(
    error === "invite_required" || error === "invite_invalid",
  );
  const start = new URL("/auth/google/start", location.origin);
  start.searchParams.set("return", `${location.origin}/`);
  if (invite.trim()) start.searchParams.set("invite", invite.trim());
  return (
    <div className="signin">
      <img alt="" className="signin-logo" src="/icon-192.png" />
      <h1>Daedalus</h1>
      <p className="signin-lead">
        Operate the sessions on your Mac from your phone.
      </p>
      {pendingPair() ? (
        <p className="note">Sign in to finish pairing with your Mac.</p>
      ) : undefined}
      {error ? (
        <p className="error" role="alert">
          {SIGN_IN_ERRORS[error] ?? error}
        </p>
      ) : undefined}
      {showInvite ? (
        <label className="field">
          <span>Invite code</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(event) => setInvite(event.target.value)}
            placeholder="XXXXX-XXXXX"
            value={invite}
          />
        </label>
      ) : undefined}
      <a className="button primary google" href={start.toString()}>
        Continue with Google
      </a>
      {showInvite ? undefined : (
        <button className="link" onClick={() => setShowInvite(true)}>
          I have an invite code
        </button>
      )}
      <p className="fine">
        🔒 Everything between your phone and your Mac is end-to-end encrypted.
      </p>
    </div>
  );
}

/**
 * A code works once, so a second attempt (React running an effect twice, a
 * re-render) must join the first rather than spend the code again.
 */
const pairings = new Map<string, Promise<PairedMac>>();
function pairOnce(code: string, token: string): Promise<PairedMac> {
  let pairing = pairings.get(code);
  if (!pairing) {
    pairing = (async () =>
      pairWithMac(
        phoneIdentity(),
        decodePairingOffer(code),
        phoneName(),
        token,
      ))();
    pairings.set(code, pairing);
  }
  return pairing;
}

function Pairing({
  code,
  token,
  onDone,
}: {
  code: string;
  token: string;
  onDone: (mac: PairedMac | undefined) => void;
}) {
  const [error, setError] = useState<string>();
  const finish = useRef(onDone);
  finish.current = onDone;
  useEffect(() => {
    let cancelled = false;
    pairOnce(code, token).then(
      (mac) => {
        if (!cancelled) finish.current(mac);
      },
      (failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, token]);
  return (
    <Shell title="Pairing">
      <section className="empty">
        {error ? (
          <>
            <h2>Pairing failed</h2>
            <p className="error">{error}</p>
            <p>Show a new pairing code on your Mac and scan it again.</p>
            <button className="button" onClick={() => onDone(undefined)}>
              OK
            </button>
          </>
        ) : (
          <>
            <div className="spinner" />
            <h2>Pairing with your Mac…</h2>
          </>
        )}
      </section>
    </Shell>
  );
}
