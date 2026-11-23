# Response inbox

Published reports with `UserRespond` receive a submit-only token embedded in the page. Briefkit creates a response channel for each `publish` command, whether or not `--wait-for-response` is used. The publish server stores every submission as a separate private record; repeat or revised answers do not overwrite earlier answers. The original `schemaVersion`, `formId`, `answers`, `submittedAt`, and `pageUrl` envelope is retained as `submission`. Each record adds `submissionId`, server-side `receivedAt`, and `revisionId` (the channel ID created for that publish). Revision IDs identify a publication attempt, **not** a snapshot of an old page. Client-supplied timestamps and page URLs remain untrusted declarations.

Retrieve without consuming or deleting records:

```sh
briefkit responses my-brief --target https://briefs.example.com --api-key KEY
briefkit responses https://briefs.example.com/my-brief/ # uses publish-config credentials
```

The API is `GET /api/briefs/:slug/responses?limit=100&offset=0`, authenticated by the publish API key (not the public submit token). It returns `{ slug, total, responses }`, ordered by server receipt time and ID. The CLI pages through all records and writes one JSON object to stdout. A missing inbox returns an empty list. Neither read alters the inbox. The inbox remains after a brief is unpublished or its page expires. If the same slug is reused, records from both revisions appear under that slug. This does not preserve the prior published HTML.

`--wait-for-response` still prints the first original submission envelope on the final output line. On publish, it no longer deletes the channel: later responses remain accepted while that channel is active and can be retrieved by slug. Channel expiry defaults to the server's brief duration (`BRIEFKIT_DEFAULT_DURATION`, normally `3mo`); `publish --duration` sets both page and response channel duration. `forever` does not expire. Responses already stored remain after expiry. Standalone channel clients can request `duration` on `POST /api/response-channels`; `BRIEFKIT_RESPONSE_DURATION` overrides their default. A stale or unpublished page cannot submit after its channel expires. A page can also become inaccessible before its channel expires if explicitly unpublished.

For local loopback use:

```sh
briefkit build ./report --serve-responses --no-open # stays running until interrupted
briefkit responses REVISION_ID --local          # works after the server stops
```

The build command prints the revision ID. While `--serve-responses` runs, multiple submissions are saved in `~/.local/share/briefkit/responses/REVISION_ID/` by default, outside the built site. `BRIEFKIT_RESPONSE_STORAGE_DIR` overrides this local private directory. `build --wait-for-response` also saves its first submission, but exits and closes its loopback listener after that first response; it **cannot** receive new submissions after shutdown. The retrieval command can read saved submissions later. The local listener binds only to `127.0.0.1`; it is not a public webhook.

By default records omit IP addresses. For local loopback, `build --serve-responses --capture-response-ip` (or `--wait-for-response --capture-response-ip`) stores the socket peer address. For a publish server, set `BRIEFKIT_RESPONSE_CAPTURE_IP=true`. Neither mode trusts `X-Forwarded-For` or other client-provided forwarding headers. Behind a reverse proxy, the recorded address is the proxy peer, not an asserted end-user IP. Response records contain potentially sensitive answers: secure the server storage volume and API key, and do not expose the private response directory as a separate static route. The publish server stores channel metadata and response files in `BRIEFKIT_RESPONSE_STORAGE_DIR`, outside `BRIEFKIT_STORAGE_DIR` (the public static root). The Docker image defaults to `/responses` and `/briefs` respectively; mount both persistently. A direct Node server defaults private storage to a sibling directory of its public storage directory.

Merge integration: this lane changes `src/lib/cli.ts`, `src/lib/responses.ts`, and `publish-server/server.js` minimally around response hooks. Keep the response target metadata passed through `WorkspaceOptions` and `ReportLayout`; do not duplicate or replace `UserRespond` form layout. If another lane changes publish payloads, preserve `responseChannelId` in `/api/publish` and leave channel binding on the server after slug selection. If another lane changes output cleanup, preserve the persisted inbox when removing a built site or unpublished brief.
