# imagine

Imagine is a self-hosted Docker and OCI registry for one organization. Your team changes image names to `<host>/<team>/<app>` once, then uses normal `docker push` and `docker pull`. Image blobs go to any S3-compatible store. The image index and accounts go to Postgres. Everything runs in Docker Compose on Bun.

## Status

Push and pull work with a real Docker client. For what has not been tested, see [Not tested](#not-tested).

Not built yet:

- The registry `DELETE` API. The registry answers `DELETE` on manifests and blobs with 405, or with 401 if the caller has no push access. Admins delete images and tags in the web UI instead.
- The referrers API.
- Paging and search in the REST API. See `docs/frontend-views.md`.

## Services

| Service | What it does | Published |
| --- | --- | --- |
| `web` | nginx. Serves the web UI and forwards `/api`, `/v2` and `/token` to `imagine`. | `127.0.0.1:8080` |
| `imagine` | The Bun server: registry, REST API and sign-in. Runs database migrations at start and the cleanup sweep on `SWEEP_SCHEDULE`. | none |
| `postgres` | Postgres 17. Holds the image index and accounts. | none |
| `seaweedfs` | Optional, with `--profile s3`. Bundled S3 store, SeaweedFS 4.52 in `mini` mode. | `127.0.0.1:8333` |

`web` is the entry point. Put your TLS proxy in front of it. The `spool` volume holds uploads in progress.

## Quick start

1. Copy the example file and fill in the secrets.

   ```bash
   cp .env.example .env
   openssl rand -hex 32   # BETTER_AUTH_SECRET
   openssl rand -hex 24   # POSTGRES_PASSWORD
   ```

   Set `PUBLIC_URL` to the address your proxy serves, with the scheme, for example `https://registry.example.com`. Compose refuses to start while a required value is blank.

2. Set the S3 values.

   - **Bundled SeaweedFS:** set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_PUBLIC_ENDPOINT` and `SEAWEEDFS_FILER_SIGNING_KEY` (`openssl rand -hex 32`). The bundled service uses the same key pair as the app.
   - **External S3:** set the key pair, `S3_PUBLIC_ENDPOINT`, and `S3_ENDPOINT` to your provider's endpoint. The default `S3_ENDPOINT` points at the bundled SeaweedFS, so you must change it. Create the bucket named in `S3_BUCKET` first. The app does not create it.

3. Start the stack.

   ```bash
   docker compose --profile s3 up -d --build   # bundled SeaweedFS
   docker compose up -d --build                # external S3
   ```

Then sign in right away. See [First sign-in and API keys](#first-sign-in-and-api-keys).

## Official images

The official images are [`uninspiredstudioops/imagine-server`](https://hub.docker.com/r/uninspiredstudioops/imagine-server) (the `imagine` service) and [`uninspiredstudioops/imagine-web`](https://hub.docker.com/r/uninspiredstudioops/imagine-web) (the `web` service). `latest` and `main` follow the `main` branch, and `develop` follows `develop`. To use them instead of building, see the quick start in `apps/docs/src/content/docs/quick-start.mdx`.

## Configuration

Compose reads these from `.env`. It sets `DATABASE_URL` and `SPOOL_DIR` for you.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `PUBLIC_URL` | yes | none | Public URL with scheme. Used for `Location` headers, the token realm and invite links. |
| `BETTER_AUTH_SECRET` | yes | none | Signs sessions and registry tokens. At least 32 characters. Changing it logs everyone out. |
| `POSTGRES_PASSWORD` | yes | none | Password for the `imagine` database user. Use hex only, because it goes into a URL. |
| `AWS_ACCESS_KEY_ID` | yes | none | S3 access key. The bundled SeaweedFS uses the same pair. |
| `AWS_SECRET_ACCESS_KEY` | yes | none | S3 secret key. |
| `S3_PUBLIC_ENDPOINT` | yes | none | Public S3 URL that pulls redirect to. Clients must be able to reach it. |
| `SEAWEEDFS_FILER_SIGNING_KEY` | with `--profile s3` | none | Signs SeaweedFS filer calls. The bundled service refuses to start without it. |
| `S3_ENDPOINT` | no | `http://seaweedfs:8333` | Internal S3 endpoint that the app writes to. Change it for external S3. |
| `S3_BUCKET` | no | `imagine` | Bucket name. The bundled SeaweedFS creates it. For external S3, create it yourself. |
| `S3_REGION` | no | `us-east-1` | S3 region. |
| `TRUSTED_ORIGINS` | no | blank | Extra origins allowed to sign in, comma-separated. For example, the Vite dev server. |
| `PLUNK_API_KEY` | no | blank | Sends mail through Plunk when set. Plunk wins over SMTP. Needs `MAIL_FROM`. |
| `PLUNK_API_URL` | no | `https://next-api.useplunk.com` | Plunk API URL. |
| `SMTP_URL` | no | blank | Sends mail through SMTP, for example `smtps://user:pass@smtp.example.com:465`. Needs `MAIL_FROM`. |
| `MAIL_FROM` | with `PLUNK_API_KEY` or `SMTP_URL` | blank | Sender address, without a display name. With Plunk, its domain must be verified. |
| `MAX_BLOB_BYTES` | no | `17179869184` (16 GiB) | Largest blob. Counts bytes already uploaded. |
| `PRESIGN_TTL_SECONDS` | no | `900` | Lifetime of presigned blob URLs, in seconds. |
| `SWEEP_SCHEDULE` | no | `0 * * * *` | Five-field cron schedule for the cleanup sweep. Hourly by default. |

With neither `PLUNK_API_KEY` nor `SMTP_URL` set, sign-in codes and invite links are written to the log. Use that for development only.

## TLS proxy

Compose serves plain HTTP on loopback. Your proxy runs on the same host, terminates TLS and forwards to it.

Two hosts need a proxy entry:

- **Registry host** (the host in `PUBLIC_URL`): forward everything to `127.0.0.1:8080`.
- **S3 host** (the host in `S3_PUBLIC_ENDPOINT`): forward to `127.0.0.1:8333`. This applies only when you use the bundled SeaweedFS. With external S3, your provider serves this host, and clients must still reach it.

The registry host needs these settings:

- `client_max_body_size 0` and `proxy_request_buffering off`. The app enforces `MAX_BLOB_BYTES` itself.
- `proxy_read_timeout` and `proxy_send_timeout` of `3600s`. The final blob PUT sends no bytes while it hashes and writes to S3. In testing, nginx's 60-second default returned 504 on a large layer.
- `proxy_set_header X-Forwarded-For $remote_addr`. The API rate-limits sign-in attempts per address, so this must be the real client address. Overwrite the header. Do not use `$proxy_add_x_forwarded_for`, which appends to a value the client may have sent.

The timeouts also bound stalled uploads. Imagine turns off its own idle timeout on upload requests, so a stalled `PATCH` stays open until the proxy's timeout.

The S3 host needs:

- `proxy_set_header Host $http_host`. Presigned URLs are signed over the host. A rewritten `Host` fails with `SignatureDoesNotMatch`.
- `proxy_buffering off`, so large downloads do not spool to the proxy's disk. This is not tested yet.

This example follows the rules above. It has not been run against this Compose file. `proxy_http_version 1.1` matches `apps/web/nginx.conf`.

```nginx
# Registry host: web UI, /api, /v2 and /token
server {
    listen 443 ssl;
    server_name registry.example.com;
    # ssl_certificate and ssl_certificate_key: your certificate

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}

# S3 host: presigned blob URLs (bundled SeaweedFS only)
server {
    listen 443 ssl;
    server_name s3.registry.example.com;
    # ssl_certificate and ssl_certificate_key: your certificate

    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8333;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
    }
}
```

## First sign-in and API keys

The first person to sign in on an empty registry becomes admin. Open `PUBLIC_URL` and sign in with your email before you share the address. Sign-in codes arrive by mail when mail is configured. Otherwise, read the code from the log:

```bash
docker compose logs imagine
```

Other people need an invite. Send one from the **Admin** page. The invite link works for 7 days.

Create your key on the **API keys** page. Use the Read scope for pull-only access. The key is shown once, so copy it right away.

Log in with the key as the password. The server ignores the username.

```bash
docker login registry.example.com -u you@example.com
docker tag my-image registry.example.com/team/app:1.0
docker push registry.example.com/team/app:1.0
```

New repositories are private. Pulls from a private repository need a key. Anyone can pull a public repository without logging in. Only admins can change visibility, on the image's page.

## Cleanup

The `imagine` service runs a sweep on `SWEEP_SCHEDULE`. Bun reads the schedule in the local time zone of the container. This project sets no time zone for it, so that is UTC. `compose.yaml` does not pass `TZ` on, so setting it in `.env` has no effect.

Each sweep removes:

- Uploads idle for 24 hours, and their spool files.
- Spool files older than 24 hours that have no upload row.
- Blobs that no manifest references and that are more than 24 hours old. A blob you push again, or mount into another repository, gets a new 24 hours.

The sweep keeps untagged manifests. A manifest keeps the blobs it references, so those blobs stay too.

Admins delete images and tags in the web UI. Deleting an image removes its tags and manifests and ends its uploads in progress. The sweep then removes blobs that no other image uses, once they are 24 hours old. Deleting a tag keeps its manifest, so its storage is freed only when the whole image is deleted.

If an S3 delete fails, the sweep counts a failure and the next run retries it. A sweep killed during an S3 delete can leave one orphaned object, which is not found again. An upload resumed after 24 idle hours may have to start over.

To run a sweep now:

```bash
docker compose exec imagine bun run apps/server/src/index.ts --sweep
```

The command prints one summary line and exits 0 when nothing failed, or 1 otherwise.

## Limits

- Run one `imagine` replica. Uploads spool to a local volume, and the upload and auth queues live in process memory. More replicas need a shared volume or sticky routing.

## Development

Install dependencies at the repo root with Bun 1.4.4, the version the Dockerfiles pin.

```bash
bun install
bun check      # type check; the root typecheck script calls it
bun test
```

`bun test` skips the database suites unless `TEST_DATABASE_URL` is set. Each suite needs its own throwaway database, because they change data:

- The auth suite refuses to run if the database already has users.
- The sweep suite empties the registry tables before each test.
- The registry suite runs migrations and writes its own rows.

Run each suite separately, with its own database:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/imagine_sweep bun test apps/server/src/sweep.test.ts
```

### Docs site

`apps/docs` is an Astro site that deploys to Cloudflare Workers as static assets. Pages are MDX files in `apps/docs/src/content/docs`. Their path is their URL, and their frontmatter (`title`, `description`, `section`, `order`) builds the sidebar. Pages can import Subframe components. To pass JSX in a prop, wrap the component in a `.tsx` file first, because MDX cannot.

Agents can read every page as Markdown at `/<page>.md`, an index at `/llms.txt`, and all pages in one file at `/llms-full.txt`. All are built from the MDX source, so a component on a page shows up there as JSX.

```bash
bun run --filter @imagine/docs dev
bun run --filter @imagine/docs check
bun run --filter @imagine/docs build
bun run --filter @imagine/docs preview   # serves the build with wrangler
```

`apps/docs/wrangler.jsonc` has one environment per branch. A push to `main` or `develop` triggers the build and deploy. Never deploy manually.

| Environment | Address |
| --- | --- |
| `main` | `docs.imagine.uninspired.app` |
| `develop` | `docs.imagine.dev.uninspired.app` |

## Not tested

- Layers over 5 GB from a real Docker client. A 6 GiB upload through nginx was tested without one.
- The OCI conformance suite, multi-arch images, Helm and cosign. None are recorded as run.
- The nginx examples above, against this Compose file.
- `proxy_buffering off` on the S3 host.

## License

[MIT](LICENSE)
