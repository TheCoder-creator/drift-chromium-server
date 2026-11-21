# Drift central Chromium server

This repository runs a shared, remote Chromium service for the Drift Cloudflare Worker.

## Deploy

Deploy this repository to a container host that supports Docker and long-running web services. Set the service's start command to the Dockerfile default and expose port 3000.

Required environment variable:

- `DRIFT_SERVER_SECRET`: a random secret of at least 24 characters. Keep it private and do not commit it.

Optional environment variables:

- `PORT`: defaults to 3000
- `MAX_SESSIONS`: defaults to 6
- `MAX_SESSIONS_PER_IP`: defaults to 2
- `SESSION_TTL_MS`: defaults to 600000 (10 minutes)

After deployment, confirm that `https://YOUR-SERVER/health` returns JSON with `ok: true`.

## Connect the Cloudflare Worker

In the Cloudflare Worker named `horizon-chromium`, add these secrets/variables:

- `BROWSER_SERVER_URL`: the HTTPS base URL of this service, without a trailing slash
- `BROWSER_SERVER_SECRET`: exactly the same value as `DRIFT_SERVER_SECRET`

Never put the secret in frontend JavaScript, a public GitHub file, or a screenshot.

## Notes

Drift uses isolated temporary browser contexts. Sessions expire after inactivity. This service is resource-intensive; free hosting plans may sleep, limit memory, or stop long-running containers. Start with a private test deployment and limit access before sharing it widely.

The URL filtering blocks common private and local IP ranges, but it is not a substitute for network-level egress isolation. Do not use this as a production-grade public browsing proxy without additional security review, abuse controls, and network restrictions.
