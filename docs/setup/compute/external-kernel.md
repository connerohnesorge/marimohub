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
# Only these users ask the service; everyone else uses the fallback directly.
MARIMOHUB_COMPUTE_EXTERNAL_USERS=ada@example.com,grace@example.com
```

With `MARIMOHUB_COMPUTE_EXTERNAL_USERS`, a user who is not listed never
contacts the external service: their sessions start on the fallback even while
the service is down or rolling out. For a listed user (or every user, when the
list is unset), the hub asks `GET /kernel` at every edit session start with that
request's own token. It does not cache the answer.

- `200`: the session runs in the user's personal kernel.
- `404 {"error":{"code":"no_kernel"}}`: the session runs on the fallback
  backend, exactly as it would without the external kernel.
- Anything else (`401`, `403`, any other `404`, `5xx`, an unreachable service,
  or a missing or expired token): the start fails with that error. The hub
  never falls back on an error.

The session records which backend it runs on, and every later operation on it
(capture, teardown, proxying, surfaces) uses that backend. Apps and scheduled
jobs follow their author (see [Apps](#apps) and [Scheduled jobs](#scheduled-jobs)).
Warm pools, data previews, compute profiles, and images always use the
fallback.
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
- The hub keeps no token between requests. A token is used only while the
  request that carried it, and the work that request started, are running.
  Work outside a request (the maintenance sweeps, a replica without user
  traffic) cannot reach a personal kernel and fails with a clear error.
- A request from anyone but the owner (an `/api/v1` request or an MCP tool
  call) never reaches the owner's kernel. The hub refuses it before sending
  anything. A token whose email differs from the signed-in user is refused.
- Stopping another user's session (`DELETE` on the session, the MCP
  `stop_session` tool, or deleting the notebook or project of a live app or
  temporary session) calls `POST /admin/kernels/stop` with the caller's own
  token. The service accepts it only from its administrators, saves the open
  notebooks into the workspace, and closes them without running a cell. A
  refusal leaves the session running. The route names the owner by the hub
  email in the owner's identity record.
- The hub then ends the session record but keeps the workspace and the editor
  claim. The saved notebooks reach the hub when the workspace is captured with
  the owner's own token: at the owner's next heartbeat from an open editor, or
  at the owner's next start of that notebook. Only then is the workspace
  deleted. Until then, other editors see the notebook as still shutting down.
- Nobody can take over an editor that runs in a personal kernel; the hub does
  not offer it and refuses the request.
- A proxied browser request always uses the requesting user's own token from
  that request. The hub refuses a request from anyone but the session owner
  before it reaches the service.
- Proxied browser requests lose cookies, `Authorization`, the token header,
  `MARIMOHUB_SANDBOX_STRIP_HEADERS`, and every header that matches
  `MARIMOHUB_SANDBOX_STRIP_HEADER_PREFIXES` before the hub sets the bearer and
  the owner header. The hub applies the same filter to kernels on every other
  backend, so no notebook code sees a viewer's token.
- Accepted residual risk: a compromised hub process can replay the tokens of
  requests it is serving, until those tokens expire.
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
- A rendered file goes to `files`. A variable whose whole value is its path
  becomes the file's `envVar`; any other variable that contains the path,
  plain or percent-encoded (a connection URL with `sslrootcert=`, `ssl_ca=`,
  `tlsCAFile=`, `credentials_path=`, or a Trino `verify=`), gets
  `${KIRA_FILE:<name>}` in its place. A variable that names a rendered
  directory (`PYICEBERG_HOME`, `MARIMOHUB_INTEGRATIONS_DIR`) ships that
  directory's files under one directory with `dirEnvVar`. Connection
  descriptors that only a directory listing would find, and files whose content
  embeds another rendered path, are left out.
- Database servers go to `tunnels`, with the variables that carry the host,
  the port, or a URL: PostgreSQL, MySQL, SQL Server, Redshift, ClickHouse,
  Trino, Spark Connect, and the Iceberg SQL catalog and Hive metastore (through
  `PYICEBERG_CATALOG__<NAME>__URI`, which overrides the YAML). At most 16.
- A PostgreSQL tunnel also carries the sign-in: `protocol: "postgres"`, `user`,
  `password`, `database`, `sslmode` (the integration's), and `rootCaBase64` (its
  CA bundle, or empty). The service signs in upstream over TLS and keeps the
  password. The kernel's side gets `kira-brokered` wherever the password was,
  and `sslmode=disable` with no CA file, because its hop to the service is
  loopback. Each PostgreSQL integration gets its own tunnel. Redshift stays a
  plain tunnel: its driver always asks for TLS, and a URL cannot turn that off.
- HTTPS services go to `hosts`, so TLS stays end to end with the real name:
  Databricks, Snowflake (`*.snowflakecomputing.com`), BigQuery, GCS, Azure Blob,
  MotherDuck (`*.motherduck.com` and `extensions.duckdb.org`), Weights & Biases,
  Hugging Face (with `*.huggingface.co` and `*.hf.co`), Iceberg REST catalogs
  and their token endpoints, and Iceberg GCS, ADLS, and Hugging Face storage.
- MongoDB URLs, `mongodb+srv` and replica sets included, go to `mongodb`; the
  service resolves the members and relays them.
- AWS credentials go to `aws` with the services they sign: S3 integrations
  with static keys (`s3`), Athena (`athena` and `s3` for results), Glue and
  DynamoDB catalogs (`glue`, `dynamodb`, plus `s3` when they share client
  keys), Iceberg S3 storage keys, and workload identity credentials (`s3`, with
  `expiresAt`), which win the services they share. No AWS key reaches the
  kernel: credential variables are withheld, Athena gets a keyless URL, and the
  Iceberg YAML is sent without its key properties.
- Before workload identity credentials expire, at 80% of their remaining
  lifetime, the owner's next heartbeat renders the environment again and sends
  it again. An editor that is closed gets no refresh, so its credentials lapse.

These cannot be relayed and are reported instead: Athena or Glue/DynamoDB with
ambient AWS credentials, AWS profile or role credentials, S3 remote signing,
SigV4-signed Iceberg REST catalogs, Iceberg REST catalogs with custom TLS files
or a Google service account file, Iceberg HDFS storage, Kerberos Hive
metastores, Azure service principals outside the known clouds, and Iceberg
catalogs whose storage the catalog names only at run time. DuckDB HTTP and
DuckLake render nothing for kernels on any backend.

Each left-out item is logged as `external_kernel_environment_omitted` by name
and reason, never by value. A `400 invalid_environment` fails the session start.

#### Saving and ending sessions

The maintenance sweeps never touch these sessions, because they hold no token.
The owner's own requests do the same work instead, with the owner's token:

- Each heartbeat from the owner's open editor (every 2 minutes) saves the
  notebook once `MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS` has passed,
  extends the session at its deadline while the editor is open, and settles a
  session that has already ended: it captures the workspace, deletes it, and
  releases the editor claim.
- Closing or leaving the editor page sends
  `POST …/sessions/{sid}/leave-editor`, which saves at once.
- Starting the notebook again first settles the owner's previous session on it.

What changes compared with other backends:

- Periodic saves happen only while the owner's editor is open. Closing the page
  saves once; edits made after that in the kernel (for example by a running
  cell) reach the hub only when the owner comes back.
- An idle or expired session is captured and its workspace deleted at the
  owner's next heartbeat or start of that notebook, not by the sweep. Until
  then it keeps the editor claim, so other users cannot edit the notebook and
  cannot take it over. The service's own idle policy decides when the kernel
  itself stops.
- A session past its authorization deadline is ended without a save at the
  owner's next request.
- Connection counts are unknown (the service runs no commands), so a session is
  extended at its deadline while its heartbeat is fresh.

#### Apps

When a viewer opens an app whose version was saved by an author with a
personal kernel, the app runs in the author's runtime in the kernel service,
one session per visit, never in a hub app pool. The hub's access checks decide
who may open it, exactly as for pooled apps.

- The hub sends `POST /apps/sessions` with the viewer's own token;
  `X-External-Kernel-Owner` names the author (the user who saved the version).
  The body is `session` (the hub's id, which the service must use), `app` (the
  notebook id), `version`, `notebook`, `files` (`path`, `contentBase64`; the
  version's notebook and `pyproject.toml` over the workspace mirror, at most
  32 MiB), and `environment` (the viewer's integrations, in the workspace
  environment format). `404 no_kernel` sends the app to the hub's pool; any
  other failure fails the start.
- Authors who are not enrolled, and notebooks synced from Git, always use the
  hub's pool without contacting the service.
- The browser reaches it through the hub's proxy, which forwards to
  `/apps/sessions/{session}/proxy/{path}` with the viewer's token. Only that
  viewer's requests are forwarded.
- Leaving the page sends the hub the visit's leave request, which closes the
  session with `DELETE /apps/sessions/{session}` and the viewer's token. If
  anyone else stops it (an admin, or deleting the notebook), the hub stops
  serving it at once and closes it at the viewer's next request; a session
  whose viewer never returns is left to the service's own idle policy.
- Credentials in an app session are not sent again; they lapse at their
  expiry.

#### Scheduled jobs

A scheduled job of a notebook stored in the hub runs in its author's personal
kernel when the author has one, by the same rule as edit sessions (enrolled,
and the service does not answer `no_kernel`). The kernel service fires the
schedule; the hub scheduler never does. Every other job runs on the hub as
before: manual-only jobs, jobs of notebooks synced from Git, and jobs of
authors without a kernel.

- When the author creates the job, or changes its schedule or whether it is
  enabled, the hub sends `PUT /jobs/{jobKey}` with the author's token, before
  it stores the change. A refusal or an unreachable service fails the request.
  `{jobKey}` is `<project id>.<notebook id>.<job id>`.
- Other editors may disable or enable the job, or delete it, without reaching
  the author's kernel: the hub refuses the run when the kernel asks for it.
  Only the author can change its schedule (`409` for anyone else).
- Deleting the job sends `DELETE /jobs/{jobKey}` when the author deletes it.
  Otherwise the service learns at the next firing, from a `404`.
- When it fires, the service calls the hub as the author (through the front
  door, with the author's token):
  - `GET /api/v1/jobs/{jobKey}/run-spec` answers `run_id`, `notebook`,
    `version`, `files` (`path`, `content_base64`), `parameters` (pass them as
    `mo.cli_args()`), `timeout_seconds`, and `environment` (the same body as
    the workspace environment route). `404` means the job is gone; drop it.
    `409` means it should not run now.
  - `POST /api/v1/jobs/{jobKey}/external-runs` with `run_id`, `status`
    (`succeeded`, `failed`, or `timed_out`), `started_at`, `finished_at`, and
    optionally `html_base64` (at most 25 MB decoded), `error`, and `version`.
    The run is recorded, audited, and notified like a hub run, and never
    retried. Repeating a report with the same `run_id` records it once.
- Both routes answer `404` to anyone but the job's author.
- **Run now** still runs on the hub.

#### What does not work

- Managed AI and hub-rendered marimo configuration. The hub mints neither for
  these sessions.
- Per-notebook dependencies. The hub runs no `uv sync` or setup step; the
  kernel image is the environment.
- Anything that runs a command in the sandbox: **Run as app**, VS Code
  and OpenCode surfaces, sandbox data previews, connection-aware idle
  detection, proposal capture from Git, and MCP code execution.
- Thumbnails need the service's thumbnail route. The hub sends the saved HTML
  (never notebook code) to `POST /workspaces/{workspaceId}/thumbnail` with the
  owner's token when it settles the session; a service without the route
  answers `404` and the notebook keeps its previous thumbnail.
- Warm pools and compute profiles.
- Saving, ending, or refreshing credentials without a request from the owner.
  See [Saving and ending sessions](#saving-and-ending-sessions).
- Without `MARIMOHUB_COMPUTE_EXTERNAL_FALLBACK_BACKEND`, users without a
  kernel see `no_kernel` and must start their kernel in the external service
  first.
- A request reaches a personal kernel only with its own token. A request
  without one (for example an API client with a hub token) fails for a listed
  user with sign-in guidance; see [Signing in API and MCP clients](#signing-in-api-and-mcp-clients).

#### Signing in API and MCP clients

Every call to a personal kernel uses the token of the request that causes it.
In the browser that is the gateway's session token. An API, CLI, or MCP client
must send its own token, and its audience must include
`MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_AUDIENCE` (for example `marimohub`). The hub
never forwards a token issued for another client, such as a CLI's own audience:
the kernel call fails with sign-in guidance instead. Requests that do not reach
a personal kernel keep working with any credential the hub accepts, including
personal access tokens.

With Dex, a public client that the hub's client trusts can get such a token by
device code:

1. In the hub's Dex client, list the CLI's client ID in `trustedPeers`.
2. Ask for a device code with the scope
   `openid email profile audience:server:client_id:<hub client id>`:

   ```sh
   curl -s https://<issuer>/device/code \
     -d client_id=<cli client id> \
     -d scope='openid email profile offline_access audience:server:client_id:marimohub'
   ```

3. Open `verification_uri_complete` and sign in, then exchange the device code:

   ```sh
   curl -s https://<issuer>/token \
     -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
     -d client_id=<cli client id> \
     -d device_code=<device_code>
   ```

4. Send the `id_token` from the answer as `Authorization: Bearer <id_token>`.
   Its `aud` is the hub's client ID. Refresh it with the `refresh_token` grant
   before it expires.

Clients:

- `mohub`: set `MARIMOHUB_TOKEN` to the token (or pass `--token`).
- MCP: configure the token as a static `Authorization` header, with
  [`MARIMOHUB_MCP_GATEWAY_IDENTITY`](../../mcp.md#behind-an-identity-gateway)
  on when a gateway consumes the header.
- Scripts: send it on every request; the gateway passes it to the hub in
  `MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_HEADER`.

Set `MARIMOHUB_COMPUTE_EXTERNAL_TOKEN_AUDIENCE` to the hub's client ID, so a
token for another audience is caught in the hub instead of earning a `401`
from the service.

#### Protocol

The hub is a client of these endpoints, relative to
`MARIMOHUB_COMPUTE_EXTERNAL_URL`. `{workspaceId}` is the hub sandbox id. Paths
are relative to the workspace and never contain `..`. Every request carries
`Authorization: Bearer <user JWT>` and `X-External-Kernel-Owner: <owner email>`
(the admin stop route carries the caller's token and email instead);
any endpoint can answer `401` (bad token), `403 {"error":{"code":"owner_mismatch"}}`
(token email differs from the owner), or `403` (not allowed).

| Request                                                                                         | Response                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /kernel`                                                                                   | `200 {"ready": true, "user": "<email>"}`; `404 {"error":{"code":"no_kernel"}}` when the user has no kernel                                                                                                                      |
| `PUT /workspaces/{workspaceId}/files?path=<rel>` (raw body)                                     | `2xx`; parent directories are created                                                                                                                                                                                           |
| `PUT /workspaces/{workspaceId}/environment` `{"env","files","tunnels","hosts","mongodb","aws"}` | `204`; replaces the workspace's whole environment. `400 {"error":{"code":"invalid_environment"}}` for a body outside the limits above                                                                                           |
| `GET /workspaces/{workspaceId}/files?path=<rel>`                                                | `200` bytes; `404` missing                                                                                                                                                                                                      |
| `GET /workspaces/{workspaceId}/list?path=<rel>`                                                 | `200 {"entries":[{"path":"<workspace-relative path>","type":"file"\|"directory","size":<n>}]}` for one level; `404` when the workspace or directory does not exist                                                              |
| `POST /workspaces/{workspaceId}/open` `{"notebook","projectId","notebookId"}`                   | `200 {"file":"<marimo file key>"}`                                                                                                                                                                                              |
| `DELETE /workspaces/{workspaceId}`                                                              | `2xx` or `404`                                                                                                                                                                                                                  |
| `POST /workspaces/{workspaceId}/thumbnail` (`text/html` body)                                   | `200` PNG of the HTML, rendered with no handles and no network, at most 3 MiB; `422 {"error":{"code":"render_failed"\|"timeout"}}`; `404` when the service does not render thumbnails                                           |
| `POST /admin/kernels/stop?owner=<owner email>&workspace=<workspaceId>`                          | Saves the open notebooks into the workspace, then closes them; runs no cell. `2xx` when the caller is a service administrator, `403` otherwise. Carries the caller's own token, and `X-External-Kernel-Owner` names the caller. |
| `* /workspaces/{workspaceId}/proxy/{path}`                                                      | HTTP and WebSocket proxy to the root of the user's marimo server                                                                                                                                                                |
| `POST /apps/sessions` `{"session","app","version","notebook","files","environment"}`            | `2xx {"session":"<the hub's id>"}`; `404 {"error":{"code":"no_kernel"}}` when the author has no kernel (see [Apps](#apps))                                                                                                      |
| `* /apps/sessions/{session}/proxy/{path}`                                                       | HTTP and WebSocket proxy to the app, for the viewer who opened it                                                                                                                                                               |
| `DELETE /apps/sessions/{session}`                                                               | `2xx` or `404`                                                                                                                                                                                                                  |
| `PUT /jobs/{jobKey}` `{"schedule","timezone","enabled"}`                                        | `2xx`; registers or replaces the author's scheduled job (see [Scheduled jobs](#scheduled-jobs))                                                                                                                                 |
| `DELETE /jobs/{jobKey}`                                                                         | `2xx` or `404`                                                                                                                                                                                                                  |

The hub stores the file key in the session's origin URL and adds
`file=<key>` to every proxied request that has no `file` parameter. The hub
strips its own `/proxy/<token>` prefix, because one server serves every
notebook and has no per-session base URL. Proxied requests reach the service
with `Host` and `Origin` set to the service itself; the service presents
whatever `Host` and `Origin` marimo accepts, and it must refuse `..` in `path`.
