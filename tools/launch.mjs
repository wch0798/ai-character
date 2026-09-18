import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(toolsDir);
const isWindows = process.platform === "win32";
const action = process.argv[2] === "stop" ? "stop" : "launch";

const command = isWindows ? "powershell.exe" : "bash";
const script = isWindows
  ? path.join(toolsDir, `${action === "stop" ? "stop" : "launch"}-ai-character.ps1`)
  : path.join(toolsDir, `${action === "stop" ? "stop" : "launch"}-ai-character.sh`);
const args = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
  : [script];

const child = spawn(command, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 1));
