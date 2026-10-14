# Mealio

Base personale con TanStack Start in SPA mode, server Nitro, accesso a password singola e SQLite persistente.

## Sviluppo locale

Requisiti: Node.js `>=22.12` e pnpm `11.21`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm auth:hash
```

`pnpm auth:hash` legge la password senza mostrarla e stampa solo l'hash scrypt. Copia l'hash in `ADMIN_PASSWORD_HASH` nel `.env` locale. Imposta `SESSION_SECRET` e `BACKUP_ENCRYPTION_KEY` con valori casuali distinti; per quest'ultima usa 32 byte codificati in Base64, per esempio `openssl rand -base64 32`.

```sh
pnpm db:migrate
pnpm dev
```

La UI locale è disponibile su `http://localhost:3000`. I file `.env`, database SQLite e directory `data/` sono esclusi da Git.

Per modifiche allo schema, aggiorna `src/db/schema.ts`, genera la migration SQL e applicala:

```sh
pnpm db:generate
pnpm db:migrate
```

Le migration SQL e i relativi snapshot in `drizzle/` fanno parte del repository. In produzione `pnpm start:deploy` applica le migration prima di avviare il server.

## Railway

Il progetto va creato nel workspace personale **My Projects**, non in **VLK Studio**. Dopo aver abilitato un piano Railway:

```sh
railway init --name mealio --workspace "My Projects" --json
```

Collega il progetto al repository, porta il codice sul branch `main`, quindi rivedi il piano IaC prima di applicarlo:

```sh
railway config plan
railway config apply
```

`.railway/railway.ts` definisce un solo servizio `mealio`, una replica in `europe-west4` (EU West), un volume da 1 GB montato su `/data` e il bucket `mealio-backups` in `ams` (Amsterdam). Il database è `/data/mealio.sqlite`. Il limite di una replica evita scritture SQLite concorrenti su più istanze.

Imposta questi valori come variabili Railway sul servizio `mealio` in `production`; non inserirli nel repository:

- `SESSION_SECRET`: almeno 32 byte casuali.
- `ADMIN_PASSWORD_HASH`: output di `pnpm auth:hash`.
- `BACKUP_ENCRYPTION_KEY`: 32 byte casuali codificati in Base64. Conservalo fuori da Railway anche in un password manager: serve per decifrare i backup.
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION`: rispettivamente `endpoint`, `accessKeyId`, `secretAccessKey`, `bucketName`, `region` da `railway bucket credentials --bucket mealio-backups --json`.

Il bucket è creato in `ams`, ma Railway assegna un nome S3 effettivo distinto dal nome risorsa; anche la region S3 può differire dalla regione di creazione. Imposta i valori restituiti dalle credenziali. Le variabili sensibili restano `preserve()` nel file IaC.

La sessione dura 30 giorni; il cookie è `HttpOnly`, `SameSite=Lax` e `Secure` in produzione. Il login consente al massimo 5 tentativi per indirizzo IP ogni 15 minuti; l'indirizzo è memorizzato solo come HMAC con `SESSION_SECRET`. Il campo password è nascosto per impostazione predefinita e dispone del controllo Mostra/Nascondi.

## Backup ed export

Il processo di manutenzione, avviato insieme al servizio, carica:

- snapshot SQLite giornalieri alle 03:00 UTC;
- export JSON settimanali la domenica alle 03:15 UTC.

Gli oggetti sono compressi e cifrati con AES-256-GCM prima dell'upload. L'export JSON include le tabelle applicative ed esclude sessioni, limiti di login e stato delle schedulazioni. Il bucket è in EU West; non usare PDF o dati personali nel repository.

Avvio manuale con le variabili Railway disponibili in locale:

```sh
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm backup:run
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm export:run
```

## Ripristino da backup

Il ripristino sostituisce il database corrente. Eseguilo durante una finestra di manutenzione e conserva la chiave `BACKUP_ENCRYPTION_KEY` usata dal backup.

1. Scarica e verifica localmente lo snapshot cifrato; il comando controlla `PRAGMA integrity_check` prima di scrivere il file di destinazione:

   ```sh
   railway run --project <PROJECT_ID> --environment production --service mealio -- \
     pnpm backup:restore -- backups/<YYYY>/<MM>/<DD>/<object>.sqlite.gz.enc /tmp/mealio-restore.sqlite
   ```

2. Arresta il servizio, rimuovi eventuali sidecar SQLite obsoleti dal volume, carica il file ripristinato e riavvia una replica:

   ```sh
   railway scale --project <PROJECT_ID> --environment production --service mealio europe-west4=0 --json
   railway volume files list / --project <PROJECT_ID> --environment production --service mealio --json
   # Se presenti, elimina /mealio.sqlite-wal e /mealio.sqlite-shm.
   railway volume files delete /mealio.sqlite-wal \
     --project <PROJECT_ID> --environment production --service mealio --yes --json
   railway volume files delete /mealio.sqlite-shm \
     --project <PROJECT_ID> --environment production --service mealio --yes --json
   railway volume files upload /tmp/mealio-restore.sqlite /mealio.sqlite \
     --project <PROJECT_ID> --environment production --service mealio --overwrite --json
   railway scale --project <PROJECT_ID> --environment production --service mealio europe-west4=1 --json
   ```

   Gli eventuali sidecar vanno rimossi solo mentre il servizio è fermo: il backup ripristinato sostituisce integralmente lo stato precedente.

3. Verifica `GET /api/health`, poi accedi. Lo start command applica automaticamente le migration mancanti.

`pnpm backup:restore` accetta solo oggetti sotto il prefisso `backups/`; non sovrascrive il volume da solo. Prima del ripristino Railway, conserva una copia del file scaricato localmente.

## Spesa Railway

Imposta un hard limit sul target **workspace** `My Projects`; il target **agent** non limita i costi compute del servizio. Un hard limit può sospendere il servizio al raggiungimento della soglia. Prima di impostarlo, controlla lo stato attuale:

```sh
railway usage limit status --workspace "My Projects" --target workspace --json
railway usage limit set --workspace "My Projects" --target workspace --hard <USD> --json
railway usage limit status --workspace "My Projects" --target workspace --json
```
