import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatInviteCode, inviteCodeComplete } from "@daedalus/protocol";
import {
  decodePairingOffer,
  RelayAccount,
  RelayError,
  type PairedMac,
  type PairingOffer,
  pairingCode,
  pairWithMac,
} from "@daedalus/remote-protocol";
import { Account } from "./Account";
import { RELOCK_AFTER_MS, unlockApp } from "./lock";
import { Home } from "./Home";
import { setPro } from "./plan";
import { Shell } from "./Shell";
import {
  addMac,
  appLock,
  forgetEverything,
  isLocked,
  relock,
  pairedMacs,
  pendingInvite,
  pendingPair,
  phoneIdentity,
  removeMac,
  setPendingInvite,
  setPendingPair,
  setToken,
  signInNonce,
  startSignIn,
  storedToken,
} from "./storage";

const SIGN_IN_ERRORS: Record<string, string> = {
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
 * (in the fragment, which no server sees), a pairing code from a scanned
 * QR code (`/pair#…`), or an invite code from an invite link
 * (`/?invite=…`). Each is taken out of the address at once.
 *
 * A token is taken only from a sign-in this tab started: the return address
 * carries a nonce this tab keeps. A link someone sent with their own token
 * in it does nothing.
 */
function takeFromAddress(): { error?: string } {
  const fragment = location.hash.slice(1);
  if (location.pathname === "/pair" && fragment) {
    setPendingPair(fragment);
    history.replaceState(null, "", "/");
    return {};
  }
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite !== null) {
    const code = formatInviteCode(invite);
    if (inviteCodeComplete(code)) setPendingInvite(code);
    history.replaceState(null, "", location.pathname);
    return {};
  }
  const params = new URLSearchParams(fragment);
  const token = params.get("token");
  const error = params.get("error");
  const nonce = new URLSearchParams(location.search).get("signin");
  const ours = nonce !== null && nonce === signInNonce();
  if (token || error || nonce !== null)
    history.replaceState(null, "", location.pathname);
  if (!ours) return {};
  if (token) {
    // Locked, the token waits in this tab until the passkey opens storage.
    if (isLocked()) arriving = token;
    else setToken(token);
  }
  return error ? { error } : {};
}

let arriving: string | undefined;

/**
 * Locked when the app opens, and again after five minutes in the
 * background. Returns whether it is locked now, and how to mark it open.
 */
function useAppLock(): [boolean, () => void] {
  const [locked, setLocked] = useState(isLocked);
  useEffect(() => {
    let hiddenAt = 0;
    const change = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (
        appLock() &&
        hiddenAt &&
        Date.now() - hiddenAt > RELOCK_AFTER_MS
      ) {
        relock();
        setLocked(true);
      }
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return [locked, () => setLocked(false)];
}

function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [error, setError] = useState<string>();
  const open = () =>
    unlockApp().then(onUnlocked, (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  return (
    <div className="signin">
      <img alt="" className="signin-logo" src="/icon-192.png" />
      <h1>Daedalus is locked</h1>
      <p className="signin-lead">Unlock with this phone's passkey.</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : undefined}
      <button className="button primary" onClick={open}>
        Unlock
      </button>
      <button
        className="link danger"
        onClick={() => {
          if (
            !confirm(
              "Forget everything on this phone? You sign in and pair again, and should remove the old phone from your Mac.",
            )
          )
            return;
          forgetEverything();
          location.reload();
        }}
      >
        Lost the passkey? Start over
      </button>
    </div>
  );
}

export function App() {
  const [{ error: signInError }] = useState(takeFromAddress);
  const [token, setTokenState] = useState(storedToken);
  const [macs, setMacs] = useState(pairedMacs);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"home" | "account">("home");
  const [locked, markUnlocked] = useAppLock();

  const signOut = () => {
    setToken(undefined);
    setTokenState(undefined);
  };
  /** Signs out here and goes straight back to Google to pick another. */
  const switchAccount = async () => {
    if (token)
      await new RelayAccount(location.origin, token)
        .signOut()
        .catch(() => undefined);
    setToken(undefined);
    startGoogleSignIn();
  };
  const me = useMe(locked ? undefined : token, signOut);
  useEffect(() => {
    if (me.state === "ready") setPro(Boolean(me.plan));
    // A plan, from the invite at sign-in or before it: the link is spent.
    if (me.state === "ready" && me.plan) setPendingInvite(undefined);
    if (!token) setPro(false);
  }, [me, token]);

  if (locked)
    return (
      <Unlock
        onUnlocked={() => {
          if (arriving) setToken(arriving);
          arriving = undefined;
          setTokenState(storedToken());
          setMacs(pairedMacs());
          markUnlocked();
        }}
      />
    );

  if (!token) return <SignIn error={signInError} />;

  // Who is signed in, before anything else. If the relay cannot be reached
  // the app goes on with what it has; the Mac's screen says the rest.
  if (me.state === "loading")
    return (
      <Shell title="Daedalus">
        <div className="spinner centered" />
      </Shell>
    );
  const who =
    me.state === "ready" ? (
      <SignedInAs email={me.email} onSwitch={switchAccount} />
    ) : undefined;
  if (me.state === "ready" && !me.plan)
    return <ProScreen onRedeemed={me.reload} token={token} who={who} />;

  const pending = pendingPair();
  if (pending)
    return (
      <Pairing
        code={pending}
        onSwitch={switchAccount}
        who={who}
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
          {who}
          <h2>Pair your Mac</h2>
          <ol>
            <li>On your Mac, open Daedalus › Settings › Remote.</li>
            <li>Turn on Allow phone access and sign in with this account.</li>
            <li>
              Click Show pairing code and scan it with this phone's camera.
            </li>
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

/** Sends this tab to Google; it comes back with a sign-in for this phone. */
function startGoogleSignIn(): void {
  const start = new URL("/auth/google/start", location.origin);
  // The sign-in is this phone's from the start, so it can only ever let
  // this phone in.
  start.searchParams.set("device", phoneIdentity().id);
  start.searchParams.set(
    "return",
    `${location.origin}/?signin=${startSignIn()}`,
  );
  // The relay redeems an invite link's code once the account is known.
  const invite = pendingInvite();
  if (invite) start.searchParams.set("invite", invite);
  location.assign(start.toString());
}

function SignIn({ error }: { error?: string }) {
  return (
    <div className="signin">
      <img alt="" className="signin-logo" src="/icon-192.png" />
      <h1>Sign in to Daedalus</h1>
      <p className="signin-lead">
        Operate the sessions on your Mac from your phone. Use the Google account
        your Mac is signed in with.
      </p>
      {pendingPair() ? (
        <p className="note">Sign in to finish pairing with your Mac.</p>
      ) : pendingInvite() ? (
        <p className="note">
          You have an invite to Daedalus Pro. Sign in with the Google account
          you use in Daedalus on your Mac, and the plan goes to that account.
        </p>
      ) : undefined}
      {error ? (
        <p className="error" role="alert">
          {SIGN_IN_ERRORS[error] ?? error}
        </p>
      ) : undefined}
      <button className="button primary google" onClick={startGoogleSignIn}>
        Continue with Google
      </button>
      <p className="fine">
        Phone access is part of Daedalus Pro. 🔒 The relay forwards encrypted
        data between your phone and your Mac and cannot read it. This page
        itself comes from the relay.
      </p>
    </div>
  );
}

type Me =
  | { state: "loading" }
  | { state: "unknown" }
  | {
      state: "ready";
      email: string;
      plan: { name: string; expiresAt: string | null } | null;
      reload: () => void;
    };

/** The signed-in account and its plan, asked of the relay once per open. */
function useMe(token: string | undefined, onSignedOut: () => void): Me {
  const [me, setMe] = useState<Me>({ state: "loading" });
  const [round, setRound] = useState(0);
  const shownFor = useRef<string | undefined>(undefined);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // A new sign-in starts from nothing; a reload keeps the screen.
    if (shownFor.current !== token) setMe({ state: "loading" });
    shownFor.current = token;
    new RelayAccount(location.origin, token).me().then(
      (data) => {
        if (cancelled) return;
        setMe({
          state: "ready",
          email: data.user.email,
          plan: data.entitlement
            ? {
                name: data.entitlement.plan,
                expiresAt: data.entitlement.expiresAt,
              }
            : null,
          reload: () => setRound((value) => value + 1),
        });
      },
      (failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof RelayError && failure.code === "UNAUTHORIZED")
          signedOut.current();
        else setMe({ state: "unknown" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, round]);
  return me;
}

/**
 * Who is signed in, with a way to pick another Google account. Google may
 * pick the phone's only account without asking, so this is where a wrong
 * one is noticed and changed.
 */
function SignedInAs({
  email,
  onSwitch,
}: {
  email: string;
  onSwitch: () => void;
}) {
  return (
    <p className="signed-in-as">
      Signed in as <strong>{email}</strong>
      <button className="link" onClick={onSwitch}>
        Use a different account
      </button>
    </p>
  );
}

/** An account with no plan: what Pro is, and an invite code. */
function ProScreen({
  token,
  who,
  onRedeemed,
}: {
  token: string;
  who: ReactNode;
  onRedeemed: () => void;
}) {
  // An invite link's code that the sign-in did not use (the account had a
  // revoked plan, or the code ran out): shown so the error can say why.
  const [code, setCode] = useState(() => pendingInvite() ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Daedalus Pro">
      <section className="empty pro">
        {who}
        <h2>
          Phone access needs Daedalus <span className="pro-badge">Pro</span>
        </h2>
        <ul className="pro-list">
          <li>Watch and steer your Mac's sessions from anywhere</li>
          <li>Open a live terminal and answer an agent that needs you</li>
          <li>Notifications when a session needs you while you're away</li>
          <li>The board, end-to-end encrypted through the relay</li>
        </ul>
        <p>
          This account has no Pro plan
          {pendingPair() ? ", so it can't pair yet" : ""}. Paid plans are on the
          way. For now, Pro comes with an invite code.
        </p>
        <form
          className="invite"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(undefined);
            setBusy(true);
            try {
              await new RelayAccount(location.origin, token).redeemInvite(code);
              onRedeemed();
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Invite code</span>
            <input
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={11}
              onChange={(event) =>
                setCode(formatInviteCode(event.target.value))
              }
              placeholder="XXXXX-XXXXX"
              spellCheck={false}
              value={code}
            />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : undefined}
          <button
            className="button primary"
            disabled={busy || !inviteCodeComplete(code)}
            type="submit"
          >
            Get Pro with this code
          </button>
        </form>
      </section>
    </Shell>
  );
}

/**
 * A code works once, so a second attempt (React running an effect twice, a
 * re-render) must join the first rather than spend the code again.
 */
const pairings = new Map<string, Promise<PairedMac>>();
function pairOnce(
  offer: PairingOffer,
  code: string,
  token: string,
  onWaiting: () => void,
): Promise<PairedMac> {
  let pairing = pairings.get(code);
  if (!pairing) {
    pairing = pairWithMac(phoneIdentity(), offer, phoneName(), token, {
      relay: location.origin,
      onWaiting,
    });
    pairings.set(code, pairing);
  }
  return pairing;
}

function readOffer(code: string): PairingOffer | string {
  try {
    const offer = decodePairingOffer(code);
    if (new URL(offer.relay).host !== location.host)
      return "This pairing code is for a different relay.";
    return offer;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Pairing asks first: a link can arrive from anywhere, not only from the
 * Mac's screen. Then both screens show the same six digits, and the Mac's
 * user allows the phone there.
 */
function Pairing({
  code,
  token,
  who,
  onSwitch,
  onDone,
}: {
  code: string;
  token: string;
  who: ReactNode;
  onSwitch: () => void;
  onDone: (mac: PairedMac | undefined) => void;
}) {
  const [offer] = useState(() => readOffer(code));
  const [stage, setStage] = useState<"ask" | "claiming" | "waiting">("ask");
  const [error, setError] = useState<string>(
    typeof offer === "string" ? offer : "",
  );
  const [wrongAccount, setWrongAccount] = useState(false);
  const finish = useRef(onDone);
  finish.current = onDone;
  useEffect(() => {
    if (stage === "ask" || typeof offer === "string") return;
    let cancelled = false;
    pairOnce(offer, code, token, () => {
      if (!cancelled) setStage("waiting");
    }).then(
      (mac) => {
        if (!cancelled) finish.current(mac);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setWrongAccount(
          failure instanceof RelayError && failure.code === "WRONG_ACCOUNT",
        );
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [stage === "ask", code, token]);

  const digits =
    typeof offer === "string" ? "" : pairingCode(offer, phoneIdentity());
  return (
    <Shell title="Pairing">
      <section className="empty">
        {error ? (
          <>
            <h2>{wrongAccount ? "Different account" : "Pairing failed"}</h2>
            <p className="error">{error}</p>
            {wrongAccount ? (
              <>
                <p>
                  Sign in with the Mac's account, then scan a new pairing code.
                </p>
                <button className="button primary" onClick={onSwitch}>
                  Use a different account
                </button>
              </>
            ) : (
              <p>Show a new pairing code on your Mac and scan it again.</p>
            )}
            <button className="button" onClick={() => onDone(undefined)}>
              OK
            </button>
          </>
        ) : stage === "ask" && typeof offer !== "string" ? (
          <>
            {who}
            <h2>Pair with “{offer.name}”?</h2>
            <p>
              Only continue if you just scanned the code on your own Mac's
              screen. A paired Mac sees what you type and send here.
            </p>
            <button
              className="button primary"
              onClick={() => setStage("claiming")}
            >
              Pair
            </button>
            <button className="link" onClick={() => onDone(undefined)}>
              Cancel
            </button>
          </>
        ) : stage === "waiting" ? (
          <>
            <h2>Allow this phone on your Mac</h2>
            <p>Your Mac shows a code. Check that it matches:</p>
            <p className="pair-code">
              {digits.slice(0, 3)} {digits.slice(3)}
            </p>
            <p>Then click Allow in Daedalus › Settings › Remote.</p>
            <div className="spinner" />
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
