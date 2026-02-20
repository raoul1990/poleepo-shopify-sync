# Poleepo-Shopify Tag Sync

Servizio Node.js standalone per la sincronizzazione bidirezionale dei tag prodotto tra Poleepo e Shopify.

## Struttura Progetto

```
poleepo-shopify-sync/
├── src/
│   ├── index.ts                 # Entry point, cron scheduler, lock, shutdown
│   ├── config.ts                # Caricamento configurazione da .env
│   ├── clients/
│   │   ├── poleepo.ts           # Client API Poleepo (OAuth2 + CRUD prodotti)
│   │   └── shopify.ts           # Client API Shopify (dual auth + CRUD prodotti)
│   ├── sync/
│   │   ├── tag-sync-engine.ts   # Motore di sincronizzazione (full + incrementale)
│   │   ├── product-matcher.ts   # Mapping prodotti via pubblicazioni Poleepo→Shopify
│   │   ├── tag-normalizer.ts    # Parsing, normalizzazione, hash MD5 e merge tag
│   │   └── state-manager.ts     # Gestione file di stato (sync-state.json)
│   └── utils/
│       ├── logger.ts            # Logger con timestamp ISO
│       ├── rate-limiter.ts      # Token bucket (2 req/s, bucket 40)
│       ├── retry.ts             # Retry con exponential backoff (3 tentativi)
│       └── slack.ts             # Notifiche Slack (webhook report + file upload)
├── data/
│   └── sync-state.json          # Stato di sync (generato a runtime)
├── docs/
│   └── guida-poleepo-shopify-sync.md  # Guida completa
├── dist/                        # Output compilato (tsc)
├── .env                         # Variabili d'ambiente (NON COMMITTARE)
├── package.json
└── tsconfig.json
```

## Architettura

### Autenticazione Shopify (`src/clients/shopify.ts`)

Supporta due modalità (mutualmente esclusive):
- **Token statico**: `SHOPIFY_ACCESS_TOKEN` — usato direttamente, `expiresAt: Infinity`
- **Client Credentials**: `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` — OAuth flow con `grant_type=client_credentials`, token ~24h, refresh automatico 5min prima della scadenza
- Su 401: invalida il token corrente, riautentica con `client_credentials`, ritenta la chiamata
- Errori HTML sanitizzati (tag rimossi, troncati a 300 char)

### Autenticazione Poleepo (`src/clients/poleepo.ts`)

- **Endpoint**: `POST /auth/token` con `{ api_key, api_secret }`
- Token ~1h, refresh automatico prima della scadenza

### Tag Sync Engine (`src/sync/tag-sync-engine.ts`)

- **Full sync**: prima esecuzione — scarica tutti i prodotti da entrambe le piattaforme, merge tag, salva stato
- **Incremental sync**: esecuzioni successive — sincronizza solo prodotti modificati (Shopify `updated_at_min` + Poleepo hash comparison)
- **Merge non distruttivo**: i tag vengono solo aggiunti (unione), mai rimossi
- **Prodotti eliminati**: 404 da Shopify → skip silenzioso + cleanup stato (non contato come errore)
- **Deduplicazione**: case-insensitive di default, hash MD5 su tag normalizzati

### Notifiche Slack (`src/utils/slack.ts`)

- Report Block Kit dopo ogni sync (stato, riepilogo, dettaglio prodotti, errori)
- Protezione limite 3000 char per blocco Slack
- Errori sanitizzati: HTML rimosso, troncati a 200 char per errore
- Upload file via `files.getUploadURLExternal` + `files.completeUploadExternal`

## Variabili d'Ambiente

| Variabile | Obbligatoria | Default | Note |
|-----------|:---:|---------|------|
| `POLEEPO_API_KEY` | Sì | — | |
| `POLEEPO_API_SECRET` | Sì | — | |
| `SHOPIFY_STORE` | Sì | — | es. `nome.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | No* | — | Token statico |
| `SHOPIFY_CLIENT_ID` | No* | — | Per client_credentials |
| `SHOPIFY_CLIENT_SECRET` | No* | — | Per client_credentials |
| `SYNC_CRON` | No | `0 */6 * * *` | Ogni 6 ore |
| `SLACK_WEBHOOK_URL` | No | — | Per report Slack |
| `SLACK_BOT_TOKEN` | No | — | Per upload file |
| `SLACK_CHANNEL_ID` | No | — | Per upload file |

> *Almeno una modalità auth Shopify necessaria: `ACCESS_TOKEN` oppure `CLIENT_ID` + `CLIENT_SECRET`*

## Comandi

```bash
npm install          # Installa dipendenze
npm run build        # Compila TypeScript
npm start            # Avvia (node dist/index.js)
```

## Deploy (systemd)

```bash
# Il service file è in /etc/systemd/system/poleepo-shopify-sync.service
systemctl enable --now poleepo-shopify-sync
journalctl -u poleepo-shopify-sync -f
```

## Note Sviluppo

- Node.js 18+ (usa `fetch` nativo)
- TypeScript strict mode, target ES2020
- Rate limiting Shopify: token bucket 2 req/s, bucket size 40
- Lock anti-concorrenza: `isSyncing` flag impedisce overlap cron
- Graceful shutdown: attende fine sync su SIGTERM/SIGINT (timeout 60s)
