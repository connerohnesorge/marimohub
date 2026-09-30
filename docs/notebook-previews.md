# Notebook previews

A preview publishes GitHub code through an existing notebook, with a stable share URL and separate, disposable compute.
Managers and admins can create and delete previews. Sharing a URL does not grant notebook access.

## Create a preview

Open **Previews** from the notebook menu. Select **Create preview**.
Previews require a GitHub App connection with access to the notebook's configured repository.

- **Follow a branch** publishes the current commit and follows new pushes.
- **Pin to a commit** publishes a full, 40-character SHA. Future pushes do not change it.

GitHub suggestions show up to 30 matches from the first 100 branches or recent commits.
You can enter a branch or full SHA manually, including when suggestions fail.

Previews inherit integrations and secrets, including credential rotation. Existing restrictions on temporary viewer editors still apply.
Pinning freezes code only.

## Run and share

Copy the link from the preview list or header. Existing notebook permissions determine access:

- App-users can run apps.
- Viewers can use modes allowed by the deployment's viewer configuration.
- Editors, managers, and admins can open personal temporary editors.

Temporary edits stay in the sandbox. They never update notebook history, workspace storage, GitHub, or the published preview.
Preview editors have no persistent personal home. Authorized integrations still permit access to external systems.

New sessions use the latest successfully prepared revision. Running sessions keep their original revision and edits.
The page indicates newer revisions. **Discard edits and open latest** replaces a temporary editor.
If an update fails, the page displays an error and keeps the previous revision available.

## API and CLI

Create, list, get, delete, and session creation endpoints use this base path:

```text
/api/v1/projects/{pid}/notebooks/{nid}/previews
```

The generated CLI exposes the same operations:

```sh
mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Chart review' --source '{"type":"branch","branch":"feature/chart"}' \
  --idempotency-key 'chart-review-pr-42' --pull-request 42

mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Release review' --source '{"type":"commit","commit":"0123456789abcdef0123456789abcdef01234567"}'

mohub notebooks previews delete --pid "$PROJECT" --nid "$NOTEBOOK" \
  --preview-id "$PREVIEW" --yes
```

Retries with the same idempotency key return the same preview. Reusing that key for a different request or deleted preview fails.
API tokens need the corresponding project grants and actions. Management and source suggestions require `preview.manage`.
Session creation accepts a mode without a ref override.

Optional `pull_request` tracking retires a preview after its PR closes or merges. Branch previews must select the PR's head branch.
Fork PRs and automatic label triggers are unsupported. CI can use the API or CLI to create and delete previews on label changes.

## Operation and limits

Node maintenance checks sources every five minutes. Session launches also check, at most once per minute per preview.
Cloudflare maintenance uses its configured schedule. The reference Worker requires a GitHub App registry to create previews.
Automatic updates, expiry, and cleanup require maintenance.

Previews expire after seven days by default, with an API maximum of 30 days.
Deletion immediately blocks access. Cleanup waits for starting sessions and retries failed destruction.
Deleting a parent notebook or project also retires its previews.

`MARIMOHUB_PREVIEW_COMPUTE_PROFILE` sets the default profile for all preview modes.
If unset, previews use the deployment default, ignoring the notebook's compute profile.
If deployment configuration permits overrides, managers can select another allowed profile.

Each preview permits ten active sessions across users and revisions, with at most two app replicas per revision.
Lower deployment limits still apply. Idle retirement uses five minutes, subject to active connections and app visits.
Cleanup removes unused revisions after reclaiming their sessions.
