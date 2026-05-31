# Linky Scout — Workflow di sviluppo v4
*Aggiornato: maggio 2026 — stack, crediti, piani, pipeline ICP, rate limiting, motore comportamentale*

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
| Rate limiting | Token bucket in Postgres (`rate_limit_state` + `consume_linkdapi_token()`) — globale su tutte le chiamate LinkdAPI |
| Motori di ricerca | **Motore A** (search/people, ICP classici) + **Motore B** (search/posts, ICP comportamentali) |

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

**1.3** — `search_results` (include colonna `match_post` per il motore comportamentale):
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
  match_post TEXT DEFAULT NULL,  -- post che ha fatto match nel motore comportamentale
  saved_to_crm BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

> `match_post` è NULL per profili trovati con il Motore A (search/people). Valorizzato dal Motore B (search/posts) con il testo del post che ha causato il match — usato come prova forte nello scoring.

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

**1.6** — `rate_limit_state` (token bucket globale per LinkdAPI):
```sql
CREATE TABLE rate_limit_state (
  id INT PRIMARY KEY DEFAULT 1,
  tokens_available NUMERIC NOT NULL DEFAULT 25,
  bucket_size NUMERIC NOT NULL DEFAULT 25,
  refill_rate_per_second NUMERIC NOT NULL DEFAULT 0.4,
  last_refill_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_consumed BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT singleton_check CHECK (id = 1)
);

INSERT INTO rate_limit_state (id, tokens_available, bucket_size, refill_rate_per_second, last_refill_at)
VALUES (1, 25, 25, 0.4, NOW())
ON CONFLICT (id) DO NOTHING;
```

**Funzioni Postgres per il rate limiter:**

```sql
-- Consuma 1 token atomicamente. Ritorna TRUE se disponibile, FALSE se bucket vuoto.
-- FOR UPDATE serializza le chiamate concorrenti di più job/utenti.
CREATE OR REPLACE FUNCTION consume_linkdapi_token() RETURNS BOOLEAN ...

-- Stato read-only del bucket (per monitoring/debugging)
CREATE OR REPLACE FUNCTION get_rate_limit_status() RETURNS TABLE(...) ...
```

> Il rate limiter è **globale per account LinkdAPI** — condiviso tra tutti gli utenti e job. Tier Hobby: 30 req/min → `bucket_size=25`, `refill_rate=0.4/s` (=24/min con margine di sicurezza). Con la tabella `rate_limit_state` abilitare RLS e chiamare via service role.

**1.7** — RLS su `searches`, `search_jobs`, `search_results`. **NON** su `search_cache`, `rate_limit_state`.

**1.8** — RLS policies (`user_id` TEXT = email dal JWT custom):
```sql
CREATE POLICY "Users see own searches" ON searches
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see own jobs" ON search_jobs
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see results of own searches" ON search_results
  FOR ALL USING (
    search_id IN (SELECT id FROM searches WHERE user_id = current_setting('request.jwt.claims', true)::json->>'email')
  );
```

> Le policy RLS con JWT custom **non funzionano** con il client browser anon su `searches` / `search_results`. Le query utente passano da Edge Functions con `SERVICE_ROLE_KEY` + verifica JWT manuale.

### FASE 1b — Abbonamenti e crediti (DB Linky Assistant)

| Tabella / RPC | Uso in Scout |
|---|---|
| `user_subscriptions` | `email`, `plan`, `status`, `current_period_end` → accesso Scout |
| `user_credits` | `subscription_credits`, `pack_credits`, `credits_period_end`, … |
| `deduct_search_credits(p_email, p_amount, p_search_id)` | Addebito atomico in `start-search` |

- Costo ricerca: **`SEARCH_COST = 100`** (anche su **cache hit**).
- Pack acquistabili: definiti in `src/lib/credits.ts`.
- Checkout Stripe: `POST https://www.linkyassistant.com/api/create-checkout`.

---

## Pipeline ICP — Ricerca lead (cuore del prodotto)

### Panoramica end-to-end

```mermaid
sequenceDiagram
  participant U as Utente (/)
  participant SS as start-search
  participant DB as Postgres
  participant PP as process-pending-jobs
  participant PS as process-search-job
  participant PI as parse-icp
  participant S1A as stage1-search (Motore A)
  participant S1B as stage1-behavioral (Motore B)
  participant S2 as stage2-enrich
  participant SC as score-profiles
  participant RL as rate_limit_state
  participant L as LinkdAPI

  U->>SS: POST { icpPrompt } + JWT
  SS->>SS: resolveAccess(scout) + deduct 100 crediti
  SS->>DB: INSERT searches
  alt Cache hit
    SS->>DB: INSERT search_results da cache
    SS-->>U: { cached: true, results, searchId }
  else Cache miss
    SS->>DB: INSERT search_jobs (pending, queued)
    SS-->>U: { cached: false, jobId, searchId }
    U->>U: poll get-job-status ogni 3s
    PP->>PS: stage start
    PS->>PI: prompt ICP → filtri JSON (include searchMode, postKeyword, behavioralIntent)
    PS->>DB: parsed_filters, next_stage=search
    PP->>PS: stage search (self-loop chunked)
    alt searchMode = behavioral + postKeyword valido
      PS->>S1B: search/posts + dedup autori + overview chunks
    else searchMode = profile (default)
      PS->>S1A: search/people + overview chunks
    end
    Note over S1A,S1B: Ogni chiamata LinkdAPI passa per consume_linkdapi_token() (RL)
    S1A/S1B->>DB: INSERT search_results (follower_count=-1 marker pending)
    PP->>PS: stage enrich (self-loop chunked)
    PS->>S2: searchId (chunk da 6 profili per invocazione)
    S2->>L: profile/details + posts/all (sequenziale, rate limited)
    S2->>DB: UPDATE bio, recent_posts
    PP->>PS: stage score
    PS->>SC: searchId + icpPrompt + behavioralIntent
    SC->>SC: Claude valuta bio + post + match_post
    SC->>DB: UPDATE match_score, match_reason, best_context; DELETE score < 50
    PP->>PS: stage finalize
    PS->>DB: search_cache upsert + job completed
    U->>U: risultati ordinati per match_score
  end
```

### Cosa fa l'utente (frontend)

1. Al primo click su Search → **popup informativo** (`SearchTipsDialog`) si mostra **una volta per sessione**.
2. Scrive un **prompt ICP in linguaggio naturale** su `/` (textarea + chip di esempio).
3. Submit → `start-search` con `{ icpPrompt }` e `Authorization: Bearer <JWT>`.
4. Se `cached: true` → risultati immediati (dopo addebito crediti).
5. Se `cached: false` → progress bar **granulare** (12→38 stage1, 42→72 stage2, 80→90 score), label da `stageLabel()`, polling ogni **3 secondi**.
6. Stima UX: toast *"4–8 minutes"*.

URL utili:
- `/?searchId=<uuid>` — ricarica risultati da history
- `/?prompt=<testo>` — pre-compila textarea

### Fase A — `start-search` (ingresso)

| Step | Azione |
|---|---|
| 1 | Verifica JWT custom (`AUTH_JWT_SECRET`) |
| 2 | `resolveAccess(email, …, "scout")` + `canUseScout()` — altrimenti 401 |
| 3 | Valida `icpPrompt` non vuoto |
| 4 | `INSERT searches` |
| 5 | `deduct_search_credits(email, 100, searchId)` — se fallisce, DELETE `searches` |
| 6 | Insufficiente → **402** `{ error: "insufficient_credits", balance, required: 100 }` |
| 7 | `getCachedResults(supabase, icpPrompt)` |
| 8a Cache hit | Copia righe in `search_results`, risposta `{ cached: true, results, searchId }` |
| 8b Cache miss | `INSERT search_jobs`, risposta `{ cached: false, jobId, searchId }` |

### Fase B — Orchestrazione job

**Architettura chunked self-loop:**

- Ogni invocazione di `process-search-job` esegue **un solo stage** e termina.
- Stage1 e Stage2 sono **chunked**: ogni invocazione processa un sottoinsieme di profili e rilancia sé stessa via `next_stage` finché `done=true`.
- `process-pending-jobs` (cron **ogni minuto** + trigger post-stage):
  - Lancia job `pending` con stage `"start"` (max 3).
  - Per job `running` con `next_stage` valorizzato: **lock ottimistico** poi lancia lo stage (max 5).
  - `launchJob` usa `AbortController` a **1500ms**.

| Stage | `current_stage` (UI) | Progress | Chiamate | Output su DB |
|---|---|---|---|---|
| `start` | `parsing` → `search` | 5 → 10 | `parse-icp` | `parsed_filters` sul job |
| `search` | `searching` | 12 → 38 (granulare) | `stage1-search` o `stage1-behavioral` | righe `search_results` |
| `enrich` | `enriching` | 42 → 72 (granulare) | `stage2-enrich` | `bio`, `recent_posts` |
| `score` | `scoring` | 80 → 90 | `score-profiles` | `match_score`, `match_reason`, `best_context`; DELETE < 50 |
| `finalize` | `completed` | 100 | `setCachedResults` | `search_cache` + job `completed` |

### Fase C — `parse-icp` (testo → filtri strutturati + routing)

File: `supabase/functions/parse-icp/index.ts`

- Input: `{ prompt: string }`.
- Modello: `claude-sonnet-4-6`, `max_tokens: 600`.
- Prompt strutturato con XML tags (`<task>`, `<field_specs>`, `<mappings>`, `<examples>`, `<rules>`).
- **4+ esempi few-shot** per calibrare il parsing.
- Output wrappato in `<filters>...</filters>` per parsing robusto via regex + JSON.parse.

| Campo | Tipo | Uso downstream |
|---|---|---|
| `keyword` | string | Tradotto in LinkedIn-vernacular (es. "stealth" invece di "building my next thing") |
| `title` | string | `searchProfiles` + filtro headline in stage1 |
| `geoUrns` | string[] | `searchProfiles`. **Mai vuoto** — default a 9 paesi (USA, UK, CA, AU, DE, FR, IT, ES, NL) se non specificato |
| `industry` | string[] | `searchProfiles` → param `industry` (22 settori mappati) |
| `language` | string | `searchProfiles` → `profileLanguage` |
| `maxFollowers` | number \| null | Filtro stage1 su `followerCount` |
| `behavioralCriteria` | string[] | Segnali comportamentali per scoring (max 4 items × 5 parole) |
| `searchMode` | `"profile"` \| `"behavioral"` | **Router motore**: `behavioral` = ICP su cosa la persona esprime in post; `profile` = default sicuro |
| `postKeyword` | string | Solo se `behavioral`: keyword da cercare nel **contenuto** dei post (es. "lead quality") |
| `behavioralIntent` | `"expresses"` \| `"offers"` \| `"both"` | Solo se `behavioral`: chi vuoi tra chi posta sul tema |

**Regola routing `searchMode`:** "La persona ha probabilmente scritto un POST su questo?" → `behavioral`. Ruolo/settore/attributo statico/azione silenziosa → `profile`.

**`behavioralIntent`:** lamentele/frustrazioni in prima persona → `"expresses"`. Servizi/soluzioni → `"offers"`. Misto o non chiaro → `"both"`. Default `"expresses"`.

**DEFAULT_GEO** (9 IDs): `["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"]`

### Fase D — `stage1-search` (Motore A — ICP classici)

File: `supabase/functions/stage1-search/index.ts`

**Architettura chunked self-loop** (`CHUNK_SIZE=12`):

**Prima invocazione** (nessun risultato in DB per questo searchId):
1. `searchProfiles({ count: 50 })` — 1 credito.
2. Pre-filtro headline: title-match AND-tokenized + blacklist nonprofit/charity/ministry.
3. Fallback: se < 15 profili passano il filtro, usa i grezzi.
4. `INSERT` scheletri con `follower_count=-1` (marker "pending overview").

**Invocazioni successive** (scheletri presenti):
1. Prende `LIMIT 12` scheletri con `follower_count=-1`.
2. Loop **sequenziale** (no Promise.all): `getProfileOverview(username)` → rate limited via token bucket.
3. Filtro `maxFollowers`: supera soglia → DELETE; fallisce overview → DELETE (Motore A scarta).
4. UPDATE `follower_count` reale + `linkedin_urn` aggiornato.
5. Ritorna `{ done, stillPending }` → se `done=false`, self-loop via `next_stage="search"`.

**Costo stimato:** ~89 crediti per ricerca (1 search + ~44×2 overview).

### Fase D2 — `stage1-behavioral` (Motore B — ICP comportamentali)

File: `supabase/functions/stage1-behavioral/index.ts`

Attivato quando `parsed_filters.searchMode === "behavioral"` E `postKeyword` non vuoto.

**Prima invocazione:**
1. Pagina `search/posts(keyword=postKeyword, authorJobTitle=title, datePosted=past-month)` — max 6 pagine, max 25 autori unici (dedup per `author.urn`).
2. Pre-filtro headline con AND-tokenized su title (gratis, dall'autore del post).
3. `INSERT` scheletri con `follower_count=-1` + `match_post` = testo del post che ha fatto match.
4. Se 0 autori trovati → `done=true` immediato (nessun loop infinito).

**Invocazioni successive:**
1. Chunk di 12 overview sequenziali — rate limited.
2. **Differenza dal Motore A**: su fallimento overview → `follower_count=0` (profilo tenuto perché ha `match_post`). Non DELETE.
3. Filtro `maxFollowers` post-overview: sopra soglia → DELETE.

**Nota:** `location` è vuota per i profili del Motore B (search/posts non la restituisce).

**Costo stimato:** ~80-90 crediti per ricerca (3-5 search/posts + ~25×2 overview).

### Fase E — `stage2-enrich` (bio + post)

File: `supabase/functions/stage2-enrich/index.ts`

**Architettura chunked self-loop** (`CHUNK_SIZE=6`):

1. Prende `LIMIT 6` candidati con `bio IS NULL`.
2. Loop **sequenziale** per ogni candidato:
   - `getProfileDetails(urn)` → `bio` da `data.about` — rate limited.
   - Se fallisce: `UPDATE bio=""` + `continue` (non resta in "bio IS NULL" al prossimo chunk, non blocca).
   - `getRecentPosts(urn)` — rate limited. Se fallisce: `posts=[]` ma salva la bio.
3. `UPDATE bio`, `recent_posts`.
4. Conta `bio IS NULL` rimanenti → ritorna `{ done, stillPending }` → self-loop se `done=false`.

**Niente Promise.all, niente sleep:** il rate limiter (token bucket) gestisce il ritmo.

**Costo stimato:** ~80 crediti per 40 candidati (40 details + 40 posts).

### Fase F — `score-profiles` (match AI)

File: `supabase/functions/score-profiles/index.ts`

- Input: `{ searchId, icpPrompt, behavioralIntent }` — `icpPrompt` è il testo originale.
- Modello: `claude-sonnet-4-6`, `max_tokens: 5000`.
- **Pre-routing dati**: separa profili `scoreable` (bio≥50 char OR posts≥1 OR match_post presente) da `insufficient`. Gli insufficient vengono eliminati senza chiamare Claude.
- Prepara per Claude: headline, location, follower_count, bio (max 1500 char), ultimi 3 post (max 250 char), `matchPost` se presente.
- **Dynamic few-shot**: `selectExamples(icpPrompt)` inietta esempi rilevanti per il dominio.
- **`buildSellerRule(behavioralIntent)`**: inietta la regola seller corretta:
  - `"expresses"` → seller cappati a 45 (vogliono chi vive il problema)
  - `"offers"` → seller premiati (sono il target)
  - `"both"` → nessuna penalità
- Schema output compatto: `{ i, s, r, c }` (index, score, reason, context).
- **DELETE finale** (due query separate per robustezza):
  - `DELETE WHERE match_score < 50`
  - `DELETE WHERE match_score IS NULL`
- `topMatches` calcolato sui sopravvissuti (score ≥ 50).

**Rubrica scoring:**
- **90-100** — Match perfetto (prova esplicita in bio E post)
- **75-89** — Match forte (ruolo+settore confermati + segnale comportamentale)
- **60-74** — Match plausibile ("forse buono", vale outreach generico)
- **40-59** — Mismatch debole
- **0-39** — Mismatch chiaro / settore fuori ICP
- **≤45** — Cap automatico per SELLER del tema ICP (quando `behavioralIntent="expresses"`)
- **≤35** — Cap per nonprofit/charity/ministry/advocacy

**Tutto il testo di output (match_reason, best_context) è in inglese** — il prompt forza English indipendentemente dalla lingua dell'ICP.

### Fase G — Cache

File: `_shared/lead-providers/cache.ts`

- **Lettura** (`start-search`): stesso ICP normalizzato → hit se `expires_at > now`.
- **Scrittura** (`finalize`): upsert su `icp_hash` con TTL **7 giorni**.
- Anche i hit cached creano una riga in `searches` + risultati in `search_results`.

### Riepilogo: dove vive ogni informazione dell'ICP

| Informazione ICP | parse-icp | stage1 LinkdAPI | stage2 | score-profiles |
|---|---|---|---|---|
| Settore / keyword | `keyword` (tradotto in LinkedIn-vernacular) | ✅ search API | — | ✅ |
| Ruolo / title | `title` | ✅ API + filtro headline | — | ✅ |
| Paese | `geoUrns` (default 9 paesi se vuoto) | ✅ geoUrn | — | ✅ |
| Industry | `industry` (22 settori mappati) | ✅ param industry | — | ✅ |
| Lingua profilo | `language` | ✅ profileLanguage | — | — |
| Max follower | `maxFollowers` | ✅ filtro numerico | — | ✅ |
| Segnali comportamentali | `behavioralCriteria` | ❌ non usato in stage1 | — | ✅ via `icpPrompt` |
| Motore di ricerca | `searchMode` | ✅ routing A/B | — | — |
| Keyword post (behavioral) | `postKeyword` | ✅ Motore B search/posts | — | — |
| Intent behavioral | `behavioralIntent` | — | — | ✅ modula regola seller |
| Post di match | — | ✅ Motore B salva in `match_post` | — | ✅ prova forte se presente |

---

## FASE 2 — Layer di astrazione LinkdAPI

Struttura: `supabase/functions/_shared/lead-providers/`

**`types.ts`** — tipi principali:
- `LeadDataProvider` (interfaccia), `SearchFilters`, `ProfileBasic`, `ProfileOverview`, `ProfileDetails`, `Post`
- **Nuovi:** `PostSearchFilters`, `PostSearchResult`, `PostSearchResponse` (per Motore B)
- `SearchFilters` include campi opzionali: `searchMode?`, `postKeyword?`

**`linkdapi.ts`** — implementazione `LinkdAPIProvider`:
- Auth: `x-linkdapi-apikey`
- `searchProfiles` → `GET /api/v1/search/people`
- `getProfileOverview` → `GET /api/v1/profile/overview?username=...`
- `getProfileDetails` → `GET /api/v1/profile/details?urn=...`
- `getRecentPosts` → `GET /api/v1/posts/all?urn=...`
- **Nuovo** `searchPosts` → `GET /api/v1/search/posts?keyword=...&authorJobTitle=...&datePosted=...`
- **Rate limiting**: ogni metodo chiama `acquireLinkdApiToken(supabase, label)` prima della fetch HTTP. Il costruttore crea un client Supabase interno (service role) per le RPC.
- Unwrap: `response.json().data`

**`rate-limiter.ts`** — helper rate limiting:
- `acquireLinkdApiToken(supabase, label)`: polling (500ms) su `consume_linkdapi_token()` RPC finché ottiene token o timeout (90s). Logga attese > 1s.
- `logRateLimitStatus(supabase, label)`: read-only status per debugging.

**`index.ts`** — factory `getLeadProvider()` da `LINKDAPI_KEY`

**`cache.ts`** — `normalizeICP`, `hashICP`, `getCachedResults`, `setCachedResults` (7 giorni)

**`icp-examples.ts`** — libreria esempi per dynamic few-shot in score-profiles:
- `selectExamples(icpPrompt)`: seleziona top 2 categorie per keyword match → 4 esempi iniettati nel system prompt.
- Categorie: `cold-outreach`, `saas-b2b`, `sales-leader`, `agency-consultant`, `bootstrapped`, `stealth`, `sdr-bdr`.

### Endpoint LinkdAPI usati

| Endpoint | Crediti | Usato in |
|---|---|---|
| `GET /api/v1/search/people` | 1 | stage1-search (Motore A) |
| `GET /api/v1/profile/overview` | 2 | stage1-search, stage1-behavioral |
| `GET /api/v1/profile/details` | 1 | stage2-enrich |
| `GET /api/v1/posts/all` | 1 | stage2-enrich |
| `GET /api/v1/search/posts` | 1 | stage1-behavioral (Motore B) |
| `GET /api/i/v1/credits/balance/k/` | 0 | monitoring (header `X-AUTHAPI-Key`) |
| `GET /api/i/v1/credits/tier/k/` | 0 | monitoring, rate limit sync |

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

---

## FASE 4 — Edge Functions API (riepilogo)

| Function | Auth JWT | Access Scout | Note |
|---|---|---|---|
| `start-search` | ✅ | ✅ | Crediti + cache + crea job |
| `get-job-status` | ✅ | ✅ | Poll `{ jobId }` o load `{ searchId }` |
| `get-searches` | ✅ | ✅ | History |
| `delete-search` | ✅ | ✅ | Cascata results → jobs → searches |
| `get-credits` | ✅ | — | Saldo + piano |
| `parse-icp` | service | — | Router motore + filtri strutturati |
| `stage1-search` | service | — | Motore A: search/people, chunked |
| `stage1-behavioral` | service | — | **Motore B**: search/posts, chunked |
| `stage2-enrich` | service | — | Bio + post, chunked |
| `score-profiles` | service | — | Scoring AI + DELETE < 50 |
| `process-search-job` | service | — | Un stage per call, routing A/B |
| `process-pending-jobs` | service / cron | — | Dispatcher con lock ottimistico |
| `test-linkdapi` | — | — | Debug |

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

- `src/lib/auth.ts` — `AuthState`, `saveAuth` / `getStoredAuth`, OTP
- `src/lib/auth-context.tsx` — `AuthProvider`, `useAuth`
- JWT in `localStorage` (`linkyscout.auth`)
- `(protected)/layout.tsx`: no user → `/login`; `plan === "assistant"` → `/upgrade`

### Pagine

| Route | Descrizione |
|---|---|
| `/` | New Search — ICP, progress granulare, risultati, dialog crediti |
| `/history` | Lista ricerche, View Results, Re-run, Delete |
| `/leads` | `profili_salvati` — badge Scout/Extension |
| `/settings` | Account, piano, crediti, tema, logout |
| `/upgrade` | Utenti piano Assistant — CTA pricing |
| `/login`, `/auth` | Pubbliche |

### Layout protetto

- Sidebar 260px, brand `#6d47f5`, dark mode (`next-themes`, `linkyscout.theme`)
- Header: `CreditBalance` → `/settings#credits`
- `CreditsProvider` + `useCredits()` → `get-credits`

### Componenti chiave

- `sidebar.tsx`, `search-results-table.tsx`, `lead-detail-sheet.tsx`
- `score-badge.tsx` — **verde ≥75**, giallo 60–74, grigio <60 (nessun badge se `null`)
- `SearchTipsDialog` (in `page.tsx`) — popup informativo mostrato **una volta per sessione** al primo click Search. Spiega la differenza tra ICP profile e behavioral.
- `buy-credits-modal.tsx`, `insufficient-credits-dialog.tsx`
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

### JWT Verification — disabilitare per (--no-verify-jwt)

Tutte le Edge Functions interne e pubbliche:
`start-search`, `get-job-status`, `process-search-job`, `process-pending-jobs`, `parse-icp`, `stage1-search`, `stage1-behavioral`, `stage2-enrich`, `score-profiles`, `get-searches`, `delete-search`, `get-credits`, `test-linkdapi`

### Deploy

```powershell
supabase functions deploy parse-icp --no-verify-jwt
supabase functions deploy stage1-search --no-verify-jwt
supabase functions deploy stage1-behavioral --no-verify-jwt
supabase functions deploy stage2-enrich --no-verify-jwt
supabase functions deploy score-profiles --no-verify-jwt
supabase functions deploy start-search --no-verify-jwt
supabase functions deploy process-search-job --no-verify-jwt
supabase functions deploy process-pending-jobs --no-verify-jwt
supabase functions deploy get-job-status --no-verify-jwt
supabase functions deploy get-searches --no-verify-jwt
supabase functions deploy delete-search --no-verify-jwt
supabase functions deploy get-credits --no-verify-jwt
```

> `stage1-behavioral` richiede un `deno.json` nella sua cartella — copiarlo da `stage1-search`:
> `cp supabase/functions/stage1-search/deno.json supabase/functions/stage1-behavioral/deno.json`

### Test end-to-end

1. Login con piano **scout** o **bundle** (o trial waitlist attivo).
2. Utente **assistant** → redirect `/upgrade`.
3. Saldo crediti in header ≥ 100.
4. **Primo click Search** → popup `SearchTipsDialog` appare; "Got it, search" avvia la ricerca.
5. Secondo click (stessa sessione) → nessun popup, parte direttamente.
6. Nuova ricerca ICP classica → progress granulare: parsing → searching (12→38) → enriching (42→72) → scoring → done (4–8 min).
7. Verifica log `[parse-icp] filters`: `searchMode="profile"`, `geoUrns` mai vuoto.
8. Nuova ricerca ICP comportamentale (es. "founders complaining about lead quality") → verifica `searchMode="behavioral"`, `postKeyword` valorizzato, `stage1-behavioral` nei log.
9. Risultati: solo profili con score ≥ 50; verde ≥75, giallo 60–74, grigio 50–59.
10. Risultati con `match_reason` e `best_context` in **inglese** indipendentemente dalla lingua ICP.
11. Profili comportamentali: verifica `match_post` nel dettaglio sheet.
12. Salva lead → `/leads` + `profili_salvati` con `source = scout`.
13. `/history` → View Results, Re-run, Delete.
14. Stesso ICP → risposta cached; crediti -100.
15. Crediti insufficienti → dialog 402.
16. Dark mode toggle.

### Test rate limiting

```sql
-- Verifica stato bucket
SELECT * FROM get_rate_limit_status();

-- Svuota bucket manualmente per testare throttling
UPDATE rate_limit_state SET tokens_available = 0;

-- Reset a pieno
UPDATE rate_limit_state SET tokens_available = 25, last_refill_at = NOW();
```

Nei log Edge Functions, righe tipo `[rate-limit:profile/overview] token acquisito dopo Xms` indicano throttling attivo (normale quando il bucket si svuota).

### Test concorrenza

Aprire 3 tab/account e lanciare 3 ricerche simultaneamente. Il token bucket serializza le chiamate LinkdAPI — verificare che tutte e 3 completino senza `429` di LinkdAPI nei log.

### Test pipeline ICP (debug)

- `supabase functions invoke test-linkdapi` — connettività API.
- Log Edge Functions per stage fallito (`search_jobs.error_message`, `status = failed`).
- Verificare `parsed_filters.searchMode` sul job dopo stage `start`.
- Confrontare `follower_count=-1` dopo stage1 vs `bio IS NULL` dopo stage2.

---

## Note architetturali

### Timeout Edge Functions (150s)

La pipeline completa supera un singolo timeout. **Soluzione:** architettura chunked self-loop — ogni stage processa un sottoinsieme piccolo (12 overview per chunk, 6 enrich per chunk) e rilancia sé stesso via `next_stage`. Ogni invocazione dura ~15-30s, ben dentro i 150s.

### Rate limiting globale LinkdAPI

Un singolo account LinkdAPI ha un rate limit condiviso tra **tutti gli utenti** di Linky Scout. Il token bucket in Postgres (`rate_limit_state`) è la fonte di verità unica — tutte le Edge Functions che chiamano LinkdAPI passano per `consume_linkdapi_token()` via `acquireLinkdApiToken()`. La serializzazione avviene via `FOR UPDATE` sulla singola riga della tabella.

**Calibrazione tier Hobby** (30 req/min): `bucket_size=25`, `refill_rate=0.4/s` (24/min). Quando si upgradia il tier, aggiornare i parametri nella tabella:
```sql
UPDATE rate_limit_state SET bucket_size=60, refill_rate_per_second=1.0;
```

### Due motori di ricerca

| | Motore A (profile) | Motore B (behavioral) |
|---|---|---|
| Trigger | `searchMode: "profile"` (default) | `searchMode: "behavioral"` + `postKeyword` |
| Sorgente | `search/people` | `search/posts` |
| Candidati max | 40 | 25 |
| Profilo "vuoto" | DELETE su fallimento overview | TENUTO (ha `match_post`) |
| Pre-filtro | Title match + blacklist nonprofit | Solo title match (candidati già filtrati per contenuto) |
| Costo | ~153 crediti | ~80-90 crediti |
| Qualità | Buona per ICP ruolo/settore | Superiore per ICP comportamentali |

### JWT custom vs Supabase client

Il JWT Scout non è un JWT Supabase nativo. Query su `searches` / `search_jobs` / `search_results` → Edge Functions + `SERVICE_ROLE_KEY` + verifica HMAC manuale.

### Caching 7 giorni

ICP normalizzato (ordine parole, no punteggiatura) → stesso hash. Bilancia costo API e freschezza.

### Scoring — decisioni di design

- **Soglia eliminazione**: `match_score < 50` → DELETE dal DB. L'utente vede solo profili sopra soglia.
- **Soglia verde badge**: `score ≥ 75` (giallo 60-74, grigio 50-59).
- **Lingua output**: sempre inglese (forzato nel system prompt).
- **USER vs SELLER**: profili che vendono soluzioni al tema ICP sono cappati a 45 se `behavioralIntent="expresses"`, premiati se `"offers"`.
- **Dynamic few-shot**: `icp-examples.ts` seleziona esempi per dominio. Da popolare con esempi reali post-lancio.

### To-do pre-lancio (3 giugno)

1. **Concurrency limit nel dispatcher** — `process-pending-jobs` deve limitare a 1 job pesante (stage search/enrich) per volta. Il token bucket aiuta ma non serializza completamente a livello di job.
2. **Zombie job cleanup** — marcare `failed` i job `running` con `started_at` > 15 minuti.
3. **Refund crediti su job failed** — nel catch di `process-search-job` quando setta `status=failed`.
4. **Logging costi reali** — sommare crediti da stage1+stage2 e salvarli nel job.
5. **Monitoring LinkdAPI** — leggere `/credits/balance/k/` prima/dopo ricerca per tracciare consumo reale.

### Miglioramenti futuri (post-lancio)

1. **Industry mapping granulare** — linkdapi ha `/api/i/v1/g/industry-lookup` con lista completa. Attualmente mappati 22 settori hardcoded in parse-icp.
2. **Dynamic few-shot con dati reali** — popolare `icp-examples.ts` con esempi da ricerche produzione invece di sintetici.
3. **Selettore behavioral intent in UI** — oggi inferito da parse-icp; dopo il lancio aggiungere un selettore visuale nel form (richiede flusso a 2 fasi: parse → mostra selettore → parte ricerca).
4. **Cache più intelligente** — hash su `parsed_filters` invece che su `icp_prompt` per cache hit su variazioni testuali dello stesso ICP.
5. **Retry stage2 su profili falliti** — i profili con `bio=""` (failed details) potrebbero essere retentati in un secondo momento.
6. **Auto-sync rate limiter** — leggere `limit_per_minute` live da `/credits/tier/k/` invece di hardcodare `bucket_size=25`.

---

*Documento aggiornato al 29 maggio 2026 — allineato al codice in produzione dopo la sessione di sviluppo maggio 2026.*
