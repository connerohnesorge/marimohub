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
```

Configuration fails unless exposure is `proxy`. Each session runs in its
owner's kernel, so the hub claims every external-kernel editor exclusively,
whatever `MARIMOHUB_EDITOR_SANDBOX_SHARING` says: another editor sees the
notebook as owned and can start a temporary sandbox. Sessions on the fallback
backend keep the deployment's editor sharing; a user with a kernel who opens a
notebook that someone already edits in a shared fallback sandbox joins it. Without a fallback backend, do not set `MARIMOHUB_COMPUTE_IMAGE`;
the external service owns the kernel image. `MARIMOHUB_COMPUTE_WORKDIR` (default
`/workspace`) only names the hub-side root that maps to each workspace.

#### Users without a personal kernel

Set `MARIMOHUB_COMPUTE_EXTERNAL_FALLBACK_BACKEND` to keep a regular backend for
everyone the external service has no kernel for:

```bash
MARIMOHUB_COMPUTE_EXTERNAL_FALLBACK_BACKEND=kubernetes
# Configure the fallback with its own variables, as if it were MARIMOHUB_COMPUTE_BACKEND.
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/example/marimo-kernel:1
```

At every edit session start, the hub asks `GET /kernel` with the signed-in
user's own token. It does not cache the answer.

- `200`: the session runs in the user's personal kernel.
- `404 {"error":{"code":"no_kernel"}}`: the session runs on the fallback
  backend, exactly as it would without the external kernel.
- Anything else (`401`, `403`, any other `404`, `5xx`, an unreachable service,
  or a missing or expired token): the start fails with that error. The hub
  never falls back on an error.

The session records which backend it runs on, and every later operation on it
(capture, teardown, proxying, surfaces) uses that backend. Apps, jobs, warm
pools, data previews, compute profiles, and images always use the fallback.
Header stripping applies to kernel traffic on both backends.

#### Security model

- The hub holds no credential that can drive any kernel. Every request to the
  external service carries `Authorization: Bearer <token>`, where the token is
  the signed-in user's own JWT, read from `MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_HEADER`.
  The service must verify the token on every request and serve only that user's
  kernel.
- Every request also carries `X-External-Kernel-Owner`, the lowercased hub email
  of the session owner (on the admin stop route, of the caller). The service
  refuses a token whose email differs with `403 owner_mismatch`, which the hub
  reports as a refusal.
- The hub refuses a token that is not a JWT, that has expired, or whose `email`
  claim differs from the signed-in hub user. It does not verify signatures; the
  service does.
- Background work (periodic capture, idle teardown) needs a token while no
  request from the owner is in flight. The hub keeps each kernel user's newest
  token in process memory, keyed by hub user id, and drops it at its `exp`. It
  never persists the token. Tokens of users who never start a kernel are not
  kept.
- A request from anyone but the owner (an `/api/v1` request or an MCP tool
  call) never reaches the owner's kernel. The hub refuses it before sending
  anything, and it never uses the owner's cached token on that caller's
  behalf. A token whose email differs from the signed-in user is refused,
  never replaced by a cached one.
- Stopping another user's session (`DELETE` on the session, the MCP
  `stop_session` tool, or deleting the notebook or project of a live app or
  temporary session) calls `POST /admin/kernels/stop` with the caller's own
  token. The service accepts it only from its administrators, saves the open
  notebooks into the workspace, and closes them without running a cell. A
  refusal leaves the session running. The route names the owner by the hub
  email in the owner's identity record.
- The hub then ends the session record but keeps the workspace and the editor
  claim. The saved notebooks reach the hub when the workspace is captured with
  the owner's own token: at the owner's next start of that notebook, or by
  background work while the hub holds the owner's token. Only then is the
  workspace deleted. Until then, other editors see the notebook as still
  shutting down.
- Nobody can take over an editor that runs in a personal kernel; the hub does
  not offer it and refuses the request.
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
- The hub writes only the notebook workspace into the kernel: no setup
  commands, kernel auth token, AI token, or marimo configuration. It refuses any
  file path outside the workdir. Integrations and workload identity go to the
  environment route instead (see below).

#### Integrations

The hub renders a session's integrations exactly as it does on other backends
(managed values, external secret references, and workload identity
credentials) and sends the result to
`PUT /workspaces/{workspaceId}/environment` before it opens the notebook. The
service applies it to that workspace only, never to the user's other notebooks.

- Plain variables go to `env`. A variable that is multi-line or longer than
  32 KiB is left out.
- A rendered file goes to `files` once for each variable whose whole value is
  its path; the service writes it and sets that variable to the real path.
  Files no variable names (the integration manifest, connection descriptors),
  variables that name the integrations directory (`MARIMOHUB_INTEGRATIONS_DIR`,
  `PYICEBERG_HOME`), and values that embed a rendered path (for example a
  connection URL with `sslrootcert=` or `credentials_path=`) are left out.
- Database servers go to `tunnels`, with the variables that carry the host,
  the port, or a URL: PostgreSQL, MySQL, SQL Server, Redshift, ClickHouse,
  MongoDB (`mongodb` scheme), Trino, Spark Connect, and Databricks. At most 16.
- S3 credentials go to `s3`: an S3 integration with static keys, and workload
  identity credentials, which win when both exist. Their key variables never
  reach the kernel; the service points the endpoint variable
  (`AWS_ENDPOINT_URL_S3` unless the integration names another) at its S3 relay.
  Only one credential set fits; the others are left out.
- MongoDB with `mongodb+srv` and Snowflake connect to hosts that no tunnel can
  name (DNS SRV records, the account identifier), so they get no tunnel. The
  Iceberg kinds keep their configuration in a directory
  (`PYICEBERG_HOME/.pyiceberg.yaml`), which the environment route cannot carry,
  so they do not work. Cloud API kinds (BigQuery, Athena, GCS, Azure Blob,
  MotherDuck, Weights & Biases, Hugging Face) get their variables and key files
  but no tunnel, so they need the kernel to reach the vendor directly.

Each left-out item is logged as `external_kernel_environment_omitted` by name
and reason, never by value. A `400 invalid_environment` fails the session start.
The hub does not refresh workload identity credentials during a session.

#### What does not work

- Managed AI and hub-rendered marimo configuration. The hub mints neither for
  these sessions.
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
- Without `MARIMOHUB_COMPUTE_EXTERNAL_FALLBACK_BACKEND`, users without a
  kernel see `no_kernel` and must start their kernel in the external service
  first.
- A request without the token header (for example from an MCP client with a
  hub token) starts an edit session only while the hub still holds an
  unexpired token from the same user's earlier requests. Otherwise the start
  fails, even with a fallback: the hub cannot ask the service whether the user
  has a kernel.

#### Protocol

The hub is a client of these endpoints, relative to
`MARIMOHUB_COMPUTE_EXTERNAL_URL`. `{workspaceId}` is the hub sandbox id. Paths
are relative to the workspace and never contain `..`. Every request carries
`Authorization: Bearer <user JWT>` and `X-External-Kernel-Owner: <owner email>`
(the admin stop route carries the caller's token and email instead);
any endpoint can answer `401` (bad token), `403 {"error":{"code":"owner_mismatch"}}`
(token email differs from the owner), or `403` (not allowed).

| Request                                                                       | Response                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /kernel`                                                                 | `200 {"ready": true, "user": "<email>"}`; `404 {"error":{"code":"no_kernel"}}` when the user has no kernel                                                                                                                      |
| `PUT /workspaces/{workspaceId}/files?path=<rel>` (raw body)                   | `2xx`; parent directories are created                                                                                                                                                                                           |
| `PUT /workspaces/{workspaceId}/environment` `{"env","files","tunnels","s3"}`  | `204`; replaces the workspace's whole environment. `400 {"error":{"code":"invalid_environment"}}` for a body outside the limits above                                                                                           |
| `GET /workspaces/{workspaceId}/files?path=<rel>`                              | `200` bytes; `404` missing                                                                                                                                                                                                      |
| `GET /workspaces/{workspaceId}/list?path=<rel>`                               | `200 {"entries":[{"path":"<workspace-relative path>","type":"file"\|"directory","size":<n>}]}` for one level; `404` when the workspace or directory does not exist                                                              |
| `POST /workspaces/{workspaceId}/open` `{"notebook","projectId","notebookId"}` | `200 {"file":"<marimo file key>"}`                                                                                                                                                                                              |
| `DELETE /workspaces/{workspaceId}`                                            | `2xx` or `404`                                                                                                                                                                                                                  |
| `POST /admin/kernels/stop?owner=<owner email>&workspace=<workspaceId>`        | Saves the open notebooks into the workspace, then closes them; runs no cell. `2xx` when the caller is a service administrator, `403` otherwise. Carries the caller's own token, and `X-External-Kernel-Owner` names the caller. |
| `* /workspaces/{workspaceId}/proxy/{path}`                                    | HTTP and WebSocket proxy to the root of the user's marimo server                                                                                                                                                                |

The hub stores the file key in the session's origin URL and adds
`file=<key>` to every proxied request that has no `file` parameter. The hub
strips its own `/proxy/<token>` prefix, because one server serves every
notebook and has no per-session base URL. Proxied requests reach the service
with `Host` and `Origin` set to the service itself; the service presents
whatever `Host` and `Origin` marimo accepts, and it must refuse `..` in `path`.
