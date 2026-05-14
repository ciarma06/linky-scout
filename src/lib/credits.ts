// Static credit amount for now. When the backend integration is ready,
// replace this with a fetch / hook that returns the user's real balance.
export const CURRENT_CREDITS = 1000;

export const GET_MORE_CREDITS_URL = "https://linkyassistant.com";

export function formatCredits(value: number): string {
  return value.toLocaleString("en-US");
}
