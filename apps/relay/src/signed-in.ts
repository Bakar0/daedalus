/**
 * Where a sign-in lands until the phone web app exists: reads the token from
 * the URL fragment, asks `/v1/me` who it is, and says so. The token never
 * leaves the page except to the relay itself.
 */
export const SIGNED_IN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daedalus sign-in</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fbfbfd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #111113; } }
  body { margin: 0; padding: 48px 16px; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 8px; color: var(--muted); }
</style>
</head>
<body>
<main><h1 id="title">Signing in…</h1><p id="detail"></p></main>
<script>
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const title = document.getElementById("title");
const detail = document.getElementById("detail");
const errors = {
  invite_required: "This account is new and needs an invite code.",
  invite_invalid: "That invite code is not valid or was already used.",
  google_failed: "Google did not confirm the sign-in. Try again.",
  cancelled: "The sign-in was cancelled.",
};
if (params.get("error")) {
  title.textContent = "Not signed in";
  detail.textContent = errors[params.get("error")] || params.get("error");
} else if (params.get("token")) {
  fetch("/v1/me", { headers: { Authorization: "Bearer " + params.get("token") } })
    .then((response) => response.json())
    .then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      title.textContent = "Signed in";
      const plan = result.data.entitlement;
      detail.textContent = result.data.user.email + (plan ? " · " + plan.plan + " plan" : " · no active access");
    })
    .catch((error) => { title.textContent = "Not signed in"; detail.textContent = error.message; });
} else {
  title.textContent = "Nothing to show";
}
</script>
</body>
</html>`;
