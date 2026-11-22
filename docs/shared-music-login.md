# Folia Sync Server

Use one Folia deployment for the Web/PWA and every desktop client you want to connect. QQ Music and NetEase Cloud Music support shared authorization. Each Folia user has a personal Sync Token for enrolling devices, and each enrolled device has a revocable 90-day session. The same Worker and device session sync appearance settings, AI themes, and music account authorizations. Each account has its own settings, themes, and provider sessions in D1.

## Enable it on Cloudflare

1. Create a D1 database with `wrangler d1 create folia-shared-login`.
2. Add the database binding and schedule to the root `wrangler.jsonc`. Use the database ID returned by Wrangler.

   ```jsonc
   "d1_databases": [
     {
       "binding": "FOLIA_SHARED_LOGIN_DB",
       "database_name": "folia-shared-login",
       "database_id": "<database-id>",
       "migrations_dir": "migrations/sharedLogin"
     }
   ],
   "triggers": { "crons": ["*/10 * * * *"] }
   ```

3. Run `wrangler d1 migrations apply folia-shared-login --remote`. Set the Worker secret with `wrangler secret put QQ_SESSION_SECRET` if the deployment does not have it. Use a strong random secret and keep it available for future deployments.
4. Set `VITE_QQ_API_BASE=/api/qq` for the Web build so QQ Music is also available before the browser discovers its device session. Build with `npm run build` and deploy with `wrangler deploy`.
5. Run `node dev/sharedLogin/createUser.mjs folia-shared-login --remote` and give the token it prints to that user. Run it once per user. This token is separate from the deployment's encryption secrets.

## Enable NetEase Cloud Music

The Folia Worker calls NetEase directly and stores each user's session encrypted in D1. An enrolled Web/PWA or desktop client gets its NetEase session from that Worker. `VITE_NETEASE_API_BASE` is only for the separate Web backend used by unenrolled clients. The root Wrangler configuration already enables the Node.js compatibility used by the protocol library.

Set a durable encryption secret once for the Worker.

```sh
openssl rand -hex 32 | wrangler secret put NETEASE_SESSION_SECRET
```

The same D1 binding, cron trigger, and personal Sync Tokens work for both providers. The Worker advertises NetEase shared login when the encryption secret is configured. Users authorize NetEase by scanning from the existing music account window.

## Connect the clients

Open **Settings → Connections → Sync Server**. Turn on sync, enter the Folia Worker origin and your personal Sync Token, then save. On Web/PWA, open the Folia origin directly. Devices already connected to this Worker can reuse their device session. After connecting, open the music account window and scan for each music service you want to share. QQ Music accepts WeChat and mobile QQ. Other devices for that Folia user pick up the shared NetEase authorization when opened or brought back into focus. Scan again to move an existing local sign-in to the shared service.

Disconnect or revoke an individual device from the settings list. Signing out of a shared provider unlinks its authorization for that user. When the provider requires a new scan, complete it on any connected device. Scheduled renewal keeps the authorization available while clients are closed, up to the upstream session lifetime.

Desktop sessions use the operating system's credential storage. On Linux without a usable secret store, the session lasts until the app exits.

## Existing standalone Sync Server

Clients can still use a standalone Sync Server for appearance and theme sync. To move to the combined Worker, export the library while connected to the old server, connect with your personal Sync Token, then import the archive into your account.
