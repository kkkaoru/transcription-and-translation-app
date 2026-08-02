import type { WebSpeechController } from "./web-speech";

/**
 * Apply a language edit to the existing recognition controller.
 *
 * Keeping this operation separate from controller construction is deliberate:
 * the settings field can emit one React update per keystroke while a capture
 * session is active. The controller itself must remain the same instance so
 * that its browser event handlers, restart state, and pending finals survive
 * those edits.
 */
export const syncSpeechLanguage = (
  controller: Pick<WebSpeechController, "setLanguage"> | null,
  language: string,
): void => {
  controller?.setLanguage(language);
};
