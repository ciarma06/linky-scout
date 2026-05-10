import { LinkdAPIProvider } from "./linkdapi.ts";
import type { LeadDataProvider } from "./types.ts";

export type { LeadDataProvider } from "./types.ts";
export type {
  Post,
  ProfileBasic,
  ProfileDetails,
  ProfileOverview,
  SearchFilters,
} from "./types.ts";
export { LinkdAPIProvider } from "./linkdapi.ts";

/**
 * Factory function that reads `LINKDAPI_KEY` from the environment and returns
 * a ready-to-use {@link LeadDataProvider} instance.
 *
 * @throws {Error} When `LINKDAPI_KEY` is not set in the environment.
 */
export function getLeadProvider(): LeadDataProvider {
  const apiKey = Deno.env.get("LINKDAPI_KEY");

  if (!apiKey) {
    throw new Error(
      "Missing required environment variable LINKDAPI_KEY. " +
        "Set it in your Supabase project secrets before calling getLeadProvider().",
    );
  }

  return new LinkdAPIProvider(apiKey);
}
