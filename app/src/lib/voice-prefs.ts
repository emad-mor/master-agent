// Shared TTS voice preference (Kokoro). The sidecar ships 54 voices; these are
// the English ones that read English text well. The choice is global (applies to
// every reply), persisted in localStorage, and read by the reader + companion
// when they call /api/speak. SSR-safe: getVoice() falls back to the default when
// there's no window.

export type VoiceOption = { id: string; label: string };

export const DEFAULT_VOICE = "af_heart";

export const VOICE_GROUPS: { group: string; voices: VoiceOption[] }[] = [
  { group: "American · Female", voices: [
    { id: "af_heart", label: "Heart" },
    { id: "af_bella", label: "Bella" },
    { id: "af_nicole", label: "Nicole" },
    { id: "af_aoede", label: "Aoede" },
    { id: "af_kore", label: "Kore" },
    { id: "af_sarah", label: "Sarah" },
    { id: "af_sky", label: "Sky" },
    { id: "af_nova", label: "Nova" },
    { id: "af_alloy", label: "Alloy" },
    { id: "af_jessica", label: "Jessica" },
    { id: "af_river", label: "River" },
  ] },
  { group: "American · Male", voices: [
    { id: "am_michael", label: "Michael" },
    { id: "am_adam", label: "Adam" },
    { id: "am_eric", label: "Eric" },
    { id: "am_liam", label: "Liam" },
    { id: "am_onyx", label: "Onyx" },
    { id: "am_puck", label: "Puck" },
    { id: "am_echo", label: "Echo" },
    { id: "am_fenrir", label: "Fenrir" },
    { id: "am_santa", label: "Santa" },
  ] },
  { group: "British · Female", voices: [
    { id: "bf_emma", label: "Emma" },
    { id: "bf_alice", label: "Alice" },
    { id: "bf_isabella", label: "Isabella" },
    { id: "bf_lily", label: "Lily" },
  ] },
  { group: "British · Male", voices: [
    { id: "bm_george", label: "George" },
    { id: "bm_daniel", label: "Daniel" },
    { id: "bm_fable", label: "Fable" },
    { id: "bm_lewis", label: "Lewis" },
  ] },
];

const ALL = VOICE_GROUPS.flatMap((g) => g.voices);
export const voiceLabel = (id: string): string => ALL.find((v) => v.id === id)?.label ?? id;

const KEY = "daryan.voice";
let current: string | null = null;

export function getVoice(): string {
  if (current === null) {
    try { current = (typeof window !== "undefined" && localStorage.getItem(KEY)) || DEFAULT_VOICE; }
    catch { current = DEFAULT_VOICE; }
  }
  return current;
}

export function setVoice(v: string): void {
  current = v;
  try { localStorage.setItem(KEY, v); } catch {}
}
