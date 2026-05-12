# LinkdAPI — Documentazione Endpoint

Documentazione degli endpoint LinkdAPI usati in Linky Scout.

**Base URL:** `https://linkdapi.com`
**Auth header:** `x-linkdapi-apikey: YOUR_API_KEY`
**Pricing:** 1 credito per chiamata (salvo dove indicato diversamente)
**Rate limits:**
- Testing tier (0-99 crediti): 7 req/min
- Hobby tier (100+): 30 req/min
- Developer tier (10k+): 70 req/min
- Startup tier (30k+): 90 req/min

---

## 1. People Search

**Endpoint:** `GET /api/v1/search/people`
**Crediti:** 1

### Query Parameters

| Parametro | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `keyword` | string | No | Keyword generica di ricerca |
| `title` | string | No | Titolo lavorativo (es. "founder") |
| `geoUrn` | string | No | Geo IDs separati da virgola (es. "103644278,101165590") |
| `industry` | string | No | Industry IDs separati da virgola |
| `profileLanguage` | string | No | Lingua profilo (es. "en") |
| `currentCompany` | string | No | Company IDs separati da virgola |
| `pastCompany` | string | No | Company IDs separati da virgola |
| `firstName` | string | No | |
| `lastName` | string | No | |
| `school` | string | No | School IDs separati da virgola |
| `serviceCategory` | string | No | Service IDs |
| `count` | integer | No | Min 1, max 50 |
| `start` | integer | No | Offset paginazione |

### Geo URN comuni
| Paese | GeoURN |
|---|---|
| USA | 103644278 |
| UK | 101165590 |
| Germany | 101282230 |
| France | 105015875 |
| Italy | 103350119 |
| Spain | 105646813 |
| Netherlands | 102890719 |
| Canada | 101174742 |
| Australia | 101452733 |
| India | 102713980 |

### Response
```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "people": [
      {
        "urn": "ACoAAABhUGoBl6a8qJ3OFxx-aiBw_bx7Y4IqN6Y",
        "profileID": "6377578",
        "url": "https://www.linkedin.com/in/debangsu",
        "firstName": "Debangsu",
        "lastName": "S.",
        "fullName": "Debangsu S.",
        "headline": "Software Engineer at Google",
        "location": "Stanford, CA",
        "profilePictureURL": "https://...",
        "premium": false
      }
    ],
    "total": 1000,
    "start": 0,
    "count": 10,
    "hasMore": true
  }
}
```

### Note
- La risposta è in `data.people` (non `data.results`)
- `total: 1000` significa che ci sono più risultati — usa `start` per paginare
- Ogni pagina può restituire meno risultati del `count` richiesto perché profili non accessibili vengono filtrati automaticamente

---

## 2. Profile Overview

**Endpoint:** `GET /api/v1/profile/overview`
**Crediti:** 2

> ⚠️ Questo endpoint richiede `username` (slug dell'URL), NON l'URN.
> Estrai lo username dall'URL: `https://linkedin.com/in/kayachakmak` → `kayachakmak`

### Query Parameters

| Parametro | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `username` | string | ✅ | Username LinkedIn (slug dopo /in/) |

### Response
```json
{
  "success": true,
  "data": {
    "firstName": "Ryan",
    "lastName": "Roslansky",
    "fullName": "Ryan Roslansky",
    "headline": "CEO at LinkedIn",
    "publicIdentifier": "ryanroslansky",
    "followerCount": 887877,
    "connectionsCount": 8624,
    "creator": true,
    "qualityProfile": true,
    "joined": 1086269234000,
    "profileID": "678940",
    "urn": "ACoAAAAKXBwBikfbNJww68eYvcu2dqDYJhHbp4g",
    "CurrentPositions": [
      {
        "urn": "1337",
        "name": "LinkedIn",
        "url": "https://www.linkedin.com/company/linkedin/",
        "logoURL": "https://..."
      }
    ],
    "isTopVoice": true,
    "premium": true,
    "influencer": true,
    "location": {
      "countryCode": "US",
      "countryName": "United States",
      "city": "San Francisco Bay Area",
      "region": "San Francisco Bay Area",
      "fullLocation": "San Francisco Bay Area",
      "geoCountryUrn": "urn:li:fsd_geo:103644278",
      "geoRegionUrn": "urn:li:fsd_geo:90000084"
    },
    "backgroundImageURL": "https://...",
    "profilePictureURL": "https://..."
  }
}
```

### Campi chiave usati in Linky Scout
- `followerCount` — per il filtro hard sui follower
- `urn` — usato nelle chiamate successive a profile/details e posts/all

---

## 3. Profile Details

**Endpoint:** `GET /api/v1/profile/details`
**Crediti:** 1

### Query Parameters

| Parametro | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `urn` | string | ✅ | URN del profilo (da search/people o profile/overview) |

### Response
```json
{
  "success": true,
  "data": {
    "about": "Testo completo della bio...",
    "featuredPosts": [
      {
        "postLink": "https://www.linkedin.com/feed/update/...",
        "postText": "Testo del post in evidenza..."
      }
    ],
    "positions": [
      {
        "jobTitle": "Vice President - Software Engineering",
        "company": "JPMorganChase · Full-time",
        "location": "Mumbai, Maharashtra, India",
        "duration": "Apr 2010 - Present · 14 yrs 10 mos",
        "companyLink": "https://www.linkedin.com/company/1068/",
        "companyId": "1068",
        "jobDescription": "..."
      }
    ],
    "education": [
      {
        "duration": "2000 - 2004",
        "durationParsed": {
          "start": { "year": 2000, "month": 1, "day": 1 },
          "end": { "year": 2004, "month": 1, "day": 1 }
        },
        "university": "University of Mumbai",
        "universityLink": "https://...",
        "degree": "BE Computers, Computer Engineering",
        "description": null,
        "subDescription": null
      }
    ],
    "languages": {
      "languages": [
        { "Language": "English", "Level": "Full professional proficiency" }
      ],
      "deepLink": "https://..."
    }
  }
}
```

### Note
- La bio è nel campo `about` (NON `bio`, `summary`, o `description`)
- L'URN del profilo non è incluso nella risposta — usa quello passato in input

---

## 4. All Posts

**Endpoint:** `GET /api/v1/posts/all`
**Crediti:** 1

> Prima chiamata restituisce fino a 100 post. Chiamate successive (con `cursor`) restituiscono 20 post.

### Query Parameters

| Parametro | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `urn` | string | ✅ | URN del profilo |
| `cursor` | string | No | Cursor per paginazione (dalla risposta precedente) |
| `start` | integer | No | Legacy, non più in uso — usare `cursor` |

### Response
```json
{
  "success": true,
  "data": {
    "cursor": "dXJuOmxpOmFjdGl2aXR5OjcxN...",
    "posts": [
      {
        "text": "Testo del post...",
        "url": "https://www.linkedin.com/feed/update/urn:li:activity:7284419957050789888",
        "urn": "urn:li:activity:7284419957050789888",
        "author": {
          "name": "Nome Autore",
          "headline": "Headline",
          "urn": "urn:li:member:845693009",
          "url": "https://www.linkedin.com/in/username",
          "profilePictureURL": "https://..."
        },
        "postedAt": "7h",
        "edited": false,
        "engagements": {
          "totalReactions": 435,
          "commentsCount": 46,
          "repostsCount": 2,
          "reactions": [
            { "reactionType": "LIKE", "reactionCount": 297 },
            { "reactionType": "ENTERTAINMENT", "reactionCount": 130 }
          ]
        },
        "mediaContent": [
          { "type": "image", "url": "https://..." }
        ],
        "resharedPostContent": null
      }
    ]
  }
}
```

### Note
- `postedAt` è una **stringa relativa** ("7h", "3d", "1mo", "2yr") — NON un timestamp Unix
- I post sono in `data.posts`
- Se un profilo non ha post pubblici l'API può restituire un errore 400/500 — gestire con `.catch(() => [])`

---

## 5. All Comments

**Endpoint:** `GET /api/v1/comments/all` (sezione Comments)
**Crediti:** 1

### Query Parameters

| Parametro | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `urn` | string | ✅ | URN del profilo |

### Response
```json
{
  "success": true,
  "data": {
    "comments": [
      {
        "post": {
          "header": "Kaya Chakmak commented on this",
          "text": "Testo del post su cui ha commentato...",
          "url": "https://...",
          "urn": "urn:li:activity:...",
          "author": { "name": "...", "headline": "..." },
          "postedAt": { "timestamp": 1730000379187, "fullDate": "...", "relativeDay": "1yr" }
        },
        "comment": {
          "author": { "name": "Kaya Chakmak", "headline": "..." },
          "comment": "Testo del commento scritto dall'utente",
          "createdAt": 1730000369874,
          "permalink": "https://...",
          "edited": false,
          "engagements": { "totalReactions": 1, "commentsCount": 0 }
        }
      }
    ],
    "cursor": "dXJuOmxpOmFjdGl2aXR5OjcxN..."
  }
}
```

### Note
- Ogni elemento include sia il **post originale** che il **commento scritto dall'utente**
- `comment.comment` è il testo del commento
- `post.text` è il contesto del post su cui ha commentato
- Utile per analisi comportamentale avanzata (fase futura)

---

## Pattern di implementazione in Linky Scout

### Unwrapping automatico della risposta

Tutte le risposte LinkdAPI hanno la struttura `{ success, data: { ... } }`. Il metodo privato `#request<T>` nel provider unwrappa automaticamente:

```typescript
async #request<T>(endpoint: string, params = {}): Promise<T> {
  // ... fetch ...
  const json = await response.json() as { data: T };
  return json.data; // unwrap automatico
}
```

### Estrazione username dall'URL

```typescript
const username = profile.url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
```

### Gestione errori profili non accessibili

```typescript
try {
  const overview = await provider.getProfileOverview(username);
  // ...
} catch {
  return null; // profilo non accessibile, salta silenziosamente
}
```

### Rate limiting

```typescript
const BATCH_SIZE = 25;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
  const batch = profiles.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(async (p) => { ... }));
  
  if (i + BATCH_SIZE < profiles.length) {
    await sleep(61000); // 61 secondi tra batch
  }
}
```
