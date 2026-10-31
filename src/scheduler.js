/**
 * scheduler.js — wakes up at the right second and says the thing.
 *
 * Deliberately dumb and durable: one timer, a scan of reminders.json, a
 * deliver-and-mark loop. If the machine was asleep when a reminder was due,
 * it fires on the next tick and says it was late rather than pretending the
 * time is still then.
 */
import { pendingReminders, updateReminder } from "./store.js";
import { sendTo } from "./outbound.js";
import { formatClock } from "./timeparse.js";
import { config } from "./config.js";

const TICK_MS = 15_000;
const LATE_GRACE_MS = 60_000;

let timer = null;
let log = console;

let inFlight = false;

export async function tick(now = new Date()) {
  // setInterval does not wait for the previous tick. A channel that takes
  // longer than 15 s to accept a message (a Telegram retry, a WhatsApp
  // reconnect) used to let the next tick see the same reminder still pending —
  // and deliver it again, because `fired` is only written after the send.
  if (inFlight) return 0;
  inFlight = true;
  try {
    return await deliverDue(now);
  } finally {
    inFlight = false;
  }
}

async function deliverDue(now) {
  const due = pendingReminders().filter((r) => new Date(r.at).getTime() <= now.getTime());
  for (const reminder of due) {
    const lateBy = now.getTime() - new Date(reminder.at).getTime();
    const late = lateBy > LATE_GRACE_MS
      ? ` _(late by ${Math.round(lateBy / 60000)} min — the machine was probably asleep)_`
      : "";
    const message = `⏰ **Reminder:** ${reminder.text}${late}`;

    let delivery = { ok: false, error: "no address" };
    if (reminder.address) delivery = await sendTo(reminder.address, message);

    if (!delivery.ok) {
      // Fall back to whatever channel is alive rather than dropping it.
      log.warn?.(`reminder ${reminder.id}: could not deliver to ${reminder.address} (${delivery.error})`);
      await sendTo("web:main", `${message}\n\n_(could not reach ${reminder.address || "the original channel"})_`);
    }
    updateReminder(reminder.id, { fired: true, firedAt: now.toISOString(), delivered: delivery.ok });
    log.info?.(`reminder fired: ${reminder.text}`);
  }
  return due.length;
}

export function startScheduler(logger = console) {
  log = logger;
  if (timer) return { stop: () => clearInterval(timer) };
  timer = setInterval(() => {
    tick().catch((err) => log.warn?.(`scheduler: ${err.message}`));
  }, TICK_MS);
  timer.unref?.();
  // Catch up immediately: a reminder that came due while Pinch was off.
  tick().catch(() => {});
  // Soonest first — pendingReminders() is insertion order, so [0] was
  // whichever reminder was created first, not whichever fires first.
  const next = pendingReminders().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  if (next) log.info?.(`scheduler: ${pendingReminders().length} reminder(s), next at ${formatClock(new Date(next.at), config.timezone)}`);
  return {
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
}
