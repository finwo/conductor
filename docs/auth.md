Authentication
==============

The conductor has one way in and two providers behind it. Either it runs
its own login page, or an external provider does. Never both: the discovery
document can only name one, and whichever it names is the one that answers.

The application never learns which it is talking to. It asks for the
discovery document, runs an authorization code flow against whatever that
names, and presents the resulting access token as a bearer credential.

Discovery
---------

```
GET /.well-known/openid-configuration
```

Served in both modes, on the conductor's own origin. With a provider
configured this is that provider's document, passed through. Without one it
describes the conductor's own endpoints.

One non-standard field is added either way:

```json
{ "issuer": "...", "authorization_endpoint": "...", "token_endpoint": "...",
  "client_id": "conductor", "scopes": "openid" }
```

A discovery document carries no client id, and the application has to learn
one somewhere. Putting it here saves a second request and a second thing to
configure.

The flow
--------

An ordinary authorization code flow with PKCE, which is the only kind the
conductor accepts. `code_challenge_method` must be `S256`; there is no
`plain` and no implicit grant.

```
1. GET  /.well-known/openid-configuration
2. redirect to authorization_endpoint with code_challenge
3. the provider sends the browser back with ?code=
4. POST token_endpoint with code_verifier
5. Authorization: Bearer <access_token> from then on
```

The redirect uri is the application's own origin and path, with no
fragment. The fragment belongs to the router, so the code comes back on the
query string instead.

Tokens
------

An access token lives in memory only and is short-lived, `auth.access_ttl`,
900 seconds by default. It is a JWT either way: signed by the provider, or
signed by the conductor with `auth.session_secret`.

A refresh token is not a JWT. It is an opaque random value, stored only as
a sha256 hash, and it is the session. It lives in local storage so a
reload does not sign you out.

The refresh token is not rotated. Rotation only catches a stolen token in
the case where the victim then presents the superseded copy, and in
exchange two tabs refreshing at once race into a spurious logout and a
hand-revoked session cannot be told from a leaked one. Revocation is the
control that matters here, and it is explicit.

`auth.refresh_sliding` decides what a refresh does to the deadline. True,
the default, moves it to `now + auth.refresh_ttl`, so a session lasts that
long after it was last used. False leaves the original deadline alone, so a
session ends that long after signing in whatever happens in between.

Revoking
--------

```
GET    /api/v1/sessions
DELETE /api/v1/sessions/:id
POST   /auth/revoke
```

Every live session is listed with the browser and address it was last seen
from, so a person can tell them apart. Those two are recorded for that and
nothing else. They are never compared and never validated: moving between
networks is ordinary, and a browser that updates itself is not an intruder.

An administrator sees every session, anyone else sees their own. Revoking
one ends it at the next refresh, which is at most `auth.access_ttl` away.
Disabling an account or changing its password revokes all of its sessions
at once.

With a provider configured none of this is populated. Nothing issues a
refresh token, and a session is ended in the provider.

The built-in provider
---------------------

Used when no `auth.oidc.discovery_url` is set, or when
`auth.local.enabled` is set true to override one.

```
GET  /.well-known/openid-configuration
GET  /auth/authorize      the login page
POST /auth/authorize      credentials, redirects with a code
POST /auth/token          authorization_code and refresh_token grants
POST /auth/revoke
GET  /auth/logout
GET  /auth/jwks           an empty set
```

The login page is a static file with a plain form. It has no action, so the
authorization parameters stay in the query string where the page was asked
for, and nothing has to be rendered into it. There is no inline script and
no inline style, which is what lets a Content-Security-Policy ship with the
application at all.

Its key set is empty and honestly so. The tokens are HS256 and nothing
outside this conductor verifies them; the endpoint exists for shape.

An authorization code is a signed token that lives for 60 seconds. It
carries the subject, the redirect uri, the code challenge and an id, so
none of that needs storing. Redeeming one writes the session row under an
id derived from the code's own id, so redeeming it twice collides on the
primary key and is refused. Codes are single use without a table of spent
codes.

`auth.local.redirect_uris` is where the browser may be sent back to. It
defaults to `server.public_url` and is compared by origin, so an
application served from somewhere else needs its origin listed. A redirect
uri that is not listed is refused outright rather than redirected to, or
this would be an open redirect.

Using an external provider
--------------------------

Set the discovery url and the client id:

```yaml
auth:
  oidc:
    discovery_url: https://idp.example.com/realms/ci/.well-known/openid-configuration
    client_id: conductor
    admin_role: conductor-admin
```

There is no client secret. The application runs the flow itself as a public
client, so the conductor never redeems a code and has nothing to
authenticate with. A confidential client cannot be used here.

In Keycloak that means:

- the client is **public**, not confidential
- **Standard flow** on, with **PKCE** required and `S256` as the method
- the application's origin in **Web Origins**, or the browser cannot reach
  the token endpoint
- the application's origin and path as a **Valid redirect URI**

Roles are read from `realm_access.roles`, `resource_access[*].roles`, a
flat `roles` claim and `groups`, because there is no standard. Anyone
holding `auth.oidc.admin_role` is an administrator here.

A provider account still gets a local row on first sight, because projects
and worker tokens reference `users(id)`. Identity is the issuer and subject
together, not the display name, so renaming someone at the provider does
not produce a second account. That row can be disabled locally, which locks
them out even though the provider would still admit them.

The audience trap
-----------------

For a client named `conductor`, Keycloak issues an id_token with
`aud: "conductor"` but an access token with `aud: ["account"]` and
`azp: "conductor"`. The conductor checks `azp`, falling back to `aud`
containing the client id. Checking only `aud` rejects every real access
token, and the failure is a 401 on every request.

This is worth knowing because it does not show up in testing unless the
mock provider is made to reproduce it. `test/helpers/oidc.js` has a persona
that does.

Workers and triggers
--------------------

Neither goes through any of this.

A worker token is 64 hex characters, presented as a bearer credential and
stored as a sha256 hash. It never parses as a JWT, so the two meanings of
the header cannot be confused. It reaches the worker protocol and nothing
else.

A project trigger secret is an HMAC over the exact request body, in
`X-Hub-Signature-256`, or `X-Gitlab-Token` compared directly. A project
with no secret accepts unsigned triggers and says so in the log, which is
convenient on a private network and a bad idea anywhere else.
