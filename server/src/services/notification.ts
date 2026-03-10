export async function sendNotification(message: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_CHAT_ID) {
    console.log("📢 Test Notification, no token or chat id:", message);
    return;
  }
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_GROUP_CHAT_ID,
        text: message,
      }),
    }
  );
  if (!response.ok) {
    console.error(await response.json());
    console.error(response.statusText);
    return;
  }
  const data = await response.json();
}
