# Dashboard integration — build your own "View on dashboard" target

Open Poll Plus can show a **View on dashboard** entry in the per-poll menu that opens an
**external dashboard** for that specific poll. The app is dashboard-agnostic: it just
mints a short-lived, signed token and opens the user's browser at a URL you configure.
Any dashboard that verifies the token the way described below can be the target.

This document is the complete wire contract — enough to implement a compatible dashboard
in any language. No private code is required.

## How it works (overview)

1. An operator sets three server config keys: `dashboard_url`, `dashboard_link_secret`,
   and (to show the menu) `show_dashboard_link: true`.
2. A poll **creator** or workspace **installer** clicks **View on dashboard** on a poll.
3. The app mints a short-lived **HMAC-SHA256** token carrying *who clicked* and *which
   poll*, signed with `dashboard_link_secret`.
4. The app sends the user an ephemeral message with a button that opens:

   ```
   <dashboard_url>/#/h/<TOKEN>
   ```

5. Your dashboard reads the token, **verifies the signature + freshness**, then shows
   that poll to that user under *your own* permission rules.

The token is a **signed assertion of identity + intent** ("Slack user `uid` in team
`tid` asked to open poll `pid`"), **not** an authorization grant. Your dashboard decides
what the user may see.

## Configuration (in the Slack app)

Set these in `config/default.json` (server-level only — not per-team):

| Key | Default | Meaning |
| --- | --- | --- |
| `dashboard_url` | example URL | Base URL of your dashboard. The app opens `<dashboard_url>/#/h/<TOKEN>` (trailing slashes are trimmed before appending). Point it at the page that reads the token. |
| `dashboard_link_secret` | `""` | Shared secret for the HMAC. **Use ≥32 random bytes.** Your dashboard verifies with the *same* value. Empty ⇒ the menu entry never shows. |
| `dashboard_link_ttl_s` | `300` | Token lifetime in seconds (`exp = iat + ttl`). |
| `show_dashboard_link` | `false` | Show the **View on dashboard** menu entry (also requires `dashboard_url` + `dashboard_link_secret`). Per-team overridable via `/poll config write show_dashboard_link true`. |

The menu entry is shown to all channel members (Slack can't scope a menu option
per-viewer), but a working token is only minted for the poll **creator** or the
workspace **installer**; everyone else gets an ephemeral "no permission".

## The token

```
TOKEN = base64url(payloadJSON) + "." + base64url( HMAC_SHA256(base64url(payloadJSON), secret) )
```

- `base64url` = standard Base64 with `+`→`-`, `/`→`_`, and `=` padding **removed**.
- The HMAC is computed over the **base64url payload string** (the exact ASCII characters
  before the `.`), and the signature is the base64url of the **raw HMAC digest bytes**.
- The secret is `dashboard_link_secret` (a UTF-8 string).

### Payload (JSON)

```json
{
  "v":   1,
  "pid": "5f9a1b2c3d4e5f6071829304",
  "uid": "U0EXAMPLE01",
  "tid": "T0EXAMPLE99",
  "iat": 1700000000,
  "exp": 1700000300,
  "jti": "9f8e7d6c5b4a392817160504"
}
```
*(All values above are illustrative placeholders, not real ids.)*

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | int | Protocol version. Currently `1`. Reject anything else. |
| `pid` | string | The poll id = the MongoDB `_id` of the `poll_data` document, as a 24-char hex string. |
| `uid` | string | Slack **user id** of the clicker (verified by Slack's request signing on the app side). |
| `tid` | string | Slack **team id**, or the **enterprise id** for org installs (`getTeamOrEnterpriseId`). |
| `iat` | int | Issued-at, Unix seconds. |
| `exp` | int | Expiry, Unix seconds (`iat + dashboard_link_ttl_s`). |
| `jti` | string | Random nonce (hex). Use it to enforce **single-use** (replay protection). |

### Delivery: why the fragment

The app puts the token in the URL **fragment** (`/#/h/<TOKEN>`), not the query string.
Fragments are not sent to servers in the HTTP request, so the token never lands in access
logs, the `Referer` header, or browser history server-side. Your dashboard's page must
therefore read the token **in the browser** (from `location.hash`) and send it to your
backend to verify (e.g. a small POST). A purely server-side endpoint can't see the
fragment — host a tiny bootstrap page at `dashboard_url` that forwards it.

## What your dashboard must do (verification)

In order, server-side, using `dashboard_link_secret`:

1. **Split** the token on `.` — require exactly two non-empty parts: `payloadB64`, `sigB64`.
2. **Recompute** `HMAC_SHA256(payloadB64, secret)` and **constant-time compare** it to
   `base64url_decode(sigB64)`. Reject on mismatch. *(Use a timing-safe comparison.)*
3. **Decode** `payloadB64` (base64url → UTF-8 → JSON).
4. **`v === 1`**, else reject.
5. **Freshness:** require `exp`, reject if `now > exp + clock_skew` (a 60 s skew is
   reasonable). Run NTP so your clock matches the app host.
6. **Max-age clamp:** reject if `exp - iat` is larger than you expect (e.g. > 300 s) — a
   defense against a misconfigured over-long token.
7. **Shape:** `pid` is a 24-hex ObjectId; `uid`, `tid`, `jti` are present.
8. **Single-use:** record `jti` (until `exp`); reject a `jti` you've seen before (replay).
9. **Authorize from your own data.** The token proves identity + intent only. Decide what
   `uid` may see of poll `pid` using your own permission model — **never** treat a valid
   token as "grant full access", and never trust any privilege claim in the payload.
10. Open poll `pid` for the user.

## Reference: signing (what the app does)

```js
const crypto = require('node:crypto');
function mintToken(pid, uid, tid, secret, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, pid: String(pid), uid: String(uid), tid: String(tid),
                    iat: now, exp: now + ttlSeconds, jti: crypto.randomBytes(12).toString('hex') };
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const payloadB64 = b64url(JSON.stringify(payload));
  const sigB64 = b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  return `${payloadB64}.${sigB64}`;
}
```

## Reference: verifying (what your dashboard does)

```js
const crypto = require('node:crypto');
function verifyToken(token, secret, { maxAgeS = 300, clockSkewS = 60 } = {}) {
  const b64urlDec = (s) => Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/'), 'base64');
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed');
  const [payloadB64, sigB64] = parts;

  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const given = b64urlDec(sigB64);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Error('bad signature');

  const p = JSON.parse(b64urlDec(payloadB64).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (p.v !== 1) throw new Error('bad version');
  if (!p.exp || now > Number(p.exp) + clockSkewS) throw new Error('expired');
  if (!p.iat || (Number(p.exp) - Number(p.iat)) > maxAgeS) throw new Error('max-age exceeded');
  if (!p.pid || !/^[a-f0-9]{24}$/i.test(String(p.pid))) throw new Error('bad poll id');
  if (!p.uid || !p.tid || !p.jti) throw new Error('missing fields');
  // caller: enforce single-use on p.jti, then authorize p.uid for poll p.pid from YOUR data.
  return { v: p.v, pid: p.pid, uid: p.uid, tid: p.tid, iat: p.iat, exp: p.exp, jti: p.jti };
}
```

(Any language works — it's just HMAC-SHA256 over an ASCII string plus base64url. Match
the secret and the exact bytes hashed.)

## Looking up the poll

`pid` is the `_id` of the poll's `poll_data` document. A dashboard that reads the same
MongoDB the app writes can `findOne({ _id: ObjectId(pid) })`. `uid`/`tid` are Slack ids
you can resolve via your own data or the Slack API. (How you read poll data and what you
show is entirely your dashboard's concern — this contract only covers the signed handoff.)

## Security checklist

- Keep `dashboard_link_secret` server-side on both ends; never send it to a browser.
- Use ≥32 random bytes; rotate by accepting old+new during a window.
- Always verify the signature with a **timing-safe** compare.
- Enforce `exp` + a max-age clamp + **single-use `jti`**; keep the TTL short.
- Treat `uid`/`tid`/`pid` as *who/what*, not *what they may see* — authorize from your own data.
- Prefer fragment delivery (as the app does) so tokens stay out of logs and `Referer`.
