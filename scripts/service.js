#!/usr/bin/env node
/**
 * scripts/service.js — "pinch service [--install]"
 *
 * Always-on means surviving a logout and a crash. This prints the correct
 * autostart definition for the machine you are on, and installs it on Linux
 * only when you explicitly ask (writing into systemd --user is reversible and
 * needs no root; Windows and macOS get copy-paste instructions instead of a
 * script that silently edits the registry).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const os = platform();
const install = process.argv.includes("--install");

const C = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

if (os === "linux") {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "pinch.service");
  const unit = `[Unit]
Description=Pinch 🦞 local AI assistant
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${NODE} ${join(ROOT, "src", "index.js")}
Restart=always
RestartSec=5
# Keep PATH so ollama and git are findable
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;

  console.log(`\n${C.coral("🦞  systemd user service")}\n`);
  if (install) {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, unit, "utf8");
    console.log(`  ${C.teal("✔")} wrote ${unitPath}`);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "inherit" });
      execSync("systemctl --user enable --now pinch", { stdio: "inherit" });
      console.log(`  ${C.teal("✔")} enabled and started`);
      console.log(`\n  ${C.dim("logs:")}  journalctl --user -u pinch -f`);
      console.log(`  ${C.dim("stop:")}  systemctl --user disable --now pinch\n`);
      console.log(`  ${C.gold("▲")} to keep it running after you log out: sudo loginctl enable-linger $USER\n`);
    } catch (err) {
      console.log(`  ${C.gold("▲")} wrote the unit but could not enable it: ${err.message}`);
      console.log(`    run: systemctl --user enable --now pinch\n`);
    }
  } else {
    console.log(C.dim("  Save this to ~/.config/systemd/user/pinch.service, then:"));
    console.log(C.dim("    systemctl --user daemon-reload && systemctl --user enable --now pinch\n"));
    console.log(unit);
    console.log(`  ${C.dim("Or let Pinch write it:")} ${C.bold("pinch service --install")}\n`);
  }
} else if (os === "darwin") {
  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.pinch.assistant.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pinch.assistant</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${join(ROOT, "src", "index.js")}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(ROOT, "pinch.log")}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, "pinch.log")}</string>
</dict>
</plist>
`;
  console.log(`\n${C.coral("🦞  launchd (macOS)")}\n`);
  console.log(C.dim("  Save as ~/Library/LaunchAgents/com.pinch.assistant.plist then:"));
  console.log(C.dim("    launchctl load -w ~/Library/LaunchAgents/com.pinch.assistant.plist\n"));
  console.log(plist);
  console.log(`  ${C.dim("stop:")} launchctl unload -w ${plistPath}`);
  console.log(`  ${C.dim("logs:")} tail -f ${join(ROOT, "pinch.log")}\n`);
} else if (os === "win32") {
  console.log(`\n${C.coral("🦞  Task Scheduler (Windows)")}\n`);
  console.log(C.dim("  Run once in PowerShell (no admin needed for a logon task):\n"));
  console.log(`  schtasks /Create /TN "Pinch" /SC ONLOGON /RL LIMITED ^
    /TR "\\"${NODE}\\" \\"${join(ROOT, "src", "index.js")}\\""\n`);
  console.log(`  ${C.dim("or, from the folder, a restart-on-crash loop that works on any OS:")}`);
  console.log(`  pinch supervise\n`);
  console.log(`  ${C.dim("remove:")} schtasks /Delete /TN "Pinch" /F\n`);
} else {
  console.log(`Unsupported platform: ${os}. Use your init system to run: ${NODE} ${join(ROOT, "src", "index.js")}`);
}

