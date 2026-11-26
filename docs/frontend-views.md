# Imagine registry: frontend views (content spec)

This spec covers what each view must contain, what it must do and which states it has. It does not cover visual design or styling; those decisions are yours.

## Context

- Imagine is a self-hosted OCI/Docker registry. Each deployment serves one organization.
- The repository (image) index is stored in Postgres and blobs are stored in S3. The registry is reached at `PUBLIC_URL` (for example `registry.example.com`).
- The backend has the OCI `/v2` registry API, with authentication, and part of the REST API under `/api`. Endpoints that exist today:
  - `GET /api/meta`: registry host and whether first-run setup is needed. Public.
  - `GET /api/repositories`: name, visibility, created at, total size, tag count and last pushed. Signed in. Sorted by name. No paging or search.
  - `DELETE /api/repositories?name=`: delete an image with its tags, manifests and uploads in progress. Admin only.
  - `GET /api/repositories/tags?name=<repo>`: tag, manifest digest, media type, size and pushed at. Signed in. `pushedAt` is when the manifest was first pushed, not when the tag last moved.
  - `DELETE /api/repositories/tags?name=&tag=`: delete a tag. Its manifest stays. Admin only.
  - `GET /api/repositories/platforms?name=&digest=&digest=`: platforms for up to 25 manifest digests. Signed in.
  - `GET /api/users`: email, role, joined at, last active, and whether the user is active (not banned). Admin only. Last active can lag web use by a day, and a user who signed out and has not used a personal access token has none.
  - `PATCH /api/repositories/visibility`: body `{ name, visibility }`. Admin only.
  - `POST /api/tokens`: create a personal access token. Body `{ access: "read" | "read-write", name?, expiresIn? }`. Signed in.
  - `GET /api/invites/lookup?token=`: email and role of a pending invite. Public.
  - `GET /api/invites`, `POST /api/invites`, `DELETE /api/invites?id=`: list pending invites, create one, revoke one. Admin only.
  - `/api/auth/*` (better-auth): email code sign-in and sessions. The admin plugin adds list users, set role, remove user and ban user under `/api/auth/admin/`. The api-key plugin adds list and delete under `/api/auth/api-key/`. No app route wraps these.
- Still missing:
  - Paging and search on the server. The views do both in the browser.
- Creating an invite again replaces the pending one, which is how Resend works.
- Role changes and removal use better-auth's admin routes. The server refuses to remove, demote or ban the last working admin. Removing a user also removes their personal access tokens and the pending invites they sent.
- Expired personal access tokens are deleted by better-auth when tokens are listed, so they do not stay in the list.
- The data the backend already stores:
  - **Repository:** name (may contain `/`, e.g. `team/app`), visibility (`private` | `public`), created at.
  - **Manifest:** digest, media type, subject digest, artifact type, created at. An image index (multi-arch) points to child manifests, one per platform.
  - **Tag:** name and the manifest digest it points to.
  - **Blob:** digest and size.

## Roles and permissions

| Action | Member | Admin |
|---|---|---|
| Sign in, view images, pull | ✓ | ✓ |
| Push (via personal access token) | ✓ | ✓ |
| Change repository visibility | — | ✓ |
| Delete tag / delete image | — | ✓ |
| Invite, remove users, change roles | — | ✓ |
| Manage own personal access tokens | ✓ | ✓ |

Member is the `user` role in better-auth. Admin is `admin`.

Hide any action the current user cannot perform. Public repositories can be pulled without credentials, but the web UI always requires sign-in.

## Shared states (apply to every data view)

- Loading.
- Error, with a retry action.
- Session expired: the user is sent to Login and returned to the page they were on after signing in.
- Forbidden: the user tried to reach an admin-only page as a member.
- Not found: an unknown repository or tag, or a deep link to something that was deleted.
- Success and failure feedback after every mutation (visibility change, delete, invite, revoke, etc.).

---

## 1. Login (email OTP, invite-only)

**Step 1: email**
- Email input and a "Send code" action.
- Inline validation for a malformed email.
- To avoid leaking which emails are invited, show the same confirmation whether or not the email is invited ("If this email has access, we sent a code").
- Rate-limit state: "Too many attempts, try again in N seconds".

**Step 2: code**
- Shows the email the code was sent to, with a "Change email" action that returns to step 1.
- Code input (number of digits set by the backend; assume 6). The code can be pasted, and the form submits automatically once the code is complete.
- "Resend code" with a cooldown countdown.
- Errors: wrong code, expired code, too many attempts.
- On success the user lands on the page they originally requested, or on Image overview.

**Accept invite (entry via the invite email link)**
- Shows the organization or registry name and the invited email, which is pre-filled and cannot be edited.
- After that it follows the same OTP flow as above.
- Invalid or expired invite: a message telling the user to ask an admin for a new invite.

**First-run setup (only when no users exist)**
- Explains that this is a new registry and that the first account becomes admin.
- Email input, then the OTP code step, and the account is created as admin.
- Once a user exists this screen can never be reached again.

## 2. App shell

Wraps every signed-in view.

- Registry identity: name and host (`PUBLIC_URL` host).
- Navigation: **Images**, **Personal access tokens**, **Admin** (admins only). The current location is indicated.
- User menu: email, role badge (Admin/Member), **Sign out**.
- Area where per-page titles and breadcrumbs (e.g. Images › `team/app`) appear.
- Area for global feedback messages (toasts/banners).
- Must work at mobile width (navigation collapses).

## 3. Image overview

A list of all repositories in the registry.

**Per row**
- Repository name (full path, e.g. `team/app`).
- Visibility: Private / Public.
- Tag count.
- Total size, meaning the sum of unique blob sizes in the repository.
- Last pushed: relative time, with the absolute timestamp available.
- The whole row links to Image detail.

**Controls**
- Search by name (substring match, which also matches path segments).
- Sort by name or by last pushed (default: last pushed, newest first).
- Pagination or incremental loading. Assume hundreds of repositories.

**States**
- Empty registry: explains how to push the first image. It shows these copyable commands, filled in with the real host:
  ```
  docker login <host>            # username: your email, password: a personal access token
  docker tag my-image <host>/my-image:latest
  docker push <host>/my-image:latest
  ```
  It also links to personal access tokens ("You need a personal access token to push").
- Search with no results: shows the search term and a "Clear search" action.

## 4. Image detail

The page for one repository.

**Header**
- Repository name and the full reference `<host>/<name>`, which can be copied.
- Visibility: shows the current value. Members see it read-only. Admins change it (Private ↔ Public).
  - Before changing, the user confirms in a dialog that explains the consequence. Making a repository public lets anyone pull it without credentials. Making it private means pulls need a personal access token.
- Summary: tag count, total size, created at, last pushed.
- **Delete image** (admins only): a destructive action that deletes the repository with all its tags and manifests.
  - The user must type the repository name to confirm. The dialog says how many tags will be removed and that this cannot be undone. Storage is freed later by the sweep.

**Tags list**
Each tag row shows:
- Tag name.
- Short manifest digest (e.g. `sha256:1a2b3c4d…`). It can be copied in full, and the full digest is available on demand.
- Size.
- Pushed at (relative time, with the absolute timestamp available).
- Platforms: for a multi-arch image, the list of OS/arch(/variant) values (e.g. `linux/amd64`, `linux/arm64/v8`). For a single-platform image, its one platform.
- When several tags point to the same digest, the row shows this (e.g. "also tagged: `latest`, `1.4`").
- Copyable pull commands: `docker pull <host>/<name>:<tag>` and a by-digest variant `docker pull <host>/<name>@<digest>`.
- **Delete tag** (admins only). The confirmation names the tag. It also warns when the manifest will become untagged, and says when other tags still point to it and will keep it.

**Controls**
- Search tags by name.
- Sort by pushed date (default newest first) or by name.
- Pagination. Assume repositories with thousands of tags.

**States**
- Repository with no tags: says that only untagged manifests or nothing remain, and shows the push command for this repository.
- Not found: the repository was deleted or the name is wrong.
- Deleting the last tag keeps the user on this page and shows the no-tags state. Deleting the image returns the user to Image overview with a success message.

## 5. Admin settings (admins only)

**Invite user**
- Email input and role choice (Member default, Admin).
- On submit the invite appears in Pending invites and an email with the invite link is sent.
- Errors: invalid email, the user already exists, an invite is already pending.

**Pending invites list**
- Email, role, invited by, sent at, expires at.
- Actions: **Resend**, **Revoke** (with confirmation).
- Empty state: "No pending invites".

**Users list**
- Email, role, joined at, last active.
- Marks the current user with "(you)".
- **Change role** (Member ↔ Admin).
- **Remove user** (with confirmation). The confirmation says this signs the user out everywhere and revokes all their personal access tokens. The user's pushed images remain.
- Guard rails, which show the action as disabled with an explanation:
  - You cannot remove yourself.
  - The last remaining admin cannot be removed or demoted.
- Search by email when the list is long.

## 6. Personal access token settings

The current user's own tokens. A personal access token is the password for `docker login`, and the username is the user's email.

**Create token**
- Name (required, e.g. "CI laptop").
- Scope: **Read** (pull only) or **Read & write** (pull and push).
- Expiry: 30 days, 90 days, 1 year, or never (default 90 days).
- After creation, a view the user sees only once:
  - The secret, with a copy action.
  - A warning: "You won't see this again."
  - A ready-to-run `docker login <host> -u <email>` example (password read from stdin).
  - An explicit "Done" action. The secret is never shown again.

**Tokens list**
- Name, scope, a token prefix (e.g. `img_ab12…`) so the token can be identified, created at, last used (or "Never"), expires at.
- Expired tokens stay listed and are marked as expired.
- **Revoke** (with confirmation). The confirmation says that anything using this token stops working immediately.

**States**
- No tokens: explains what tokens are for and offers a create action.

---

## Out of scope (do not design)

- Retention or cleanup policies (the owner explicitly rejected these).
- Per-repository permissions, teams, multiple organizations.
- Profile page or session management.
- Layer/manifest drill-down, signatures/SBOM views, vulnerability scanning.
- Pull-through cache / mirrors.
