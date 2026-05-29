// supabase/functions/_shared/rate-limiter.ts

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const MAX_WAIT_MS = 90_000;      // Massima attesa per ottenere un token: 90s
const POLL_INTERVAL_MS = 500;    // Tra un tentativo e l'altro: 500ms

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquisisce un token dal bucket LinkdAPI. Blocca finché un token non è
 * disponibile o finché non scade il timeout (MAX_WAIT_MS).
 *
 * @param supabase Client Supabase (deve usare service role per chiamare la function)
 * @param label    Etichetta opzionale per i log (es. "stage1:overview")
 * @throws Error se il timeout scade prima che un token sia disponibile
 */
export async function acquireLinkdApiToken(
  supabase: SupabaseClient,
  label = "linkdapi",
): Promise<void> {
  const startTime = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const { data, error } = await supabase.rpc("consume_linkdapi_token");

    if (error) {
      throw new Error(`Rate limiter RPC failed: ${error.message}`);
    }

    if (data === true) {
      // Token ottenuto. Log solo se c'è stata attesa significativa.
      const waited = Date.now() - startTime;
      if (waited > 1000) {
        console.log(`[rate-limit:${label}] token acquisito dopo ${waited}ms (${attempts} tentativi)`);
      }
      return;
    }

    // Bucket vuoto: aspetta e riprova
    const elapsed = Date.now() - startTime;
    if (elapsed >= MAX_WAIT_MS) {
      throw new Error(
        `Rate limiter timeout: ${label} ha aspettato ${elapsed}ms senza ottenere un token`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Helper opzionale per loggare lo stato corrente del bucket.
 * Usalo a fine ricerca per capire quanto budget è rimasto.
 */
export async function logRateLimitStatus(
  supabase: SupabaseClient,
  label = "status",
): Promise<void> {
  const { data, error } = await supabase.rpc("get_rate_limit_status");
  if (error || !data || !data[0]) return;
  const s = data[0];
  console.log(
    `[rate-limit:${label}] tokens=${Number(s.tokens_available).toFixed(1)}/${s.bucket_size}, ` +
    `recupero pieno in ${Number(s.seconds_until_full).toFixed(0)}s, ` +
    `totale consumati=${s.total_consumed}`,
  );
}
