# Linky Scout — Workflow di sviluppo v3
*Aggiornato: maggio 2026 — stack, crediti, piani, pipeline ICP*

---

## Decisioni tecniche di base

| Componente | Scelta |
|---|---|
| Frontend | Next.js **16** (App Router) + TypeScript + **Tailwind 4** + shadcn/ui v4 (**radix-nova**, base **neutral**) |
| React | **19** |
| Font | Sora (titoli, `--font-heading`) + DM Sans (body, `--font-sans`) via `next/font/google` |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase Postgres (stesso progetto di Linky Assistant) |
| Auth | OTP Linky Assistant (`request-otp` + `verify-otp`) + magic link `/auth?token=...` |
| Piani | `user_subscriptions` — `assistant` \| `scout` \| `bundle` |
| Access control | `_shared/access.ts` (`resolveAccess`, `canUseScout`) |
| Crediti | `user_credits` + RPC `deduct_search_credits` — **100 crediti per ricerca** |
| Lead data | LinkdAPI (header: `x-linkdapi-apikey`) |
| AI | Claude Sonnet (`claude-sonnet-4-6`) — parse ICP + scoring |
| Hosting | Vercel (frontend) + Supabase (backend) |
| Job queue | `search_jobs` + `next_stage` + `process-search-job` (uno stage per invocazione) + `process-pending-jobs` (cron) |
| Caching | `search_cache`, TTL 7 giorni, hash SHA-256 su ICP normalizzato |

---

## FASE 0 — Setup ambiente Windows 11

**0.1** — Installa Node.js LTS (v20+) da nodejs.org

**0.2** — Installa pnpm:
```powershell
npm install -g pnpm
```

**0.3** — Crea cartella progetto separata da Linky Assistant

**0.4** — Apri la cartella in Cursor

**0.5** — Crea progetto Next.js:
```powershell
pnpm create next-app@latest . --typescript --tailwind --app --src-dir --import-alias "@/*"
```

**0.6** — Se pnpm chiede di approvare build scripts → premi `a` → Invio

**0.7** — Avvia dev server:
```powershell
pnpm dev
```

**0.8** — Init shadcn/ui:
```powershell
pnpm dlx shadcn@latest init
```
Scegli: **Radix → Nova → Neutral → Yes CSS variables** (come in `components.json`)

**0.9** — Componenti shadcn:
```powershell
pnpm dlx shadcn@latest add button input textarea card table badge progress dialog sheet separator avatar dropdown-menu sonner
```

**0.10** — Dipendenze:
```powershell
pnpm add @supabase/supabase-js @supabase/ssr next-themes
```
(`@anthropic-ai/sdk` non serve nel frontend — Claude è solo nelle Edge Functions)

**0.11** — `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
NEXT_PUBLIC_EDGE_FUNCTIONS_BASE_URL=https://xxx.supabase.co/functions/v1
```

**0.12** — `tsconfig.json` — escludi le Edge Functions:
```json
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "exclude": ["node_modules", "supabase/functions/**"]
}
```

**0.13** — `supabase/functions/deno.json` (per ogni function o condiviso):
```json
{
  "imports": { "@supabase/functions-js": "jsr:@supabase/functions-js@^2" },
  "compilerOptions": { "allowImportingTsExtensions": true }
}
```

**0.14** — `src/middleware.ts`: pass-through (il JWT è in `localStorage`, non leggibile server-side). La protezione route è client-side: `AuthContext` + `(protected)/layout.tsx`.

**0.15** — Push GitHub + deploy Vercel

---

## FASE 1 — Database (Supabase condiviso con Linky)

### Tabelle Scout

**1.1** — `searches`:
```sql
CREATE TABLE searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  icp_prompt TEXT NOT NULL,
  parsed_filters JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**1.2** — `search_jobs` (nota colonna **`next_stage`** per l'orchestratore):
```sql
CREATE TABLE search_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INT DEFAULT 0,
  current_stage TEXT,
  next_stage TEXT,
  parsed_filters JSONB,
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**1.3** — `search_results`:
```sql
CREATE TABLE search_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id),
  linkedin_urn TEXT NOT NULL,
  linkedin_url TEXT NOT NULL,
  full_name TEXT,
  headline TEXT,
  location TEXT,
  follower_count INT,
  bio TEXT,
  recent_posts JSONB,
  match_score INT,
  match_reason TEXT,
  best_context TEXT,
  saved_to_crm BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**1.4** — `search_cache`:
```sql
CREATE TABLE search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  icp_hash TEXT UNIQUE NOT NULL,
  results JSONB NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cache_hash ON search_cache(icp_hash);
CREATE INDEX idx_cache_expires ON search_cache(expires_at);
```

**1.5** — `profili_salvati` (CRM Linky Assistant):
```sql
ALTER TABLE profili_salvati ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'extension';
```

**1.6** — RLS su `searches`, `search_jobs`, `search_results`. **NON** su `search_cache`.

**1.7** — RLS policies (`user_id` TEXT = email dal JWT custom):
```sql
DROP POLICY IF EXISTS "Users see own searches" ON searches;
DROP POLICY IF EXISTS "Users see own jobs" ON search_jobs;
DROP POLICY IF EXISTS "Users see results of own searches" ON search_results;

CREATE POLICY "Users see own searches" ON searches
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see own jobs" ON search_jobs
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see results of own searches" ON search_results
  FOR ALL USING (
    search_id IN (SELECT id FROM searches WHERE user_id = current_setting('request.jwt.claims', true)::json->>'email')
  );
```

> Le policy RLS con JWT custom **non funzionano** con il client browser anon su `searches` / `search_results`. Le query utente passano da Edge Functions con `SERVICE_ROLE_KEY` + verifica JWT manuale. Eccezione: `profili_salvati` su `/leads` usa ancora il client anon filtrato per `user_email`.

### FASE 1b — Abbonamenti e crediti (DB Linky Assistant)

Schema gestito insieme a Linky Assistant (non in `supabase/migrations` di questo repo):

| Tabella / RPC | Uso in Scout |
|---|---|
| `user_subscriptions` | `email`, `plan`, `status`, `current_period_end` → accesso Scout |
| `user_credits` | `subscription_credits`, `pack_credits`, `credits_period_end`, … |
| `deduct_search_credits(p_email, p_amount, p_search_id)` | Addebito atomico in `start-search` |

- Costo ricerca: **`SEARCH_COST = 100`** (anche su **cache hit** — la cache non è gratuita per l'utente).
- Pack acquistabili: definiti in `src/lib/credits.ts` (Trial 100, Growth 500, Scale 1000 crediti).
- Checkout Stripe: `POST https://www.linkyassistant.com/api/create-checkout` con `{ priceId, email }`.

---

## Pipeline ICP — Ricerca lead (cuore del prodotto)

> Branch attivo per miglioramenti: **`Miglioramento_Ricerca`**.  
> Questa sezione descrive il comportamento **attuale** del codice — utile come baseline prima di ottimizzare parse, filtri o scoring.

### Panoramica end-to-end

```mermaid
sequenceDiagram
  participant U as Utente (/)
  participant SS as start-search
  participant DB as Postgres
  participant PP as process-pending-jobs
  participant PS as process-search-job
  participant PI as parse-icp
  participant S1 as stage1-search
  participant S2 as stage2-enrich
  participant SC as score-profiles
  participant L as LinkdAPI

  U->>SS: POST { icpPrompt } + JWT
  SS->>SS: resolveAccess(scout) + deduct 100 crediti
  SS->>DB: INSERT searches
  alt Cache hit (stesso ICP normalizzato)
    SS->>DB: INSERT search_results da cache
    SS-->>U: { cached: true, results, searchId }
  else Cache miss
    SS->>DB: INSERT search_jobs (pending, queued)
    SS-->>U: { cached: false, jobId, searchId }
    U->>U: poll get-job-status ogni 3s
    PP->>PS: stage start (cron o trigger)
    PS->>PI: prompt ICP → filtri JSON
    PS->>DB: parsed_filters, next_stage=search
    PP->>PS: stage search
    PS->>S1: searchId + filters
    S1->>L: search/people + profile/overview
    S1->>DB: INSERT search_results (score null)
    PP->>PS: stage enrich
    PS->>S2: searchId
    S2->>L: profile/details + posts/all
    S2->>DB: UPDATE bio, recent_posts
    PP->>PS: stage score
    PS->>SC: searchId + icpPrompt (testo originale)
    SC->>SC: Claude valuta bio + post
    SC->>DB: UPDATE match_score, match_reason, best_context
    PP->>PS: stage finalize
    PS->>DB: search_cache upsert + job completed
    U->>U: risultati ordinati per match_score
  end
```

### Cosa fa l'utente (frontend)

1. Scrive un **prompt ICP in linguaggio naturale** su `/` (textarea + chip di esempio).
2. Submit → `start-search` con `{ icpPrompt }` e `Authorization: Bearer <JWT>`.
3. Se `cached: true` → risultati immediati (dopo addebito crediti).
4. Se `cached: false` → progress bar con label da `stageLabel()` (`src/lib/format.ts`), polling `get-job-status` ogni **3 secondi** con `{ jobId }`.
5. Stime UX: toast *"2–4 minutes"*; durata reale dipende da LinkdAPI rate limit (batch da 25 + pausa 61s tra batch in stage1/2).

URL utili:
- `/?searchId=<uuid>` — ricarica risultati da history ("View Results")
- `/?prompt=<testo>` — pre-compila textarea ("Re-run")

### Fase A — `start-search` (ingresso)

File: `supabase/functions/start-search/index.ts`

| Step | Azione |
|---|---|
| 1 | Verifica JWT custom (`AUTH_JWT_SECRET`) |
| 2 | `resolveAccess(email, …, "scout")` + `canUseScout()` — altrimenti 401 |
| 3 | Valida `icpPrompt` non vuoto |
| 4 | `INSERT searches` (`user_id` = email dal JWT, **non** dal body) |
| 5 | `deduct_search_credits(email, 100, searchId)` — se fallisce, **DELETE** la riga `searches` |
| 6 | Insufficiente → **402** `{ error: "insufficient_credits", balance, required: 100 }` |
| 7 | `getCachedResults(supabase, icpPrompt)` — hash su ICP normalizzato (lowercase, punteggiatura rimossa, parole ordinate) |
| 8a Cache hit | Copia righe in `search_results`, risposta `{ cached: true, results, searchId }` |
| 8b Cache miss | `INSERT search_jobs` (`status: pending`, `current_stage: queued`), risposta `{ cached: false, jobId, searchId }` |

> Il frontend invia ancora `userEmail` nel body ma il backend **ignora** il campo — usa solo il JWT.

### Fase B — Orchestrazione job (NON è più una catena fire-and-forget)

**Architettura attuale** (diversa dalla v2 originale):

- Ogni invocazione di `process-search-job` esegue **un solo stage** e termina.
- Imposta `next_stage` sul job per lo stage successivo.
- Chiama `process-pending-jobs` in background (`EdgeRuntime.waitUntil`) per far partire il prossimo stage.
- `process-pending-jobs` (cron **ogni minuto** + trigger post-stage):
  - Lancia job `pending` con stage `"start"` (max 3).
  - Per job `running` con `next_stage` valorizzato: **lock ottimistico** (`UPDATE next_stage = null WHERE id AND next_stage = ?`) poi lancia quel stage (max 5).
  - `launchJob` usa `AbortController` a **1500 ms** — non aspetta la fine dello stage (evita timeout del cron).

File: `supabase/functions/process-search-job/index.ts`, `process-pending-jobs/index.ts`

| Stage | `current_stage` (UI) | Progress | Chiamate | Output su DB |
|---|---|---|---|---|
| `start` | `parsing` → `search` | 5 → 10 | `parse-icp` | `parsed_filters` sul job |
| `search` | `searching` | 15 → 40 | `stage1-search` | righe `search_results` |
| `enrich` | `enriching` | 50 → 70 | `stage2-enrich` | `bio`, `recent_posts` |
| `score` | `scoring` | 80 → 90 | `score-profiles` | `match_score`, `match_reason`, `best_context` |
| `finalize` | `completed` | 100 | `setCachedResults` | `search_cache` + job `completed` |

`icp_prompt` viene letto dalla join `searches` sul job — lo **stesso testo originale** va a `score-profiles`, non solo i filtri parsati.

### Fase C — `parse-icp` (testo → filtri LinkdAPI)

File: `supabase/functions/parse-icp/index.ts`

- Input: `{ prompt: string }` (ICP in linguaggio naturale).
- Modello: `claude-sonnet-4-6`, `max_tokens: 500`.
- Output JSON (solo raw JSON, no markdown):

| Campo | Tipo | Uso downstream |
|---|---|---|
| `keyword` | string | `searchProfiles` → param LinkdAPI `keyword` |
| `title` | string | `searchProfiles` + filtro headline in stage1 |
| `geoUrns` | string[] | `searchProfiles` → `geoUrn` (mapping paesi nel system prompt) |
| `language` | string | `searchProfiles` → `profileLanguage` |
| `maxFollowers` | number \| null | Filtro stage1 su `followerCount` |
| `behavioralCriteria` | string[] | **Parsato ma non usato in stage1** — influenza solo lo scoring via `icpPrompt` originale in stage score |

Mapping geo nel prompt Claude (es.): USA `103644278`, UK `101165590`, IT `103350119`, …

> **Punto di miglioramento (branch ICP):** `behavioralCriteria` e `industry` (supportato in `SearchFilters` / LinkdAPI ma non emesso da parse-icp) sono candidati per filtri più stretti in stage1 o prompt di scoring dedicati.

### Fase D — `stage1-search` (filtro grossolano LinkdAPI)

File: `supabase/functions/stage1-search/index.ts`

1. `getLeadProvider().searchProfiles({ …filters, count: 50 })` — **50 profili** dalla search API (non 100).
2. Per ogni profilo: estrae `username` da `url.split("/in/")[1]`, chiama `getProfileOverview(username)`.
3. Rate limit: batch **25** in parallelo, poi `sleep(61000)` ms tra batch.
4. Filtri applicati in codice:
   - `followerCount > maxFollowers` → scarta (se `maxFollowers` definito).
   - `headline` deve contenere `title` (case-insensitive), se `title` non vuoto.
5. `slice(0, 50)` candidati → `INSERT search_results` con `match_score = null`.

LinkdAPI (`_shared/lead-providers/linkdapi.ts`):
- `GET /api/v1/search/people` → `data.people`
- `GET /api/v1/profile/overview?username=...`
- Header: `x-linkdapi-apikey`

### Fase E — `stage2-enrich` (bio + post)

File: `supabase/functions/stage2-enrich/index.ts`

1. `SELECT` candidati con `bio IS NULL` per `search_id`.
2. Per ciascuno in parallelo (batch 25 + pausa 61s):
   - `getProfileDetails(urn)` → `bio` da `data.about`
   - `getRecentPosts(urn)` → `data.posts` (`.catch(() => [])` se fallisce)
3. `UPDATE search_results` — profili inaccessibili restano `bio = null` (non bloccano il batch).

### Fase F — `score-profiles` (match AI sul ICP completo)

File: `supabase/functions/score-profiles/index.ts`

- Input: `{ searchId, icpPrompt }` — **`icpPrompt` è il testo originale dell'utente**, non il JSON di parse-icp.
- Carica tutti i `search_results` del search; per Claude prepara:
  - headline, location, follower_count, bio
  - ultimi **3 post**, testo troncato a **300** caratteri
- Modello: `claude-sonnet-4-6`, **`max_tokens: 8000`**.
- System: analista B2B — score 0–100, `match_reason`, `best_context` (hook outreach).
- Parsing robusto: rimuove markdown; se JSON troncato, recupera ultimo oggetto completo nell'array.
- `UPDATE` per `index` → `match_score`, `match_reason`, `best_context`.
- Risultati finali ordinati per `match_score` DESC (in `get-job-status` e cache).

> Qui entrano in gioco segnali comportamentali ("bootstrapped", "does outreach alone") anche se stage1 non li filtra — Claude legge bio/post contro l'ICP intero.

### Fase G — Cache

File: `_shared/lead-providers/cache.ts`

- **Lettura** (`start-search`): stesso ICP normalizzato → hit se `expires_at > now`.
- **Scrittura** (`finalize`): upsert su `icp_hash` con TTL **7 giorni**.
- Anche i hit cached creano una riga in `searches` + risultati in `search_results` (visibili in history).

### Riepilogo: dove vive ogni informazione dell'ICP

| Informazione ICP | parse-icp | stage1 LinkdAPI | stage2 | score-profiles |
|---|---|---|---|---|
| Settore / keyword | `keyword` | ✅ search API | — | ✅ (testo ICP + bio/post) |
| Ruolo / title | `title` | ✅ API + filtro headline | — | ✅ |
| Paese | `geoUrns` | ✅ geoUrn | — | ✅ |
| Lingua profilo | `language` | ✅ profileLanguage | — | — |
| Max follower | `maxFollowers` | ✅ filtro numerico | — | ✅ |
| Segnali comportamentali | `behavioralCriteria` | ❌ non usato | — | ✅ via `icpPrompt` |
| Testo libero / contesto | (tutto il prompt) | — | — | ✅ |

---

## FASE 2 — Layer di astrazione LinkdAPI

Struttura: `supabase/functions/_shared/lead-providers/`

**`types.ts`** — `LeadDataProvider`, `SearchFilters`, `ProfileBasic`, ecc.

**`linkdapi.ts`** — implementazione:
- Auth: `x-linkdapi-apikey`
- `searchProfiles` → `GET /api/v1/search/people`
- `getProfileOverview` → `GET /api/v1/profile/overview?username=...`
- `getProfileDetails` → `GET /api/v1/profile/details?urn=...`
- `getRecentPosts` → `GET /api/v1/posts/all?urn=...`
- Unwrap: `response.json().data`

**`index.ts`** — factory `getLeadProvider()` da `LINKDAPI_KEY`

**`cache.ts`** — `normalizeICP`, `hashICP`, `getCachedResults`, `setCachedResults` (7 giorni)

---

## FASE 3 — Access control condiviso

File: `supabase/functions/_shared/access.ts`

| Piano | Prodotti |
|---|---|
| `assistant` | solo Assistant |
| `scout` | Scout |
| `bundle` | Assistant + Scout |

Flusso `resolveAccess(email, …, requiredProduct?)`:
1. `user_subscriptions` attiva → `premium` + `plan`
2. Altrimenti `utenti_waitlist` → `waitlist_trial` (7 giorni da `created_at`)
3. Altrimenti `unauthorized` / scaduto

`canUseScout(result)` → `true` se `waitlist_trial` **oppure** `premium` con piano che include `scout`.

Usato da: `start-search`, `get-searches`, `get-job-status`, `delete-search`.  
`get-credits` usa `resolveAccess` solo per esporre `plan` / `access`.

---

## FASE 4 — Edge Functions API (riepilogo)

| Function | Auth JWT | Access Scout | Note |
|---|---|---|---|
| `start-search` | ✅ | ✅ | Crediti + cache + crea job |
| `get-job-status` | ✅ | ✅ | Poll `{ jobId }` o load `{ searchId }` |
| `get-searches` | ✅ | ✅ | History |
| `delete-search` | ✅ | ✅ | Cascata results → jobs → searches |
| `get-credits` | ✅ | — | Saldo + piano |
| `parse-icp` | service (interno) | — | Solo da `process-search-job` |
| `stage1-search` | service | — | |
| `stage2-enrich` | service | — | |
| `score-profiles` | service | — | |
| `process-search-job` | service | — | Un stage per call |
| `process-pending-jobs` | service / cron | — | Dispatcher |
| `test-linkdapi` | — | — | Debug |

### `get-job-status` — due modalità

1. **Polling**: `{ jobId }` → stato job; se `completed`, include `results` ordinati per score.
2. **History view**: `{ searchId }` senza `jobId` → risultati + `icp_prompt` (verifica `user_id === email` JWT).

### Setup pg_cron

```sql
SELECT cron.schedule(
  'process-pending-jobs',
  '* * * * *',
  $$ SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/process-pending-jobs',
    headers := '{"Authorization": "Bearer YOUR_SERVICE_OR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ); $$
);
```

---

## FASE 5 — Frontend

### Auth

- `src/lib/auth.ts` — `AuthState` con `plan?`, `saveAuth` / `getStoredAuth`, OTP
- `src/lib/auth-context.tsx` — `AuthProvider`, `useAuth`
- `/login` — email → OTP 6 cifre → stati scaduto waitlist/premium
- `/auth?token=<JWT>` — magic link post-checkout → `login()` → `/`
- JWT in `localStorage` (`linkyscout.auth`)
- `(protected)/layout.tsx`: no user → `/login`; `plan === "assistant"` → `/upgrade`

### Pagine

| Route | Descrizione |
|---|---|
| `/` | New Search — ICP, progress, risultati, dialog crediti |
| `/history` | Lista ricerche, View Results, Re-run, Delete |
| `/leads` | `profili_salvati` — badge Scout/Extension, client Supabase |
| `/settings` | Account, piano, crediti, tema, logout |
| `/upgrade` | Utenti piano Assistant — CTA pricing |
| `/login`, `/auth` | Pubbliche |

### Layout protetto

- Sidebar 260px, brand `#6d47f5`, dark mode (`next-themes`, `linkyscout.theme`)
- Header: `CreditBalance` → `/settings#credits`
- `CreditsProvider` + `useCredits()` → `get-credits`

### Componenti

- `sidebar.tsx`, `search-results-table.tsx`, `lead-detail-sheet.tsx`, `score-badge.tsx` (verde ≥80, giallo 60–79, grigio &lt;60)
- `theme-toggle.tsx`, `buy-credits-modal.tsx`, `insufficient-credits-dialog.tsx`, `credit-packs.tsx`
- `formatRelativeDate` — appende `Z` ai timestamp Supabase per UTC

### Salvataggio lead

`src/lib/leads.ts` → `profili_salvati` con `source: "scout"`, aggiorna `saved_to_crm` su `search_results`.

---

## FASE 6 — Deploy & Testing

### Secrets Supabase (Edge Functions)

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CLAUDE_API_KEY
LINKDAPI_KEY
AUTH_JWT_SECRET
```

(+ `RESEND_API_KEY` solo per OTP su Linky Assistant)

### JWT Verification — disabilitare per

`start-search`, `get-job-status`, `process-search-job`, `process-pending-jobs`, `parse-icp`, `stage1-search`, `stage2-enrich`, `score-profiles`, `get-searches`, `delete-search`, `get-credits`, `test-linkdapi`

### JWT Verification — lasciare ON

`request-otp`, `verify-otp` (Linky Assistant)

### Deploy

```powershell
supabase functions deploy parse-icp
supabase functions deploy stage1-search
supabase functions deploy stage2-enrich
supabase functions deploy score-profiles
supabase functions deploy start-search
supabase functions deploy process-search-job
supabase functions deploy process-pending-jobs
supabase functions deploy get-job-status
supabase functions deploy get-searches
supabase functions deploy delete-search
supabase functions deploy get-credits
```

### Test end-to-end

1. Login con piano **scout** o **bundle** (o trial waitlist attivo).
2. Utente **assistant** → redirect `/upgrade`.
3. Saldo crediti in header ≥ 100.
4. Nuova ricerca ICP → progress: parsing → searching → enriching → scoring → done (2–4 min).
5. Risultati con score, `match_reason`, `best_context`; apri sheet dettaglio.
6. Salva lead → `/leads` + `profili_salvati` con `source = scout`.
7. `/history` → View Results (`?searchId=`), Re-run (`?prompt=`), Delete.
8. Stesso ICP → risposta cached rapida; crediti comunque -100.
9. Crediti insufficienti → dialog 402.
10. Magic link `/auth?token=...` dopo acquisto.
11. Dark mode toggle.

### Test pipeline ICP (debug)

- `supabase functions invoke test-linkdapi` — connettività API.
- Log Edge Functions per stage fallito (`search_jobs.error_message`, `status = failed`).
- Verificare `parsed_filters` sul job dopo stage `start`.
- Confrontare conteggio `search_results` dopo stage1 vs profili con `bio` popolato dopo stage2.

---

## Note architetturali

### Timeout Edge Functions (150s)

La pipeline completa supera un singolo timeout. **Soluzione:** uno stage per invocazione + `process-pending-jobs` che rilancia il job; il cron è safety net se `waitUntil` non parte.

### JWT custom vs Supabase client

Il JWT Scout non è un JWT Supabase nativo. Query su `searches` / `search_jobs` / `search_results` → Edge Functions + `SERVICE_ROLE_KEY` + verifica HMAC manuale.

### Astrazione LinkdAPI

Sostituire provider = nuova classe che implementa `LeadDataProvider` + una riga in `index.ts`.

### Caching 7 giorni

ICP normalizzato (ordine parole, no punteggiatura) → stesso hash. Bilancia costo API e freschezza; ogni run utente resta in history.

### Branch `Miglioramento_Ricerca` — idee di miglioramento ICP

Aree naturali senza cambiare il contratto frontend:

1. **stage1** — usare `behavioralCriteria` / `industry` nei filtri o in pre-scoring leggero.
2. **parse-icp** — arricchire geo/industry; validazione schema; fallback se Claude non restituisce JSON.
3. **stage1** — `count` dinamico o paginazione se pochi profili passano i filtri.
4. **score-profiles** — batching se &gt; N profili; prompt che pesa esplicitamente `behavioralCriteria`.
5. **Rate limit** — parallelismo / backoff configurabile per piano o crediti.

---

*Documento allineato al branch `Miglioramento_Ricerca` e al codice in `supabase/functions/` + `src/`.*
