# Linky Scout — Workflow di sviluppo v5
*Aggiornato: giugno 2026 — motore commenter-based, seller detection, rate limiting, score dual-signal, routing behavioralIntent*

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
| Rate limiting | Token bucket in Postgres (`rate_limit_state` + `consume_linkdapi_token()`) — globale su tutte le chiamate LinkdAPI. **Retry 429 con backoff esponenziale** in `linkdapi.ts#request()`. |
| Motori di ricerca | **Motore A** (search/people, ICP classici) + **Motore B** (search/posts, autori, intent `offers`) + **Motore C** (posts/comments, commentatori, intent `expresses`) |

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

**1.3** — `search_results` (include colonna `match_post` per i motori comportamentali):
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
  match_post TEXT DEFAULT NULL,  -- post/commento che ha fatto match nel motore comportamentale
  saved_to_crm BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

> `match_post` è NULL per profili trovati con il Motore A (search/people). Valorizzato dal Motore B con il testo del post dell'autore, e dal Motore C con il testo del **commento** del commentatore (prefissato da `[Posted X days ago]`).

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
  tokens_available NUMERIC NOT NULL DEFAULT 10,
  bucket_size NUMERIC NOT NULL DEFAULT 10,
  refill_rate_per_second NUMERIC NOT NULL DEFAULT 0.4,
  last_refill_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_consumed BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT singleton_check CHECK (id = 1)
);

INSERT INTO rate_limit_state (id, tokens_available, bucket_size, refill_rate_per_second, last_refill_at)
VALUES (1, 10, 10, 0.4, NOW())
ON CONFLICT (id) DO NOTHING;
```

> **Nota:** `bucket_size` è stato ridotto da 25 a **10** per evitare burst concentrati che causano 429 su LinkdAPI Hobby (30 req/min). Il rate sostenuto resta 0.4/s ≈ 24/min. Per aggiornare:
> ```sql
> UPDATE rate_limit_state SET bucket_size = 10, tokens_available = LEAST(tokens_available, 10) WHERE id = 1;
> ```

**Funzioni Postgres per il rate limiter:**

```sql
-- Consuma 1 token atomicamente. Ritorna TRUE se disponibile, FALSE se bucket vuoto.
-- FOR UPDATE serializza le chiamate concorrenti di più job/utenti.
CREATE OR REPLACE FUNCTION consume_linkdapi_token() RETURNS BOOLEAN ...

-- Stato read-only del bucket (per monitoring/debugging)
CREATE OR REPLACE FUNCTION get_rate_limit_status() RETURNS TABLE(...) ...
```

> Il rate limiter è **globale per account LinkdAPI** — condiviso tra tutti gli utenti e job. Tier Hobby: 30 req/min → `bucket_size=10`, `refill_rate=0.4/s` (=24/min con margine di sicurezza). Con la tabella `rate_limit_state` abilitare RLS e chiamare via service role.

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
  participant S1C as stage1-commenters (Motore C)
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
    PS->>PI: prompt ICP → filtri JSON (include searchMode, postKeyword, postKeywordAlternatives, behavioralIntent)
    PS->>DB: parsed_filters, next_stage=search
    PP->>PS: stage search (self-loop chunked)
    alt searchMode = behavioral + intent = expresses
      PS->>S1C: search/posts commentatori + filtri ruolo + overview chunks
    else searchMode = behavioral + intent = offers/both
      PS->>S1B: search/posts autori + overview chunks
    else searchMode = profile (default)
      PS->>S1A: search/people + overview chunks
    end
    Note over S1A,S1C: Ogni chiamata LinkdAPI passa per consume_linkdapi_token() (RL) + retry 429
    S1A/S1B/S1C->>DB: INSERT search_results (follower_count=-1 marker pending)
    PP->>PS: stage enrich (self-loop chunked)
    PS->>S2: searchId (chunk da 6 profili per invocazione)
    S2->>L: profile/details + posts/all (sequenziale, rate limited)
    S2->>DB: UPDATE bio, recent_posts
    PP->>PS: stage score
    PS->>SC: searchId + icpPrompt + behavioralIntent
    SC->>SC: Claude valuta bio + post + match_post (dual-signal per commenter)
    SC->>DB: UPDATE match_score, match_reason, best_context; DELETE score < soglia
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
| `search` | `searching` | 12 → 38 (granulare) | `stage1-search` o `stage1-behavioral` o `stage1-commenters` | righe `search_results` |
| `enrich` | `enriching` | 42 → 72 (granulare) | `stage2-enrich` | `bio`, `recent_posts` |
| `score` | `scoring` | 80 → 90 | `score-profiles` | `match_score`, `match_reason`, `best_context`; DELETE < soglia |
| `finalize` | `completed` | 100 | `setCachedResults` | `search_cache` + job `completed` |

**Routing in `process-search-job`:**

```typescript
if (searchMode === "behavioral" && hasKeyword) {
  const intent = filters.behavioralIntent ?? "expresses";
  if (intent === "expresses") {
    // Motore C: cerca commentatori di post sul tema
    await callFunction("stage1-commenters", { searchId, filters });
  } else if (intent === "offers" || intent === "both") {
    // "both" trattato come "offers" (YAGNI). Log warning se "both".
    await callFunction("stage1-behavioral", { searchId, filters });
  }
} else {
  await callFunction("stage1-search", { searchId, filters });
}
```

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
| `title` | string | `searchProfiles` + filtro headline/ruolo in stage1 |
| `geoUrns` | string[] | `searchProfiles`. **Mai vuoto** — default a 9 paesi (USA, UK, CA, AU, DE, FR, IT, ES, NL) se non specificato |
| `industry` | string[] | `searchProfiles` → param `industry` (22 settori mappati) |
| `language` | string | `searchProfiles` → `profileLanguage` |
| `maxFollowers` | number \| null | Filtro stage1 su `followerCount` |
| `behavioralCriteria` | string[] | Segnali comportamentali per scoring (max 4 items × 5 parole) |
| `searchMode` | `"profile"` \| `"behavioral"` | **Router motore**: `behavioral` = ICP su cosa la persona esprime; `profile` = default sicuro |
| `postKeyword` | string | Solo se `behavioral`: keyword primaria per la ricerca post (es. "lead quality") |
| `postKeywordAlternatives` | string[] | Solo se `behavioral`: **3-4 varianti semantiche** di `postKeyword` con linguaggio emotivo/sintomatico che un sofferente userebbe nei commenti (es. `["unqualified leads","leads not converting","wasted ad spend","pipeline quality"]`). Usate da `stage1-commenters` in modo adattivo. |
| `behavioralIntent` | `"expresses"` \| `"offers"` \| `"both"` | Solo se `behavioral`: chi vuoi tra chi posta/commenta sul tema |

**Regola routing `searchMode`:** "La persona ha probabilmente scritto un POST o un COMMENTO su questo?" → `behavioral`. Ruolo/settore/attributo statico/azione silenziosa → `profile`.

**`behavioralIntent`:** lamentele/frustrazioni in prima persona → `"expresses"` (→ Motore C commenter). Servizi/soluzioni → `"offers"` (→ Motore B autori). Misto o non chiaro → `"both"` (→ trattato come `"offers"`). Default `"expresses"`.

**`postKeywordAlternatives`:** deve essere distinto da `postKeyword`. Preferire frasi che attraggono frustrazione in prima persona nei commenti più che etichette topic generiche. 1-4 parole ciascuna. Array vuoto se `searchMode = "profile"`.

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

### Fase D2 — `stage1-behavioral` (Motore B — ICP comportamentali `offers`)

File: `supabase/functions/stage1-behavioral/index.ts`

Attivato quando `behavioralIntent === "offers"` (o `"both"`) E `postKeyword` non vuoto.

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

### Fase D3 — `stage1-commenters` (Motore C — ICP comportamentali `expresses`)

File: `supabase/functions/stage1-commenters/index.ts`

Attivato quando `behavioralIntent === "expresses"` E `postKeyword` non vuoto.

**Razionale:** i founder e decision-maker che *vivono* un problema raramente lo postano pubblicamente (costo reputazionale), ma lo *commentano* sotto i post di thought leader o competitor che trattano il tema. Il Motore C trova questi commentatori, non gli autori.

**Costanti chiave:**
```typescript
const CHUNK_SIZE = 12;
const MAX_CANDIDATES = 25;
const MAX_POSTS_PAGES = 1;           // 1 pagina per keyword per contenere le chiamate API
const TARGET_CANDIDATES = 12;        // stop adattivo: ferma quando raggiunti
const MAX_SOURCE_POSTS_PER_KEYWORD = 3; // top 3 post per engagement per keyword
const MIN_POST_COMMENTS = 2;         // sotto 2 il rapporto credito/lead è pessimo
const COMMENTS_PER_POST = 30;
const MIN_COMMENT_LENGTH = 10;       // esclude solo emoji/micro-reazioni; "SEND","PRODUCT" sono segnali validi
const MATCH_POST_LIMIT = 2000;
```

**Fase 1 — Discovery multi-keyword adattiva:**

1. Costruisce `keywordsToTry = [postKeyword, ...postKeywordAlternatives]`.
2. Per ogni keyword (stop appena `candidates.size >= TARGET_CANDIDATES`):
   a. `search/posts(keyword=kw, datePosted="past-year", sortBy="relevance")` — `past-year` fisso, senza `authorJobTitle` (vogliamo post con alta discussione indipendentemente dal ruolo dell'autore).
   b. Filtra post con `commentsCount >= MIN_POST_COMMENTS`, ordina desc.
   c. Prende i **top 3 per commentsCount** (`MAX_SOURCE_POSTS_PER_KEYWORD`).
   d. Per ogni post: `getPostComments(postID, count=30, sortBy="date_posted")`.
   e. Applica filtri in-memory **gratis**:
      - **Layer 1a** — `commentTooShort`: `comment.length < 10` → scarta
      - **Layer 1b** — `commentSeller`: pattern `SELLER_IN_COMMENT_PATTERNS` (pitch del proprio tool/agency nel commento) → scarta
      - **Layer 1c** — Company: `author.id` inizia con `urn:li:company:` → scarta
      - **Layer 2** — `headlineSeller`: headline dell'autore matcha `buildHeadlineSellerCheck(postKeyword)` → scarta
      - **Layer 3** — `roleMismatch`: headline NON contiene ruolo target (`buildRoleMatcher(title)`) → scarta. La funzione usa `STANDARD_DECISION_MAKER_ROLES` (founder, ceo, owner, president, "managing director", partner, chief…) + `title` ICP, e esclude `EXCLUDED_OPERATIONAL_ROLES` (assistant, intern, trainee, student, coordinator, apprentice).
      - **Dedup** per `author.urn`: se duplicato, tieni il commento più lungo.
3. Insert `search_results` con `match_post = "[Posted X days ago] <testo commento>"` (usa `formatRelativeTime(createdAt)`).
4. Log: `[stage1-commenters] inseriti N candidati. Filtri gratis: A X too-short, B X seller-pitch, C X seller-headline, D X role-mismatch`

**Fase 2 — Overview (identica a Motore B):**
- Chunk da 12, `getProfileOverview`, filtro `maxFollowers`.
- Su fallimento overview → `follower_count=0` (tenuto, ha il commento).
- Log diagnostico: `[stage1-commenters] overview attempt: url="..." → username="..."` e su errore `[stage1-commenters] overview failed: username="..." error="..."`.

**Note importanti:**
- `authorJobTitle` NON viene passato a `search/posts` — vogliamo post da qualunque autore con alta discussione. Il filtro ruolo si applica sui **commentatori** (Layer 3), non sugli autori.
- Il fallback `past-month → past-year` è stato rimosso; si usa `past-year` fisso per massimizzare il pool.
- I `LEAD_MAGNET_PATTERNS` (filtrare "Send", "Interested") sono stati rimossi: chi commenta per ricevere un tool simile al tuo è un **buyer di categoria** valido.

**Endpoint aggiuntivo richiesto:** `getPostComments({ urn: postID, count, sortBy })` → `GET /api/v1/posts/comments?urn={postID}&count={count}&sortBy={sortBy}`. Il parametro `urn` vuole il **postID numerico** (es. `7459950909146652672`), non l'URN completo.

**Costo stimato fase 1:** ~20 chiamate max (5 keyword × 1 pagina search + fino a 15 getPostComments), poi ~12×2 overview in fase 2 = ~44 crediti totali.

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
- Modello: `claude-sonnet-4-6`, `max_tokens: 8000`.
- **Pre-routing dati**: separa profili `scoreable` (bio≥30 char OR posts≥1 OR match_post presente) da `insufficient`. Gli insufficient vengono eliminati senza chiamare Claude.
- Prepara per Claude: headline, location, follower_count, bio (max 1500 char), ultimi 3 post (max **600** char), `matchPost` se presente (max 500 char).
- **`buildSellerRule(behavioralIntent)`**: inietta la regola seller corretta (rimossa l'istruzione di cappare direttamente — il cap è enforced in codice).
- **Seller detection esplicita** (campi obbligatori nello schema output):
  - `is_selling_solution: boolean` — true se il profilo vende soluzioni al tema ICP
  - `seller_evidence: string` — frase citata che prova lo status seller
  - **Enforcement in codice**: se `is_selling_solution === true` && `behavioralIntent === "expresses"` → `match_score = min(score, SELLER_CAP_FOR_EXPRESSES)` (cap=30, applicato dopo il parse, non nel prompt).
- **Dual-signal scoring per commenter** (sezione `# DUAL-SIGNAL SCORING` nel prompt): quando `matchPost` è un commento (Motore C), valuta due segnali indipendenti:
  - `comment_signal`: "strong" / "weak" / "none" — quanto il commento esprime l'intent ICP
  - `bio_signal`: "strong" / "weak" / "none" — quanto bio+headline matchano il target
  - Regola: prendi il segnale **più forte** come driver primario (non la media). Weak comment + strong bio → 55-75.
- **DELETE soglia adattiva**:
  - `behavioralIntent === "expresses"` → `DELETE_THRESHOLD = 30`
  - Altri → `DELETE_THRESHOLD = 50`
- Log diagnostici:
  - `[score-profiles] seller cap applied: index=N original=X capped=Y evidence="..."`
  - `[score-profiles] signals: index=N score=X comment=... bio=...` (solo profili non seller-capped)
  - `[score-profiles] DELETE threshold: N (behavioralIntent="...")`

**Schema output Claude (ClaudeScore):**
```typescript
type ClaudeScore = {
  index: number;
  match_score: number;
  match_reason: string;
  best_context: string;
  is_selling_solution: boolean;
  seller_evidence: string;
  comment_signal: "strong" | "weak" | "none";
  bio_signal: "strong" | "weak" | "none";
};
```

**Rubrica scoring:**
- **90-100** — Match perfetto (prova esplicita in bio E post/commento)
- **75-89** — Match forte (ruolo+settore confermati + segnale comportamentale forte)
- **55-75** — Weak comment + strong bio (buyer di categoria, vale outreach)
- **35-50** — Weak comment + weak bio
- **0-34** — Mismatch chiaro / nessun segnale
- **≤30** — Cap automatico per SELLER del tema ICP (quando `behavioralIntent="expresses"`)
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
| Ruolo / title | `title` | ✅ API + filtro headline + filtro ruolo commenter | — | ✅ |
| Paese | `geoUrns` (default 9 paesi se vuoto) | ✅ geoUrn | — | ✅ |
| Industry | `industry` (22 settori mappati) | ✅ param industry | — | ✅ |
| Lingua profilo | `language` | ✅ profileLanguage | — | — |
| Max follower | `maxFollowers` | ✅ filtro numerico | — | ✅ |
| Segnali comportamentali | `behavioralCriteria` | ❌ non usato in stage1 | — | ✅ via `icpPrompt` |
| Motore di ricerca | `searchMode` | ✅ routing A/B/C | — | — |
| Keyword post (behavioral) | `postKeyword` | ✅ Motori B e C | — | — |
| Keyword alternative | `postKeywordAlternatives` | ✅ Motore C (multi-keyword adattivo) | — | — |
| Intent behavioral | `behavioralIntent` | ✅ routing B vs C | — | ✅ modula regola seller + soglia DELETE |
| Commento di match | — | ✅ Motore C salva in `match_post` con timestamp | — | ✅ dual-signal scoring |

---

## FASE 2 — Layer di astrazione LinkdAPI

Struttura: `supabase/functions/_shared/lead-providers/`

**`types.ts`** — tipi principali:
- `LeadDataProvider` (interfaccia), `SearchFilters`, `ProfileBasic`, `ProfileOverview`, `ProfileDetails`, `Post`
- `PostSearchFilters`, `PostSearchResult`, `PostSearchResponse` (per Motori B e C)
- `PostComment`, `PostCommentsResponse` (per Motore C)
- `SearchFilters` include campi opzionali: `searchMode?`, `postKeyword?`, `postKeywordAlternatives?: string[]`
- `PostSearchResult` include: `urn`, `postID`, `engagements.commentsCount`

**`linkdapi.ts`** — implementazione `LinkdAPIProvider`:
- Auth: `x-linkdapi-apikey`
- `searchProfiles` → `GET /api/v1/search/people`
- `getProfileOverview` → `GET /api/v1/profile/overview?username=...`
- `getProfileDetails` → `GET /api/v1/profile/details?urn=...`
- `getRecentPosts` → `GET /api/v1/posts/all?urn=...`
- `searchPosts` → `GET /api/v1/search/posts?keyword=...&datePosted=...`
- `getPostComments` → `GET /api/v1/posts/comments?urn={postID}&count=...&sortBy=...` *(postID = intero numerico)*
- **Rate limiting**: ogni metodo chiama `acquireLinkdApiToken(supabase, label)` via `#request()`. Il costruttore crea un client Supabase interno (service role) per le RPC.
- **Retry 429**: `#request()` ritenta fino a 3 volte con backoff esponenziale (1s, 2s) prima di propagare l'errore. Log: `[linkdapi] 429 on {endpoint}, retry N/3 after Xms`.
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
| `GET /api/v1/profile/overview` | 2 | stage1-search, stage1-behavioral, stage1-commenters |
| `GET /api/v1/profile/details` | 1 | stage2-enrich |
| `GET /api/v1/posts/all` | 1 | stage2-enrich |
| `GET /api/v1/search/posts` | 1 | stage1-behavioral, stage1-commenters |
| `GET /api/v1/posts/comments` | 1 | **stage1-commenters (Motore C)** |
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
| `parse-icp` | service | — | Router motore + filtri strutturati + postKeywordAlternatives |
| `stage1-search` | service | — | Motore A: search/people, chunked |
| `stage1-behavioral` | service | — | Motore B: search/posts autori, intent `offers` |
| `stage1-commenters` | service | — | **Motore C**: posts/comments commentatori, intent `expresses` |
| `stage2-enrich` | service | — | Bio + post, chunked |
| `score-profiles` | service | — | Scoring AI + seller cap in codice + dual-signal + DELETE adattiva |
| `process-search-job` | service | — | Un stage per call, routing A/B/C |
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
`start-search`, `get-job-status`, `process-search-job`, `process-pending-jobs`, `parse-icp`, `stage1-search`, `stage1-behavioral`, `stage1-commenters`, `stage2-enrich`, `score-profiles`, `get-searches`, `delete-search`, `get-credits`, `test-linkdapi`

### Deploy

```powershell
supabase functions deploy parse-icp --no-verify-jwt
supabase functions deploy stage1-search --no-verify-jwt
supabase functions deploy stage1-behavioral --no-verify-jwt
supabase functions deploy stage1-commenters --no-verify-jwt
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

> `stage1-commenters` richiede un `deno.json` nella sua cartella — copiarlo da `stage1-search`:
> `cp supabase/functions/stage1-search/deno.json supabase/functions/stage1-commenters/deno.json`

> Quando si modifica `_shared/lead-providers/linkdapi.ts`, rideploya **tutte** le function che lo importano:
> `stage1-search`, `stage1-behavioral`, `stage1-commenters`, `stage2-enrich`, `process-search-job`

### Test end-to-end

1. Login con piano **scout** o **bundle** (o trial waitlist attivo).
2. Utente **assistant** → redirect `/upgrade`.
3. Saldo crediti in header ≥ 100.
4. **Primo click Search** → popup `SearchTipsDialog` appare; "Got it, search" avvia la ricerca.
5. Secondo click (stessa sessione) → nessun popup, parte direttamente.
6. Nuova ricerca ICP classica → progress granulare: parsing → searching (12→38) → enriching (42→72) → scoring → done (4–8 min).
7. Verifica log `[parse-icp] filters`: `searchMode="profile"`, `geoUrns` mai vuoto.
8. Nuova ricerca ICP comportamentale `expresses` (es. "founders complaining about lead quality") → verifica `searchMode="behavioral"`, `postKeyword` valorizzato, `postKeywordAlternatives` array con 3-4 voci, `stage1-commenters` nei log.
9. Nuova ricerca ICP comportamentale `offers` (es. "agency founders who help B2B with cold outreach") → verifica `behavioralIntent="offers"`, `stage1-behavioral` nei log.
10. Log `stage1-commenters`: verifica `D role-mismatch` > 0 (filtro ruolo funziona), `[Posted X days ago]` nel `match_post`.
11. Log `score-profiles`: verifica `[score-profiles] DELETE threshold: 30` per ricerche `expresses`, `signals: index=N score=X comment=... bio=...`.
12. Risultati: solo profili con score ≥ soglia; verde ≥75, giallo 60–74, grigio 50–59.
13. Risultati con `match_reason` e `best_context` in **inglese** indipendentemente dalla lingua ICP.
14. Salva lead → `/leads` + `profili_salvati` con `source = scout`.
15. `/history` → View Results, Re-run, Delete.
16. Stesso ICP → risposta cached; crediti -100.
17. Crediti insufficienti → dialog 402.
18. Dark mode toggle.

### Test rate limiting

```sql
-- Verifica stato bucket
SELECT * FROM get_rate_limit_status();

-- Svuota bucket manualmente per testare throttling
UPDATE rate_limit_state SET tokens_available = 0;

-- Reset a pieno (bucket_size ora = 10)
UPDATE rate_limit_state SET tokens_available = 10, last_refill_at = NOW();
```

Nei log Edge Functions, righe tipo `[rate-limit:search/posts] token acquisito dopo Xms` indicano throttling attivo (normale). Righe `[linkdapi] 429 on ... retry N/3` indicano che il retry con backoff sta gestendo spike transitori.

### Test concorrenza

Aprire 3 tab/account e lanciare 3 ricerche simultaneamente. Il token bucket serializza le chiamate LinkdAPI — verificare che tutte e 3 completino senza `429` non-retriable nei log.

### Test pipeline ICP (debug)

- `supabase functions invoke test-linkdapi` — connettività API.
- Log Edge Functions per stage fallito (`search_jobs.error_message`, `status = failed`).
- Verificare `parsed_filters.searchMode` + `behavioralIntent` sul job dopo stage `start`.
- Confrontare `follower_count=-1` dopo stage1 vs `bio IS NULL` dopo stage2.
- Per `stage1-commenters`: verificare `[stage1-commenters] keyword "X": +N nuovi candidati (totale Y)` per ogni keyword provata.

---

## Note architetturali

### Timeout Edge Functions (150s)

La pipeline completa supera un singolo timeout. **Soluzione:** architettura chunked self-loop — ogni stage processa un sottoinsieme piccolo (12 overview per chunk, 6 enrich per chunk) e rilancia sé stesso via `next_stage`. Ogni invocazione dura ~15-60s, dentro i 150s.

> `stage1-commenters` con `MAX_POSTS_PAGES=1` e `TARGET_CANDIDATES=12` completa la fase 1 in ~20-40s. Se si alzano questi parametri, verificare di non superare i 150s.

### Rate limiting globale LinkdAPI

Un singolo account LinkdAPI ha un rate limit condiviso tra **tutti gli utenti** di Linky Scout. Il token bucket in Postgres (`rate_limit_state`) è la fonte di verità unica — tutte le Edge Functions che chiamano LinkdAPI passano per `consume_linkdapi_token()` via `acquireLinkdApiToken()`. La serializzazione avviene via `FOR UPDATE` sulla singola riga della tabella.

**Calibrazione tier Hobby** (30 req/min): `bucket_size=10` (ridotto da 25 per evitare burst concentrati), `refill_rate=0.4/s` (24/min). Il retry con backoff esponenziale (3 tentativi: 1s, 2s) in `#request()` gestisce i 429 transitori. Quando si upgradia il tier:
```sql
UPDATE rate_limit_state SET bucket_size=20, refill_rate_per_second=0.8;
```

### Tre motori di ricerca

| | Motore A (profile) | Motore B (behavioral authors) | Motore C (behavioral commenters) |
|---|---|---|---|
| Trigger | `searchMode: "profile"` (default) | `behavioral` + `intent: "offers"/"both"` | `behavioral` + `intent: "expresses"` |
| Sorgente | `search/people` | `search/posts` (autori) | `search/posts` → `posts/comments` (commentatori) |
| Candidati max | 40 | 25 | 12 (TARGET_CANDIDATES) |
| Profilo "vuoto" | DELETE su fallimento overview | TENUTO (ha `match_post` = testo post) | TENUTO (ha `match_post` = `[Posted X] commento`) |
| Filtro ruolo | Title match + blacklist nonprofit | Title match autore post | `buildRoleMatcher(title)` sull'headline del commentatore |
| Filtro seller | In score-profiles | In score-profiles | Layer 1c (in commento) + Layer 2 (headline) + score-profiles |
| Costo | ~89 crediti | ~80-90 crediti | ~44 crediti |
| Soglia DELETE | 50 | 50 | **30** (`expresses`) |
| Qualità | Buona per ICP ruolo/settore | Buona per chi vende soluzioni | Migliore per chi *vive* il problema; pool più piccolo per natura |
| Note | — | `authorJobTitle` passato a search/posts | `authorJobTitle` NON passato; `past-year` fisso; multi-keyword adattivo |

### Motore C — considerazioni di prodotto

Il Motore C produce **pochi lead di alta qualità** (tipicamente 1-8 per ricerca) per i seguenti motivi strutturali di LinkedIn: i decision-maker che vivono un problema raramente lo postano (costo reputazionale), ma lo commentano sotto post di altri. Questo è il comportamento che il motore cattura. Per ICP come "founders complaining about X", aspettarsi 1-5 lead per ricerca è normale, non un bug.

ICP più adatti al Motore C: role con alta tendenza a commentare (VP/Head of funzionali, manager operativi) su temi operativi (hiring, lead quality, CRM friction). ICP meno adatti: founder puri su temi strategici.

### Seller detection — architettura

La seller detection è a più livelli, applicati in cascata:

| Livello | Dove | Cosa cattura |
|---|---|---|
| Layer 1c commento | `stage1-commenters` in-memory | Competitor che pitchano nel commento stesso |
| Layer 2 headline | `stage1-commenters` in-memory | Venditori evidenti dall'headline |
| Layer 3 ruolo | `stage1-commenters` in-memory | Ruoli non-decision-maker (assistant, intern, ecc.) |
| score-profiles | Claude + enforcement in codice | Seller rilevati dalla bio/post. Cap a 30 se `expresses`. |

`is_selling_solution` è un campo obbligatorio nell'output di Claude. Il cap viene applicato **in codice TypeScript** (non affidato al modello), garantendo enforcement deterministico.

### Score dual-signal (Motore C)

Per i profili del Motore C, il commento può essere corto o generico ("SEND", "+1", "Interested") pur essendo un segnale valido di interesse di categoria. Lo scoring non deve punire il commento corto se la bio è on-ICP. La regola dual-signal:

- `comment_signal` = strong → 70-95
- `comment_signal` = weak/none + `bio_signal` = strong → 55-75 (buyer di categoria)
- Entrambi weak → 35-50
- Nessun segnale → sotto 35

Il seller cap (30) si applica a prescindere dai segnali.

### JWT custom vs Supabase client

Il JWT Scout non è un JWT Supabase nativo. Query su `searches` / `search_jobs` / `search_results` → Edge Functions + `SERVICE_ROLE_KEY` + verifica HMAC manuale.

### Caching 7 giorni

ICP normalizzato (ordine parole, no punteggiatura) → stesso hash. Bilancia costo API e freschezza.

### To-do post-lancio

1. **Concurrency limit nel dispatcher** — `process-pending-jobs` deve limitare i job pesanti (stage search/enrich) concorrenti. Con pochi utenti iniziali non è urgente.
2. **Zombie job cleanup** — marcare `failed` i job `running` con `started_at` > 15 minuti.
3. **Refund crediti su job failed** — nel catch di `process-search-job` quando setta `status=failed`.
4. **Logging costi reali** — sommare crediti da stage1+stage2 e salvarli nel job.
5. **Monitoring LinkdAPI** — leggere `/credits/balance/k/` prima/dopo ricerca per tracciare consumo reale.
6. **Score founder con poca attività** — profili con headline on-ICP ma zero post vengono penalizzati dallo scoring. Aggiungere istruzione al prompt: "se bio+headline coprono già il target, non penalizzare per scarsità di post".

### Miglioramenti futuri

1. **Industry mapping granulare** — linkdapi ha `/api/i/v1/g/industry-lookup` con lista completa. Attualmente mappati 22 settori hardcoded in parse-icp.
2. **Dynamic few-shot con dati reali** — popolare `icp-examples.ts` con esempi da ricerche produzione invece di sintetici.
3. **Selettore behavioral intent in UI** — oggi inferito da parse-icp; dopo il lancio aggiungere un selettore visuale nel form.
4. **Cache più intelligente** — hash su `parsed_filters` invece che su `icp_prompt` per cache hit su variazioni testuali dello stesso ICP.
5. **Retry stage2 su profili falliti** — i profili con `bio=""` (failed details) potrebbero essere retentati.
6. **Auto-sync rate limiter** — leggere `limit_per_minute` live da `/credits/tier/k/` invece di hardcodare `bucket_size`.
7. **Timestamp commento in UI** — `match_post` contiene già il prefisso `[Posted X days ago]` ma `best_context` (estratto da Claude) lo può omettere. Valutare campo `match_post_date` separato nel DB.
8. **`behavioralIntent: "both"` con merge** — oggi trattato come `"offers"` (YAGNI). Se emerge uso reale, implementare dual-stage con merge e dedup per `linkedin_urn`.

---

*Documento aggiornato al 2 giugno 2026 — allineato al codice in produzione dopo la sessione di sviluppo maggio-giugno 2026.*
