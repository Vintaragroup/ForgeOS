// The vocabulary shared by the sales queues' server and client halves.
//
// A leaf module on purpose: it imports nothing. The queue buttons are a
// client component, and importing these constants straight from
// sales-actions.ts would pull `db` -- and with it Prisma -- into the
// browser bundle. Same reason ai/assistant-contract.ts exists.

// The four queues on /sales. These strings are the SalesQueue enum's
// values; kept here as a plain union so a client component can name one
// without importing the generated Prisma enum.
export type SalesQueueKey = "FOLLOW_UP" | "PAST_DUE" | "STALLED_DEAL" | "WIN_BACK";

// What a rep can say they did. Deliberately the same words Salesmate uses
// in lastCommunicationMode, so logged and synced touches read alike.
export const TOUCH_MODES = ["Call", "Email", "Meeting", "Text", "Other"] as const;
export type TouchMode = (typeof TOUCH_MODES)[number];

// How a ClientTouch row was learned. The sync writes the first; a rep
// logging contact on their dashboard writes the second.
export const TOUCH_SOURCE_SYNCED = "SALESMATE_LAST_COMMUNICATION";
export const TOUCH_SOURCE_LOGGED = "LOGGED";

export const SNOOZE_PRESETS = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
] as const;
