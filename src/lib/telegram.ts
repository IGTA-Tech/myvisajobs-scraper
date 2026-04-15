export type AlertLevel = "critical" | "error" | "warning" | "info";

const ICONS: Record<AlertLevel, string> = {
  critical: "🚨",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

export async function sendTelegramAlert(
  level: AlertLevel,
  title: string,
  body: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] Skipping alert — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return;
  }

  const text = `${ICONS[level]} *${escapeMd(title)}*\n\n${escapeMd(body)}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error("[telegram] Failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[telegram] Error:", err);
  }
}

function escapeMd(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
