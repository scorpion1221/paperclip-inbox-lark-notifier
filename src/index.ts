import pino from "pino";
import { PaperclipInboxLarkNotifier, loadNotifierConfig } from "./notifier.js";

async function main() {
  const config = loadNotifierConfig();
  const notifier = new PaperclipInboxLarkNotifier(config);
  await notifier.run();
}

void main().catch((err) => {
  const logger = pino({ level: "error" });
  logger.error({ err }, "paperclip inbox notifier failed");
  process.exitCode = 1;
});
