/** Compose className strings, dropping falsies. Tiny clsx replacement. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
