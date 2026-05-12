# Linky Scout — Workflow di sviluppo v2
*Aggiornato con tutte le migliorie implementate*

---

## Decisioni tecniche di base

| Componente | Scelta |
|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui |
| Font | Sora (titoli) + DM Sans (body) via next/font/google |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase Postgres (stesso progetto di Linky Assistant) |
| Auth | Stesso sistema OTP di Linky Assistant (request-otp + verify-otp) |
| Lead data | LinkdAPI (header auth: `x-linkdapi-apikey`) |
| AI | Claude Sonnet (`claude-sonnet-4-6`) via Edge Function |
| Hosting | Vercel (frontend) + Supabase (backend) |
| Job queue | Tabella `search_jobs` + Edge Function chain |
| Caching | Tabella `search_cache`, TTL 7 giorni, hash SHA-256 |

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

**0.6** — Se pnpm chiede di approvare build scripts → premi `a` per selezionare tutto → Invio

**0.7** — Avvia dev server per verificare:
```powershell
pnpm dev
```

**0.8** — Installa shadcn/ui:
```powershell
pnpm dlx shadcn@latest init
```
Scegli: Radix → Nova → Slate → Yes CSS variables

**0.9** — Installa componenti shadcn:
```powershell
pnpm dlx shadcn@latest add button input textarea card table badge progress dialog sheet separator avatar dropdown-menu sonner
```

**0.10** — Installa dipendenze:
```powershell
pnpm add @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk
```

**0.11** — Crea `.env.local` nella root:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
NEXT_PUBLIC_EDGE_FUNCTIONS_BASE_URL=https://xxx.supabase.co/functions/v1
```

**0.12** — Aggiungi al `tsconfig.json`:
```json
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "exclude": ["node_modules", "supabase/functions/**"]
}
```

**0.13** — Crea `supabase/functions/deno.json`:
```json
{
  "imports": { "@supabase/functions-js": "jsr:@supabase/functions-js@^2" },
  "compilerOptions": { "allowImportingTsExtensions": true }
}
```

**0.14** — Push su GitHub + deploy su Vercel

---

## FASE 1 — Database Setup (Supabase esistente di Linky)

**1.1** — Crea tabella `searches`:
```sql
CREATE TABLE searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  icp_prompt TEXT NOT NULL,
  parsed_filters JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**1.2** — Crea tabella `search_jobs`:
```sql
CREATE TABLE search_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INT DEFAULT 0,
  current_stage TEXT,
  parsed_filters JSONB,
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**1.3** — Crea tabella `search_results`:
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

**1.4** — Crea tabella `search_cache`:
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

**1.5** — Aggiungi colonna `source` a `profili_salvati` (tabella CRM di Linky Assistant):
```sql
ALTER TABLE profili_salvati ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'extension';
```

**1.6** — Abilita RLS su `searches`, `search_jobs`, `search_results`. **NON** su `search_cache`.

**1.7** — RLS policies (usano `user_id TEXT` non UUID):
```sql
-- Elimina policy esistenti se presenti
DROP POLICY IF EXISTS "Users see own searches" ON searches;
DROP POLICY IF EXISTS "Users see own jobs" ON search_jobs;
DROP POLICY IF EXISTS "Users see results of own searches" ON search_results;

-- Ricrea con TEXT comparison
CREATE POLICY "Users see own searches" ON searches
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see own jobs" ON search_jobs
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'email');

CREATE POLICY "Users see results of own searches" ON search_results
  FOR ALL USING (
    search_id IN (SELECT id FROM searches WHERE user_id = current_setting('request.jwt.claims', true)::json->>'email')
  );
```

> ⚠️ **Nota importante**: Le policy RLS con JWT custom non funzionano con il client browser (anon key). Usa sempre SERVICE_ROLE_KEY lato Edge Function per leggere/scrivere dati utente.

---

## FASE 2 — Layer di astrazione LinkdAPI

Struttura: `supabase/functions/_shared/lead-providers/`

**`types.ts`** — interfaccia astratta:
```typescript
export interface SearchFilters {
  keyword?: string;
  title?: string;
  geoUrns?: string[];
  industry?: string[];
  language?: string;
  count?: number;
}

export interface ProfileBasic {
  urn: string;
  url: string;
  fullName: string;
  headline: string;
  location: string;
}

export interface ProfileOverview {
  urn: string;
  followerCount: number;
}

export interface ProfileDetails {
  urn: string;
  bio: string;
  positions: Array<{ jobTitle: string; company: string; duration: string }>;
}

export interface Post {
  text: string;
  postedAt: string; // stringa relativa: "7h", "3d", "1mo"
  url?: string;
}

export interface LeadDataProvider {
  searchProfiles(filters: SearchFilters): Promise<ProfileBasic[]>;
  getProfileOverview(username: string): Promise<ProfileOverview>; // usa username, NON urn
  getProfileDetails(urn: string): Promise<ProfileDetails>;
  getRecentPosts(urn: string): Promise<Post[]>;
}
```

**`linkdapi.ts`** — implementazione concreta:
- Header auth: `x-linkdapi-apikey` (NON `x-api-key`)
- `searchProfiles` → `GET /api/v1/search/people` — risposta in `data.people`
- `getProfileOverview` → `GET /api/v1/profile/overview?username=...` — risposta root di `data`
- `getProfileDetails` → `GET /api/v1/profile/details?urn=...` — bio in `data.about`
- `getRecentPosts` → `GET /api/v1/posts/all?urn=...` — risposta in `data.posts`
- Tutti i metodi unwrappano `response.json().data` tramite `#request<T>`

**`index.ts`** — factory:
```typescript
export function getLeadProvider(): LeadDataProvider {
  const apiKey = Deno.env.get("LINKDAPI_KEY");
  if (!apiKey) throw new Error("Missing LINKDAPI_KEY");
  return new LinkdAPIProvider(apiKey);
}
```

**`cache.ts`** — caching layer:
```typescript
export function normalizeICP(prompt: string): string {
  return prompt.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).sort().join(" ");
}

export async function hashICP(prompt: string): Promise<string> { ... }

export async function getCachedResults(supabase, icpPrompt) { ... }

export async function setCachedResults(supabase, icpPrompt, results) {
  // TTL: 7 giorni
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}
```

---

## FASE 3 — ICP Parser

Edge Function `parse-icp`:
- Riceve `{ prompt: string }`
- Chiama Claude con `model: "claude-sonnet-4-6"`, `max_tokens: 500`
- Header Claude: `x-api-key` + `anthropic-version: "2023-06-01"`
- Restituisce filtri strutturati: `{ keyword, title, geoUrns[], language, maxFollowers, behavioralCriteria[] }`

---

## FASE 4 — Stadio 1: Filtro grossolano

Edge Function `stage1-search`:
- Riceve `{ searchId, filters }`
- `searchProfiles(filters, 100)` → 100 profili
- Per ognuno: `getProfileOverview(username)` — username estratto da `profile.url.split("/in/")[1]`
- Rate limiting: batch da 25 con `sleep(61000)` tra batch
- Filtra: `followerCount > maxFollowers` → scarta; headline non contiene title → scarta
- Max 50 sopravvissuti
- INSERT in `search_results` con `match_score = null`

---

## FASE 5 — Stadio 2: Enrichment profondo

Edge Function `stage2-enrich`:
- Riceve `{ searchId }`
- Legge candidati con `bio = null` da `search_results`
- Per ognuno: `getProfileDetails(urn)` + `getRecentPosts(urn).catch(() => [])`
- UPDATE `search_results` con `bio` e `recent_posts`
- Rate limiting: batch da 25 con `sleep(61000)`

---

## FASE 6 — Stadio 3: AI Scoring

Edge Function `score-profiles`:
- Riceve `{ searchId, icpPrompt }`
- Legge candidati da `search_results`
- Costruisce batch con bio + ultimi 3 post troncati a 300 char
- Chiama Claude: `model: "claude-sonnet-4-6"`, **`max_tokens: 8000`**
- Parsing robusto con fallback su JSON troncato
- UPDATE `search_results` con `match_score`, `match_reason`, `best_context`

---

## FASE 7 — Job Queue + Caching

### Edge Function `start-search`
- Riceve `{ icpPrompt, userEmail }`
- Controlla cache → se hit: **salva comunque in `searches`** poi restituisce `{ cached: true, results, searchId }`
- Se miss: INSERT in `searches` + `search_jobs` → restituisce `{ cached: false, jobId, searchId }`

### Edge Function `process-search-job` ⚠️ ARCHITETTURA CHAIN
**Non usa `await` in sequenza** — ogni stage chiama il successivo in fire-and-forget per evitare il timeout di 150s di Supabase.

Accetta `{ jobId, stage }` dove stage = `"start"` | `"search"` | `"enrich"` | `"score"` | `"finalize"`:

```
start → parse-icp → updateJob → fireNextStage("search", { filters })
search → stage1-search → updateJob → fireNextStage("enrich")
enrich → stage2-enrich → updateJob → fireNextStage("score")
score → score-profiles → updateJob → fireNextStage("finalize")
finalize → setCachedResults → updateJob(completed)
```

`fireNextStage` è fire-and-forget (NO await):
```typescript
function fireNextStage(jobId, nextStage, extras = {}) {
  fetch(`${SUPABASE_URL}/functions/v1/process-search-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ jobId, stage: nextStage, ...extras }),
  }); // NO await
}
```

### Edge Function `process-pending-jobs`
- Cron ogni minuto via `pg_cron`
- Prende il primo job `status = "pending"` ordinato per `created_at`
- Chiama `process-search-job` con `{ jobId, stage: "start" }` in fire-and-forget

### Edge Function `get-job-status`
Supporta due modalità:
1. **Polling per jobId**: `{ jobId }` → status del job, se completed include `results`
2. **Load per searchId**: `{ searchId }` (senza jobId) → carica direttamente i risultati da `search_results` + `icp_prompt` da `searches`

### Edge Function `get-searches`
- Verifica JWT custom con `AUTH_JWT_SECRET`
- Usa SERVICE_ROLE_KEY per bypassare RLS
- Restituisce `searches` con join `search_results(match_score)` per l'utente

### Edge Function `delete-search`
- Verifica JWT custom
- Cancella in ordine: `search_results` → `search_jobs` → `searches`

### Setup pg_cron:
```sql
SELECT cron.schedule(
  'process-pending-jobs',
  '* * * * *',
  $$ SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/process-pending-jobs',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ); $$
);
```

---

## FASE 8 — Frontend: Auth

Sistema auth identico a Linky Assistant:
- `src/lib/auth.ts` — `AuthState`, `saveAuth`/`getStoredAuth`/`clearAuth`, `requestOtp`, `verifyOtp`
- `src/lib/auth-context.tsx` — `AuthProvider` + `useAuth()` con `user`, `isLoading`, `login`, `logout`
- `src/app/login/page.tsx` — 3 stati: email → OTP → expired
- `src/proxy.ts` — pass-through (protezione client-side) ⚠️ si chiama `proxy.ts` non `middleware.ts` (deprecato in Next.js 16)
- `src/app/(protected)/layout.tsx` — route guard con redirect a `/login`

JWT viene salvato in `localStorage`. Chiamate alle Edge Functions usano `Authorization: Bearer ${user.jwt}`.

---

## FASE 9 — Frontend: Pagine

### Layout generale
- Sidebar fissa sinistra 260px con dark/light mode
- Font: Sora (titoli) + DM Sans (body)
- Colore brand: `#6d47f5`
- Dark mode implementato con `next-themes`, classe `dark` su `<html>`

### Pagine
- `/` — New Search: textarea ICP, chip prompt esempio, progress bar con stage, tabella risultati con sheet dettaglio
- `/history` — Search History: lista ricerche con "View Results", "Re-run", "Delete"
- `/leads` — Saved Leads: tabella `profili_salvati` condivisa con Linky Assistant, badge "Scout"/"Extension"
- `/settings` — Settings: info account, toggle tema, logout

### Componenti riutilizzabili
- `sidebar.tsx`
- `search-results-table.tsx` — include icona ExternalLink per aprire profilo LinkedIn
- `lead-detail-sheet.tsx`
- `score-badge.tsx` — verde ≥80, giallo 60-79, grigio <60
- `theme-toggle.tsx`

### Fix importanti implementati
- `formatRelativeDate` normalizza timestamp Supabase aggiungendo `Z` per forzare UTC
- Le query Supabase lato client NON funzionano con RLS custom JWT → usare sempre Edge Functions con SERVICE_ROLE_KEY
- CORS headers in tutte le Edge Functions chiamate dal frontend

---

## FASE 10 — Deploy & Testing

**Secrets Supabase** (Project Settings → Edge Functions):
```
SUPABASE_URL              (auto)
SUPABASE_SERVICE_ROLE_KEY (auto)
CLAUDE_API_KEY            (stesso di Linky Assistant)
LINKDAPI_KEY              (da LinkdAPI dashboard)
AUTH_JWT_SECRET           (stesso di Linky Assistant)
RESEND_API_KEY            (stesso di Linky Assistant)
```

**JWT Verification** — disabilitare per tutte queste functions:
- `start-search`, `get-job-status`, `process-search-job`, `process-pending-jobs`
- `parse-icp`, `stage1-search`, `stage2-enrich`, `score-profiles`
- `get-searches`, `delete-search`, `test-linkdapi`

**Lasciare JWT ON:**
- `request-otp`, `verify-otp` e tutte le Edge Functions di Linky Assistant

**Deploy commands:**
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
```

**Test end-to-end:**
1. Login con email esistente in `utenti_waitlist`
2. Nuova ricerca → verifica progress bar stages
3. Attendi completamento (2-4 minuti)
4. Verifica risultati con score e match reason
5. Salva un lead → verifica in `/leads` e in `profili_salvati` su Supabase
6. Vai in `/history` → verifica ricerca salvata
7. Click "View Results" → verifica caricamento risultati
8. Ripeti stessa ricerca → verifica `cached: true` istantaneo
9. Verifica dark mode toggle

---

## Note architetturali importanti

### Perché le Edge Functions hanno timeout
Supabase Edge Functions hanno un limite di **150 secondi** per invocazione. La pipeline completa richiede 3-4 minuti. Per questo `process-search-job` è implementato come **catena di stage indipendenti** — ogni stage chiama il successivo in fire-and-forget senza aspettare.

### Perché non usare il client Supabase lato frontend
Il JWT di Linky Scout è un JWT **custom** firmato con `AUTH_JWT_SECRET`, non un JWT Supabase nativo. Il client Supabase browser non sa come interpretarlo per la RLS. Tutte le query sui dati utente passano per Edge Functions che usano `SERVICE_ROLE_KEY` e verificano il JWT manualmente.

### Astrazione LinkdAPI
Tutto il codice che chiama LinkdAPI è isolato in `_shared/lead-providers/linkdapi.ts`. Se LinkdAPI chiude, si implementa un nuovo provider che rispetta l'interfaccia `LeadDataProvider` in `types.ts` e si cambia una riga in `index.ts`.

### Caching 7 giorni
Ricerche con lo stesso ICP (dopo normalizzazione) condividono la cache. Il TTL di 7 giorni bilancia freschezza dei dati e risparmio API. Anche le ricerche cached vengono salvate in `searches` per la history.
