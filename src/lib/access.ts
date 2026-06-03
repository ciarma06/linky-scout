export function canSaveLeads(plan: string | null | undefined): boolean {
  return plan === "assistant" || plan === "bundle";
}
