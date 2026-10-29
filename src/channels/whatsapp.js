/**
 * whatsapp.js — optional bridge over Baileys (WhatsApp Web protocol).
 *
 * ⚠️  This is the one unofficial channel in Pinch. Read this before enabling:
 *   • Automating a personal WhatsApp account violates WhatsApp's Terms of
 *     Service, and accounts have been banned for it.
 *   • Use a SECONDARY number you can afford to lose, never your main one.
 *   • Messages travel through WhatsApp's servers (obviously) — this channel is
 *     not end-to-end private from the service itself, only from third parties.
 *   • Baileys is an optional dependency: `npm install` pulls it, but if it is
 *     missing Pinch simply reports this channel as unavailable instead of
 *     crashing.
 *
 * Everything else about Pinch stays local; enable this only if you accept it.
 */
import { config } from "../config.js";
import { routeMessage } from "./router.js";
import { registerSender } from "../outbound.js";

export async function startWhatsApp(log = console) {
  if (!config.whatsapp.enabled) return null;

  let baileys;
  let qrcode;
  try {
    baileys = await import("@whiskeysockets/baileys");
  } catch {
    log.warn?.(
      "whatsapp: enabled but @whiskeysockets/baileys is not installed — run `npm install` " +
        "(or `npm run setup` and accept the WhatsApp step). Skipping this channel."
    );
    return null;
  }
  try {
    qrcode = (await import("qrcode-terminal")).default;
  } catch {
    qrcode = null;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = baileys;

  const authDir = `${config.dataDir}/whatsapp-auth`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const allowed = new Set(config.whatsapp.allowedNumbers.map((n) => n.replace(/\D/g, "")));
  let stopped = false;
  let sock;

  const jidNumber = (jid = "") => jid.split("@")[0].split(":")[0].replace(/\D/g, "");

  function connect() {
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        log.info?.("whatsapp: scan this QR with WhatsApp → Linked devices → Link a device");
        if (qrcode) qrcode.generate(qr, { small: true });
        else log.info?.(qr);
      }
      if (connection === "open") {
        registerSender("whatsapp", (target, text) => sock.sendMessage(target, { text }));
        log.info?.("whatsapp: linked ✔");
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        log.warn?.(`whatsapp: disconnected (${code ?? "?"})${loggedOut ? " — re-link required" : " — retrying in 4s"}`);
        if (!stopped && !loggedOut) setTimeout(connect, 4000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid || "";
        const number = jidNumber(from);
        const isGroup = from.endsWith("@g.us");

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.buttonsResponseMessage?.selectedButtonId ||
          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
          "";

        if (!text) {
          if (msg.message.audioMessage) {
            await sock.sendMessage(from, { text: "🦞 Voice notes aren't transcribed in the WhatsApp bridge yet — use the web panel mic, or set WHISPER_URL." }, { quoted: msg });
          }
          continue;
        }

        if (allowed.size && !allowed.has(number)) {
          log.warn?.(`whatsapp: ignoring unauthorised number ${number}`);
          continue;
        }
        if (isGroup && !allowed.size) continue; // never answer random groups when unlocked

        await sock.readMessages([msg.key]).catch(() => {});
        try {
          await routeMessage({
            channel: "whatsapp",
            text,
            sessionId: `whatsapp-${from}`,
            target: from,
            send: (t) => sock.sendMessage(from, { text: t }),
          });
        } catch (err) {
          await sock.sendMessage(from, { text: `🦞 Something jammed: ${err.message}` });
        }
      }
    });
  }

  connect();

  return {
    name: "whatsapp",
    stop() {
      stopped = true;
      try {
        sock?.end(undefined);
      } catch {}
    },
  };
}
