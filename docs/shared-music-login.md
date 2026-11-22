# Shared music login

Use one Folia deployment for the Web/PWA and every desktop client you want to connect. QQ Music is the first supported provider. Each Folia user has a personal Sync Token for enrolling devices, and each enrolled device has a revocable 90-day session. The separate Sync Server token still serves appearance and theme sync.

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
5. Run `node dev/sharedLogin/createUser.mjs folia-shared-login --remote` and give the token it prints to that user. Run it once per user. This token is separate from the deployment's `QQ_SESSION_SECRET`.

## Connect the clients

Open **Settings → Connections → Shared music login**. Enter a device name and the user's personal Sync Token. On desktop, enter the Web deployment's HTTPS origin as well. After connecting, open the music account window and sign in to QQ Music with WeChat or mobile QQ. Other devices for the same Folia user can open QQ Music without scanning again. Scan again to move an existing local QQ login to the shared service.

Disconnect or revoke an individual device from the settings list. Signing out of QQ Music unlinks the shared authorization for that user. When the provider requires a new scan, complete it on any connected device. Scheduled renewal keeps the authorization available while clients are closed, up to the upstream session lifetime.

Desktop sessions use the operating system's credential storage. On Linux without a usable secret store, the session lasts until the app exits.
