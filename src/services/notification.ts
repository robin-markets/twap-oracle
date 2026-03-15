const DEDUP_WINDOW_MS = 1 * 60 * 1000; // 5 minutes
const recentMessages = new Map<string, number>();

export async function sendNotification(message: string) {
    // Deduplication: skip if same message was sent within the window
    const now = Date.now();
    const lastSent = recentMessages.get(message);
    if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
        return;
    }
    recentMessages.set(message, now);

    // Clean up old entries periodically
    if (recentMessages.size > 200) {
        for (const [msg, ts] of recentMessages) {
            if (now - ts >= DEDUP_WINDOW_MS) recentMessages.delete(msg);
        }
    }

    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_CHAT_ID) {
        console.log('Notification (no telegram configured):', message);
        return;
    }
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        headers: {
            'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_GROUP_CHAT_ID,
            text: message,
        }),
    });
    if (!response.ok) {
        console.error(await response.json());
        console.error(response.statusText);
    }
}
