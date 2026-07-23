> ## Documentation Index
> Fetch the complete documentation index at: https://docs.devin.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Outposts partner integrations

> Connect an outpost from a partner platform with a PKCE code exchange

<Note>
  Rough notes — this flow is in early development and the details below may
  change.
</Note>

Partner platforms (e.g. compute providers) can connect an outpost on behalf of a customer. The customer's Devin admin authorizes the connection in the browser; Devin then creates an outpost and a service user and hands the partner a token to run workers against the outpost.

The flow is an OAuth-light authorization-code exchange with [PKCE](https://datatracker.ietf.org/doc/html/rfc7636). The browser only ever carries a short-lived, single-use **code** — the service-user token is exchanged server-to-server and never transits the browser.

## Prerequisites

* **Callback allowlist.** Every `callback_url` you use must be on Devin's allowlist for your integration. This is configured by Cognition — send us the exact URLs ahead of time. A URL that is not on the list is rejected.
* **Outposts enabled.** The customer's account must have Outposts enabled.
* **Admin authorization.** Authorizing a connection requires a Devin admin with both enterprise-settings and service-user management rights. The partner never needs a Devin token — the admin authorizes it in their own browser session.

## Flow overview

```
Partner backend                 Admin's browser                 Devin
     │                                │                            │
     │ 1. gen code_verifier,          │                            │
     │    derive code_challenge       │                            │
     │ 2. redirect to app.devin.ai/outposts/connect?…code_challenge│
     │───────────────────────────────>                            │
     │                                │ 3. admin confirms, "Connect"│
     │                                │──────confirm connection──────>
     │                                │ 4. redirect callback_url?code=…  │
     │<───────────────────────────────                            │
     │ 5. POST /outposts/connection-token  (code + code_verifier) │
     │────────────────────────────────────────────────────────────>
     │ 6. { access_token, api_base_url, … }                       │
     │<────────────────────────────────────────────────────────────
     │ 7. run outpost workers with access_token                   │
```

### 1. Generate a PKCE verifier and challenge

On your backend, per connection attempt:

* Generate a high-entropy, random **`code_verifier`**: 43–128 characters from the unreserved alphabet `[A-Za-z0-9-._~]` (e.g. `base64url(random 32 bytes)` with padding stripped).
* Derive the **`code_challenge`** as the unpadded base64url of the SHA-256 of the verifier (PKCE "S256"):

```python theme={null}
import base64, hashlib, secrets

code_verifier = secrets.token_urlsafe(32)  # 43+ chars, unreserved alphabet
code_challenge = (
    base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
    .rstrip(b"=")
    .decode()
)
```

Store the `code_verifier` server-side (keyed to whatever state you use to correlate the eventual callback). Never send the verifier to the browser — only the challenge leaves your backend.

### 2. Redirect the admin to the connect page

Send the customer's admin to Devin's connect page with the challenge and your callback:

```
https://app.devin.ai/outposts/connect
  ?callback_url=https://partner.example.com/devin/outpost-callback
  &outpost_name=my-outpost
  &outpost_image=https://partner.example.com/logo.png
  &platform=linux
  &code_challenge=<code_challenge>
```

| Param            | Required | Notes                                                                                  |
| ---------------- | -------- | -------------------------------------------------------------------------------------- |
| `callback_url`   | yes      | Where Devin relays the one-time code. Must be on your allowlist.                       |
| `code_challenge` | yes      | The PKCE S256 challenge from step 1.                                                   |
| `outpost_name`   | no       | Suggested outpost name. The admin can edit it before confirming.                       |
| `outpost_image`  | no       | URL of a PNG icon used to represent the outpost, such as your company logo.            |
| `platform`       | no       | Preselected outpost platform: `macos`, `linux`, or `windows`. The admin can change it. |

If the admin isn't signed in, the connect page stashes these params and prompts them to sign in first, then resumes.

### 3. Admin confirms

The connect page shows a confirmation with an editable outpost name and platform (and your `outpost_image` if provided). When the admin clicks **Connect**, Devin validates permissions, the callback allowlist, and that the outpost name is free, stores an encrypted, single-use code (10-minute TTL), and redirects back to your app with the one-time code.

No outpost or service user exists yet — they are created only when the code is redeemed (step 5). An unredeemed code simply expires.

### 4. Devin redirects the code to your callback

The browser is redirected to your `callback_url` with the code appended:

```
https://partner.example.com/devin/outpost-callback?code=<one-time code>
```

### 5. Exchange the code server-to-server

From your backend, look up the `code_verifier` you stored in step 1 and redeem the code at the token endpoint. This is a form-encoded, OAuth-style token request:

```bash theme={null}
curl -X POST "https://api.devin.ai/outposts/connection-token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=<one-time code>" \
  --data-urlencode "code_verifier=<code_verifier>"
```

This endpoint needs no Devin auth — possession of the code plus the matching PKCE verifier is the proof. It is unauthenticated on purpose: the code is single-use (atomically consumed), short-lived, and bound to your challenge.

### 6. Receive the credentials

On success Devin creates the outpost and a service user scoped to run the outpost worker, and returns:

```json theme={null}
{
  "outpost_id": "...",
  "account_id": "...",
  "outpost_name": "my-outpost",
  "service_user_id": "...",
  "api_base_url": "https://api.devin.ai",
  "access_token": "cog_...",
  "token_type": "bearer"
}
```

Responses carry `Cache-Control: no-store` — do not cache them.

### 7. Run outpost workers

Store `access_token` and `api_base_url` securely and use the token as a bearer credential to run outpost workers against the outpost.

## Error handling

The token endpoint follows [RFC 6749 §5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-5.2). An unknown, expired, already-redeemed (replayed), or PKCE-mismatched code returns `400`:

```json theme={null}
{
  "error": "invalid_grant",
  "error_description": "Invalid or expired connection code"
}
```

Because codes are single-use and expire after 10 minutes, treat any `invalid_grant` as terminal: discard the stored `code_verifier` and restart the flow from step 1.

## Security notes

* **The token never touches the browser.** Only the single-use code is relayed via redirect; the service-user token is returned solely from the server-to-server exchange.
* **PKCE binds the code to you.** The code is useless without the `code_verifier` held only on your backend, so intercepting the redirect (or the code) is not enough to redeem it.
* **Codes are single-use and short-lived.** Redemption atomically consumes the code; it also expires after 10 minutes.
* **Callback URLs are allowlisted.** Devin only relays a code to a `callback_url` Cognition has pre-approved for your integration.
* **Verify the code is for the requesting user.** Confirm that the code returned to your callback belongs to the same user who originally requested the connection. This prevents an attacker from tricking a user into unsuspectingly binding Devin to a sandbox the attacker controls.
* **Keep `outpost_name` sensible.** The admin may override it; the name you pass is only a suggestion.
