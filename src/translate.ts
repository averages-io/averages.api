// Advanced translation's server fallback, an Averages Plus perk.
// The browser translates class names, titles, posts and messages on the device when it can
// (public/js/averages-i18n.js). Only when it can't, and only if the student turned on
// "Translate on our server", it sends them here: the hosted m2m100 model translates them and we
// answer straight away. Nothing is stored and the text is never logged.

export const TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";
/** The app's languages, as the model names them. */
/** The app's languages, as the model names them: any of them to any other. */
export const TARGETS: Record<string, string> = { en: "english", es: "spanish", fr: "french", pt: "portuguese", de: "german", zh: "chinese" };
export const MAX_TEXTS = 40;
export const MAX_CHARS = 1000;
export const MAX_TOTAL = 12000;

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type TranslateBody = { to: string; texts: string[]; from: string[] };

const known = (l: unknown): l is string => typeof l === "string" && Object.prototype.hasOwnProperty.call(TARGETS, l);

/**
 * The request, checked: a known language and up to 40 texts of up to 1,000 characters (12,000 in all).
 * `from` is each text's language, as the browser found it (English when left out).
 */
export function checkTranslateBody(body: unknown): TranslateBody | { error: string } {
  const b = body as { to?: unknown; texts?: unknown; from?: unknown } | null;
  if (!b || typeof b !== "object") return { error: "invalid_body" };
  if (!known(b.to)) return { error: "unknown_language" };
  if (!Array.isArray(b.texts) || !b.texts.length) return { error: "no_texts" };
  if (b.texts.length > MAX_TEXTS) return { error: "too_many_texts" };
  let total = 0;
  for (const t of b.texts) {
    if (typeof t !== "string") return { error: "invalid_text" };
    if (t.length > MAX_CHARS) return { error: "text_too_long" };
    total += t.length;
  }
  if (total > MAX_TOTAL) return { error: "too_much_text" };
  let from: string[];
  if (b.from === undefined) from = b.texts.map(() => "en");
  else if (!Array.isArray(b.from) || b.from.length !== b.texts.length || !b.from.every(known)) return { error: "unknown_language" };
  else from = b.from as string[];
  return { to: b.to, texts: b.texts as string[], from };
}

/** Each text translated, in order. A text that fails, is blank or is already in that language comes back as "", and the app keeps the original. */
export async function translateAll(ai: AiBinding, to: string, texts: string[], from: string[] = texts.map(() => "en"), concurrency = 6): Promise<string[]> {
  const target = TARGETS[to];
  const out: string[] = new Array(texts.length).fill("");
  let next = 0;
  async function worker(): Promise<void> {
    while (next < texts.length) {
      const i = next++;
      const text = texts[i].trim();
      const source = TARGETS[from[i]] ?? "english";
      if (!text || source === target) continue;
      try {
        const r = (await ai.run(TRANSLATE_MODEL, { text, source_lang: source, target_lang: target })) as { translated_text?: unknown } | null;
        if (r && typeof r.translated_text === "string") out[i] = r.translated_text.trim();
      } catch {
        // leave this one untranslated
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}
