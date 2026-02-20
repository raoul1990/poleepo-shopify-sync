# Poleepo-Shopify Tag Sync Agent

## Guida al funzionamento, configurazione e utilizzo

---

## 1. Panoramica

**Poleepo-Shopify Tag Sync** è un servizio Node.js standalone che sincronizza bidirezionalmente i tag dei prodotti tra la piattaforma Poleepo e lo store Shopify.

Il servizio gira in background come processo persistente (systemd), eseguendo un ciclo di sincronizzazione ogni 6 ore (configurabile). Invia report su Slack al termine di ogni sync e logga la propria attività su console.

### Caratteristiche principali

- **Sync bidirezionale**: i tag vengono uniti (merge) da entrambe le piattaforme. Non vengono mai rimossi tag esistenti.
- **Sync incrementale**: dopo la prima esecuzione completa, vengono sincronizzati solo i prodotti effettivamente modificati.
- **Auto-refresh token**: i token di autenticazione per Poleepo (~1h) e Shopify (~24h) vengono rinnovati automaticamente prima della scadenza.
- **Dual auth Shopify**: supporta sia token statico (`SHOPIFY_ACCESS_TOKEN`) che flusso OAuth `client_credentials` con refresh automatico.
- **Rate limiting**: rispetta il limite Shopify di 2 richieste/secondo con bucket di 40.
- **Retry automatico**: le chiamate API fallite vengono ritentate fino a 3 volte con backoff esponenziale.
- **Graceful shutdown**: il servizio termina in modo pulito attendendo la fine del ciclo di sync corrente.
- **Prodotti eliminati**: i prodotti cancellati da Shopify (404) vengono saltati e rimossi dallo stato senza generare errori.
- **Notifiche Slack**: report con Block Kit dopo ogni sync, con sanitizzazione HTML e protezione limite 3000 caratteri per blocco.

---

## 2. Architettura

```
poleepo-shopify-sync/
├── src/
│   ├── index.ts                 # Entry point, cron scheduler, lock, shutdown
│   ├── config.ts                # Caricamento configurazione da .env
│   ├── clients/
│   │   ├── poleepo.ts           # Client API Poleepo (auth + CRUD prodotti)
│   │   └── shopify.ts           # Client API Shopify (auth + CRUD prodotti)
│   ├── sync/
│   │   ├── tag-sync-engine.ts   # Motore di sincronizzazione (full + incrementale)
│   │   ├── product-matcher.ts   # Mapping prodotti via pubblicazioni Poleepo
│   │   ├── tag-normalizer.ts    # Parsing, normalizzazione, hash e merge tag
│   │   └── state-manager.ts     # Gestione file di stato (sync-state.json)
│   └── utils/
│       ├── logger.ts            # Logger con timestamp ISO
│       ├── rate-limiter.ts      # Token bucket per rispettare i limiti Shopify
│       ├── retry.ts             # Retry con exponential backoff
│       └── slack.ts             # Notifiche Slack (webhook + file upload)
├── data/
│   └── sync-state.json          # Stato di sync (generato a runtime)
├── dist/                        # Output compilato (generato da tsc)
├── .env                         # Variabili d'ambiente (credenziali)
├── package.json
└── tsconfig.json
```

### Flusso dei dati

```
┌──────────┐                              ┌──────────┐
│  Poleepo │  ◄── tag-sync-engine.ts ──►  │  Shopify  │
│   API    │      (merge bidirezionale)    │   API    │
└────┬─────┘                              └────┬─────┘
     │                                         │
     │     ┌──────────────────────┐            │
     └────►│  product-matcher.ts  │◄───────────┘
           │  (mappa Poleepo ID   │
           │   ↔ Shopify ID via   │
           │   pubblicazioni)     │
           └──────────┬───────────┘
                      │
              ┌───────▼────────┐
              │ state-manager  │
              │ sync-state.json│
              └────────────────┘
```

---

## 3. Come funziona il sync

### 3.1 Prima esecuzione (full sync)

Quando non esiste il file `data/sync-state.json`, il servizio esegue una sincronizzazione completa:

1. **Autenticazione** su entrambe le piattaforme (Poleepo e Shopify)
2. **Scaricamento mappature**: chiama `GET /channels/publications?source=SHOPIFY` su Poleepo per ottenere la mappa completa Poleepo Product ID ↔ Shopify Product ID
3. **Scaricamento prodotti Poleepo**: paginato, recupera tutti i prodotti attivi con i relativi tag
4. **Scaricamento prodotti Shopify**: paginato, recupera tutti i prodotti con i relativi tag
5. **Per ogni coppia mappata**: confronta i tag, li unisce (merge), e aggiorna la piattaforma che ha tag mancanti
6. **Salvataggio stato**: scrive `sync-state.json` con gli hash dei tag per ogni prodotto

### 3.2 Esecuzioni successive (sync incrementale)

Quando il file di stato esiste, il servizio ottimizza sincronizzando solo i prodotti modificati:

1. **Caricamento stato** dal file `sync-state.json`
2. **Controllo nuove pubblicazioni**: verifica se ci sono nuovi prodotti mappati tra le piattaforme
3. **Prodotti Shopify modificati**: chiama `GET /products.json?updated_at_min={lastSyncTime}` per ottenere solo i prodotti aggiornati dall'ultima sync
4. **Prodotti Poleepo modificati**: scarica tutti i prodotti ma confronta l'hash MD5 dei tag con quello salvato nello stato — sincronizza solo quelli con hash diverso
5. **Sync selettivo**: aggiorna solo i prodotti che hanno effettivamente tag cambiati
6. **Aggiornamento stato**: salva il nuovo `sync-state.json`

### 3.3 Logica di merge

I tag vengono sempre **uniti**, mai rimossi:

- Se Poleepo ha `["A", "B"]` e Shopify ha `["B", "C"]`, il risultato è `["A", "B", "C"]` su entrambe le piattaforme
- La deduplicazione è case-insensitive di default (configurabile)
- L'hash MD5 viene calcolato sui tag normalizzati (lowercase, ordinati, separati da `|`)

### 3.4 Conversione formati

| Sorgente | Formato | Esempio |
|----------|---------|---------|
| Poleepo | Array di oggetti `{ id, value }` | `[{ "id": 123, "value": "Autunno-Inverno" }]` |
| Shopify | Stringa comma-separated | `"Autunno-Inverno, tinta_unita"` |
| Interno | Array di stringhe | `["Autunno-Inverno", "tinta_unita"]` |

---

## 4. Autenticazione

### 4.1 Poleepo

- **Endpoint**: `POST https://api.poleepo.cloud/auth/token`
- **Formato**: JSON (`{ api_key, api_secret }`)
- **Scadenza token**: ~1 ora (`expires_in: 3600`)
- **Header di utilizzo**: `Authorization: Bearer {token}`

### 4.2 Shopify

Il client supporta due modalità di autenticazione (mutualmente esclusive):

**Opzione A — Token statico** (per app Custom con Admin API access token):
- Impostare `SHOPIFY_ACCESS_TOKEN` nel `.env`
- Il token viene usato direttamente senza scadenza
- Se ritorna 401, tenta fallback su `client_credentials`

**Opzione B — Client Credentials** (per app con OAuth, consigliata):
- **Endpoint**: `POST https://{store}/admin/oauth/access_token`
- **Formato**: `application/x-www-form-urlencoded` (NON JSON)
- **Parametri**: `grant_type=client_credentials`, `client_id`, `client_secret`
- **Scadenza token**: ~24 ore (`expires_in: 86399`)
- **Header di utilizzo**: `X-Shopify-Access-Token: {token}`

### 4.3 Gestione automatica

Per entrambe le piattaforme:
- Il token viene salvato in memoria con il timestamp di scadenza
- Prima di ogni chiamata API viene verificata la validità del token
- Se il token scade entro 5 minuti, viene rinnovato proattivamente
- Se una chiamata ritorna HTTP 401, il token corrente viene invalidato, si riautentica e si ritenta la chiamata
- I messaggi di errore HTML (es. pagine Shopify) vengono sanitizzati prima del logging

---

## 5. Configurazione

### 5.1 File `.env`

Creare un file `.env` nella root del progetto con le seguenti variabili:

```env
# ── Poleepo ──────────────────────────────────────────
POLEEPO_API_KEY=poleepo_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
POLEEPO_API_SECRET=plpscrt_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
POLEEPO_BASE_URL=https://api.poleepo.cloud

# ── Shopify ──────────────────────────────────────────
SHOPIFY_STORE=tuonegozio.myshopify.com
# Opzione A: token statico (se fornito, usato direttamente)
SHOPIFY_ACCESS_TOKEN=
# Opzione B: client credentials OAuth (consigliata — token con refresh automatico)
SHOPIFY_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
SHOPIFY_CLIENT_SECRET=shpss_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
SHOPIFY_API_VERSION=2025-07

# ── Sync ─────────────────────────────────────────────
SYNC_CRON=0 */6 * * *
SYNC_BATCH_SIZE=50
TAG_CASE_SENSITIVE=false
LOG_LEVEL=info
STATE_FILE_PATH=./data/sync-state.json

# ── Slack (opzionale) ────────────────────────────────
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
```

### 5.2 Dettaglio parametri

| Variabile | Obbligatoria | Default | Descrizione |
|-----------|:---:|---------|-------------|
| `POLEEPO_API_KEY` | Sì | — | API key Poleepo |
| `POLEEPO_API_SECRET` | Sì | — | API secret Poleepo |
| `POLEEPO_BASE_URL` | No | `https://api.poleepo.cloud` | URL base API Poleepo |
| `SHOPIFY_STORE` | Sì | — | Dominio dello store Shopify (es. `nome.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | No | — | Token statico (alternativo a client_credentials) |
| `SHOPIFY_CLIENT_ID` | No* | — | Client ID dell'app Shopify |
| `SHOPIFY_CLIENT_SECRET` | No* | — | Client Secret dell'app Shopify |
| `SHOPIFY_API_VERSION` | No | `2025-07` | Versione API Shopify |
| `SYNC_CRON` | No | `0 */6 * * *` | Espressione cron per la frequenza di sync |
| `SYNC_BATCH_SIZE` | No | `50` | Numero di prodotti per pagina nelle chiamate API Poleepo |
| `TAG_CASE_SENSITIVE` | No | `false` | Se `true`, i tag "Uomo" e "uomo" vengono trattati come distinti |
| `LOG_LEVEL` | No | `info` | Livello di log: `debug`, `info`, `warn`, `error` |
| `STATE_FILE_PATH` | No | `./data/sync-state.json` | Percorso del file di stato |
| `SLACK_WEBHOOK_URL` | No | — | URL webhook Slack per invio report |
| `SLACK_BOT_TOKEN` | No | — | Bot token Slack per upload file |
| `SLACK_CHANNEL_ID` | No | — | Channel ID Slack per upload file |

> *\* Almeno una modalità auth Shopify è necessaria: `SHOPIFY_ACCESS_TOKEN` oppure `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`*

### 5.3 Espressioni cron comuni

| Espressione | Significato |
|-------------|-------------|
| `0 */6 * * *` | Ogni 6 ore (default) |
| `*/15 * * * *` | Ogni 15 minuti |
| `0 * * * *` | Ogni ora (al minuto 0) |
| `0 */2 * * *` | Ogni 2 ore |
| `0 8-20 * * 1-5` | Ogni ora dalle 8 alle 20, lun-ven |

---

## 6. Installazione e avvio

### 6.1 Prerequisiti

- **Node.js** versione 18 o superiore
- **npm** (incluso con Node.js)

### 6.2 Installazione

```bash
cd poleepo-shopify-sync
npm install
npm run build
```

### 6.3 Avvio

```bash
# Avvio diretto
npm start

# Oppure con node direttamente
node dist/index.js
```

All'avvio il servizio:
1. Logga `"Poleepo-Shopify Tag Sync Agent started"`
2. Esegue immediatamente la prima sincronizzazione
3. Attiva il cron scheduler per le esecuzioni successive
4. Resta in attesa del prossimo ciclo

### 6.4 Avvio come servizio (systemd)

Per eseguire il servizio in modo persistente su un server Linux, creare un file unit systemd:

```ini
# /etc/systemd/system/poleepo-shopify-sync.service
[Unit]
Description=Poleepo-Shopify Tag Sync
After=network.target

[Service]
Type=simple
WorkingDirectory=/percorso/poleepo-shopify-sync
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=30
EnvironmentFile=/percorso/poleepo-shopify-sync/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable poleepo-shopify-sync
sudo systemctl start poleepo-shopify-sync

# Controllare i log
journalctl -u poleepo-shopify-sync -f
```

### 6.5 Avvio con Docker (opzionale)

Se si preferisce Docker, creare un `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
COPY .env ./
CMD ["node", "dist/index.js"]
```

```bash
docker build -t poleepo-shopify-sync .
docker run -d --name poleepo-sync --restart unless-stopped poleepo-shopify-sync
```

---

## 7. Log e monitoraggio

### 7.1 Formato log

Ogni riga di log segue il formato:

```
[2026-02-16T10:15:00.123Z] [INFO] Messaggio
```

### 7.2 Log di riepilogo

Al termine di ogni ciclo di sync viene prodotto un riepilogo:

```
[2026-02-16T10:15:03.456Z] [INFO] Sync OK: 342 analizzati, 12 modificati (8 →Shopify, 4 →Poleepo), 0 errori, durata 3.2s
```

| Campo | Significato |
|-------|-------------|
| `analizzati` | Numero di coppie prodotto esaminate |
| `modificati` | Numero di prodotti aggiornati (su almeno una piattaforma) |
| `→Shopify` | Prodotti aggiornati su Shopify |
| `→Poleepo` | Prodotti aggiornati su Poleepo |
| `errori` | Errori durante la sync (il prodotto viene saltato) |
| `durata` | Tempo totale del ciclo di sync |

### 7.3 Livelli di log

- **debug**: dettaglio di ogni chiamata API, paginazione, hash
- **info**: avvio, autenticazione, riepilogo sync, eventi significativi
- **warn**: token scaduti, retry, ciclo cron saltato per lock
- **error**: errori API, fallimenti di sync

Per il troubleshooting, impostare `LOG_LEVEL=debug` nel file `.env`.

---

## 8. File di stato (`sync-state.json`)

Il file viene creato automaticamente nella cartella `data/` e contiene:

```json
{
  "lastSyncTime": "2026-02-16T10:15:00.000Z",
  "products": {
    "poleepo_12345": {
      "shopifyId": "7890123456",
      "poleepoTagHash": "a1b2c3d4e5f6...",
      "shopifyTagHash": "a1b2c3d4e5f6...",
      "lastSynced": "2026-02-16T10:15:00.000Z"
    }
  },
  "publicationsMap": {
    "12345": "7890123456"
  }
}
```

### Operazioni sul file di stato

| Azione | Risultato |
|--------|-----------|
| **Eliminare** il file | Il prossimo ciclo eseguirà un full sync |
| **Non toccare** | Il servizio usa il sync incrementale (più veloce) |
| **Backup** | Consigliato prima di aggiornamenti o manutenzione |

---

## 9. Protezioni e sicurezza

| Meccanismo | Descrizione |
|------------|-------------|
| **Lock anti-concorrenza** | Un flag `isSyncing` impedisce che due cicli cron si sovrappongano |
| **Graceful shutdown** | Su SIGTERM/SIGINT il servizio attende la fine del sync corrente prima di uscire (timeout 60s) |
| **Retry con backoff** | Le chiamate API fallite vengono ritentate fino a 3 volte con attesa esponenziale (1s, 2s, 4s) |
| **Rate limiting Shopify** | Token bucket che rispetta il limite di 2 richieste/secondo |
| **Token auto-refresh** | Rinnovo proattivo 5 minuti prima della scadenza + retry su 401 |
| **Merge non distruttivo** | I tag vengono solo aggiunti, mai rimossi — nessun rischio di perdita dati |

---

## 10. Troubleshooting

| Problema | Soluzione |
|----------|----------|
| `Missing required environment variable` | Verificare che il file `.env` esista e contenga tutte le variabili obbligatorie |
| `Poleepo auth failed (401)` | Verificare `POLEEPO_API_KEY` e `POLEEPO_API_SECRET` |
| `Shopify auth failed (400) app_not_installed` | L'app Shopify non è installata sullo store. Verificare le credenziali (`CLIENT_ID`/`CLIENT_SECRET`) |
| `Shopify auth failed (401)` | Verificare `SHOPIFY_CLIENT_ID` e `SHOPIFY_CLIENT_SECRET` oppure `SHOPIFY_ACCESS_TOKEN` |
| `No product mappings found` | Verificare che i prodotti siano pubblicati su Shopify tramite Poleepo |
| `Slack invalid_blocks (400)` | I messaggi di errore contenevano HTML > 3000 caratteri. Risolto con sanitizzazione automatica |
| `Sync already in progress, skipping` | Normale se il ciclo precedente è ancora in corso. Se persiste, controllare la connettività |
| Il servizio non si avvia | Verificare che Node.js >= 18 sia installato (`node --version`) |
| Tag non sincronizzati | Impostare `LOG_LEVEL=debug` e verificare che il prodotto abbia una pubblicazione SHOPIFY su Poleepo |

---

## 11. Notifiche Slack

Il servizio può inviare report su Slack dopo ogni sincronizzazione.

### 11.1 Configurazione

- **`SLACK_WEBHOOK_URL`**: URL del webhook Slack (Incoming Webhook) — per inviare il report con Block Kit
- **`SLACK_BOT_TOKEN`** + **`SLACK_CHANNEL_ID`**: per upload file CSV (opzionale)

### 11.2 Contenuto del report

Il report Slack include:
- Stato (completato / con errori)
- Tipo sync (full / incrementale) e durata
- Riepilogo: prodotti mappati, analizzati, modificati, errori
- Dettaglio prodotti modificati (max 15) con tag aggiunti e direzione
- Dettaglio errori (max 10) con HTML sanitizzato

### 11.3 Protezioni

- I messaggi HTML nelle risposte di errore vengono ripuliti (tag HTML rimossi, spazi collassati)
- Ogni errore è troncato a 200 caratteri
- Ogni blocco Slack è limitato a 3000 caratteri (limite Block Kit)

---

## 12. Limitazioni note

- Il servizio sincronizza solo i **tag** dei prodotti, non altri campi
- I tag vengono **uniti** (merge): se si vuole rimuovere un tag, va fatto manualmente su entrambe le piattaforme
- La mappatura prodotti dipende dalle **pubblicazioni Poleepo**: un prodotto Poleepo senza pubblicazione SHOPIFY non viene sincronizzato
- L'API Poleepo non supporta un filtro `updated_since`, quindi tutti i prodotti vengono scaricati ad ogni ciclo (il confronto hash evita aggiornamenti non necessari)
- I prodotti eliminati da Shopify vengono rilevati durante il sync incrementale (errore 404) e rimossi dallo stato automaticamente

---

*Documento aggiornato il 20 febbraio 2026*
*Progetto: poleepo-shopify-sync v1.1.0*
