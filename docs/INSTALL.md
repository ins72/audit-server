# Install on your own server

You need a Linux machine with Docker and Docker Compose, ports 80 and 443 open, and a domain name whose A (or AAAA) record points at the machine.

```
git clone <your repository> app && cd app
node tools/setup.js --domain tv.example.com     # writes .env with fresh secrets, prints the operator token once
docker compose up -d --build                    # builds, starts the app and HTTPS (Caddy gets the certificate by itself)
```

Then open `https://tv.example.com/operator/`, paste the operator token, and set the name, logo, links and starting add-ons. People sign up at `https://tv.example.com/`.

`OWN_ACCOUNTS=true` (set by the script) means people's accounts, library and add-ons live on your server and nothing is sent to another company's account service. Optional parts are switched on in `.env` (see `.env.example`): payments (`PAYWALL_ENABLED`, `STRIPE_*`), emails such as password reset (`RESEND_API_KEY`, `MAIL_FROM`), Trakt (`TRAKT_*`).

## Where the data is
One Docker volume, `appdata`, holds the account database, settings, billing, statistics and uploaded logos. The account database also writes its own consistent copy once a day (`accounts.db.bak-YYYY-MM-DD`, seven kept) **in the same volume**, so it does not protect against losing the machine. Copy the volume somewhere else regularly.

## Back up
```
docker run --rm -v <project>_appdata:/data -v "$PWD":/out alpine tar czf /out/backup-$(date +%F).tgz -C /data .
```
(`<project>` is the folder name, see `docker volume ls`.) Do it daily from cron and keep copies off the machine.

## Restore
```
docker compose down
docker run --rm -v <project>_appdata:/data -v "$PWD":/in alpine sh -c 'rm -rf /data/* && tar xzf /in/backup-YYYY-MM-DD.tgz -C /data'
docker compose up -d
```
Check `https://tv.example.com/healthz` and sign in with a test account. Do this once on a spare machine before you rely on it (task P1-04, a restore drill, is open until it has been done on a real server).

## Update
```
git pull && docker compose up -d --build
```
The data volume is kept. The database changes itself forward when a new version needs it, so take a backup first.

## Not tested here
The compose file and setup script are checked (the file validates, the script has a test), but no image was built and started in this environment, so the first real install is the real test. Please report anything that does not work.
