<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

The external-kernel backend attaches every edit session to the signed-in user's
own long-lived marimo server. An external service runs that server, one per
user, and serves many notebooks from it. The hub does not create compute. It
uploads the notebook workspace to the user's server, asks the service to open
the notebook, and proxies the browser to the server.

Use it when another system already gives each person one kernel, and notebooks
opened from the hub must share that kernel.

Set these environment variables on the hub:

```bash
MARIMOHUB_COMPUTE_BACKEND=external-kernel
MARIMOHUB_COMPUTE_EXTERNAL_URL=http://kira-app.kira.svc.cluster.local:8080/api/external-kernel/v1
# Header the gateway sets to the caller's own verified JWT (default shown).
MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_HEADER=x-pantheon-bearer
# Browser header prefixes never forwarded to any kernel (default shown).
MARIMOHUB_SANDBOX_STRIP_HEADER_PREFIXES=x-pantheon-
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive
```

Configuration fails unless exposure is `proxy` and editor sandboxes are
`exclusive`. Each session runs in its owner's kernel, so another user cannot
attach to it. Do not set `MARIMOHUB_COMPUTE_IMAGE`; the external service owns
the kernel image. `MARIMOHUB_COMPUTE_WORKDIR` (default `/workspace`) only names
the hub-side root that maps to each workspace.

#### Security model

- The hub holds no credential that can drive any kernel. Every request to the
  external service carries `Authorization: Bearer <token>`, where the token is
  the signed-in user's own JWT, read from `MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_HEADER`.
  The service must verify the token on every request and serve only that user's
  kernel.
- Every request also carries `X-External-Kernel-Owner`, the lowercased hub email
  of the session owner. The service refuses a token whose email differs with
  `403 owner_mismatch`, which the hub reports as a refusal.
- The hub refuses a token that is not a JWT, that has expired, or whose `email`
  claim differs from the signed-in hub user. It does not verify signatures; the
  service does.
- Background work (periodic capture, idle teardown) needs a token while no
  request from the owner is in flight. The hub keeps each kernel user's newest
  token in process memory, keyed by hub user id, and drops it at its `exp`. It
  never persists the token. Tokens of users who never start a kernel are not
  kept.
- A request from someone else, such as an admin stopping the session, never
  lends its own token to the owner's kernel. The owner's cached token is used,
  or the operation fails. A token whose email differs from the signed-in user
  is refused, never replaced by a cached one.
- A proxied browser request always uses the requesting user's own token from
  that request. The hub refuses a request from anyone but the session owner
  before it reaches the service, and never substitutes a cached token.
- Proxied browser requests lose cookies, `Authorization`, the token header,
  `MARIMOHUB_SANDBOX_STRIP_HEADERS`, and every header that matches
  `MARIMOHUB_SANDBOX_STRIP_HEADER_PREFIXES` before the hub sets the bearer and
  the owner header. The hub applies the same filter to kernels on every other
  backend, so no notebook code sees a viewer's token.
- Accepted residual risk: a compromised hub process can replay the tokens of
  users who are using it at that moment, until those tokens expire.
- The hub sends the kernel no environment variables, credential files, setup
  commands, or kernel auth token. It refuses any file path outside the workdir,
  so a credential file can never reach the kernel by accident.

#### What does not work

- Managed AI, workload identity federation, integration secrets, and
  hub-rendered marimo configuration. The hub mints none of them for these
  sessions.
- Per-notebook dependencies. The hub runs no `uv sync` or setup step; the
  kernel image is the environment.
- Anything that runs a command in the sandbox: jobs, **Run as app**, VS Code
  and OpenCode surfaces, in-sandbox thumbnails (off by default for this
  backend), sandbox data previews, connection-aware idle detection, proposal
  capture from Git, and MCP code execution.
- Warm pools and compute profiles.
- Background capture or teardown after the owner's token expires with no newer
  request. The call fails and the next sweep retries it once the owner uses the
  hub again. The service owns the kernel's own lifecycle.
- A fallback to another backend for users without a kernel. Those users see
  `no_kernel` and must start their kernel in the external service first.

#### Protocol

The hub is a client of these endpoints, relative to
`MARIMOHUB_COMPUTE_EXTERNAL_URL`. `{workspaceId}` is the hub sandbox id. Paths
are relative to the workspace and never contain `..`. Every request carries
`Authorization: Bearer <user JWT>` and `X-External-Kernel-Owner: <owner email>`;
any endpoint can answer `401` (bad token), `403 {"error":{"code":"owner_mismatch"}}`
(token email differs from the owner), or `403` (not allowed).

| Request                                                                       | Response                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /kernel`                                                                 | `200 {"ready": true, "user": "<email>"}`; `404 {"error":{"code":"no_kernel"}}` when the user has no kernel                                                         |
| `PUT /workspaces/{workspaceId}/files?path=<rel>` (raw body)                   | `2xx`; parent directories are created                                                                                                                              |
| `GET /workspaces/{workspaceId}/files?path=<rel>`                              | `200` bytes; `404` missing                                                                                                                                         |
| `GET /workspaces/{workspaceId}/list?path=<rel>`                               | `200 {"entries":[{"path":"<workspace-relative path>","type":"file"\|"directory","size":<n>}]}` for one level; `404` when the workspace or directory does not exist |
| `POST /workspaces/{workspaceId}/open` `{"notebook","projectId","notebookId"}` | `200 {"file":"<marimo file key>"}`                                                                                                                                 |
| `DELETE /workspaces/{workspaceId}`                                            | `2xx` or `404`                                                                                                                                                     |
| `* /workspaces/{workspaceId}/proxy/{path}`                                    | HTTP and WebSocket proxy to the root of the user's marimo server                                                                                                   |

The hub stores the file key in the session's origin URL and adds
`file=<key>` to every proxied request that has no `file` parameter. The hub
strips its own `/proxy/<token>` prefix, because one server serves every
notebook and has no per-session base URL. Proxied requests reach the service
with `Host` and `Origin` set to the service itself; the service presents
whatever `Host` and `Origin` marimo accepts, and it must refuse `..` in `path`.
