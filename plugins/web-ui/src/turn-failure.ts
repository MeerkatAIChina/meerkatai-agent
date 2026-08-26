import { i18n } from "./locale/index.ts";

const NONE_SANDBOX_SIGNATURE = "SANDBOX_BACKEND=none";
const MISSING_API_KEY_SIGNATURE = /^No API key (found )?for /m;

export function humanizeTurnFailure(message: string): string {
  if (message.includes(NONE_SANDBOX_SIGNATURE)) {
    return String(
      i18n(
        "This machine has no working sandbox (WSL2 is not enabled), so conversations cannot run. Restart the app, click \"Enable sandbox\" on the launch page (admin approval required), then restart the computer.",
      ),
    );
  }
  if (MISSING_API_KEY_SIGNATURE.test(message)) {
    return String(
      i18n(
        "No API key is configured for the conversation model, so conversations cannot run. Open the settings page (gear icon), re-save the model provider's API address and key, then try again.",
      ),
    );
  }
  return message;
}
