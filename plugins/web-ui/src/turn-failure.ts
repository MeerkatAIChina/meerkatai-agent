import { i18n } from "./locale/index.ts";

const NONE_SANDBOX_SIGNATURE = "SANDBOX_BACKEND=none";

export function humanizeTurnFailure(message: string): string {
  if (message.includes(NONE_SANDBOX_SIGNATURE)) {
    return String(
      i18n(
        "This machine has no working sandbox (WSL2 is not enabled), so conversations cannot run. Restart the app, click \"Enable sandbox\" on the launch page (admin approval required), then restart the computer.",
      ),
    );
  }
  return message;
}
