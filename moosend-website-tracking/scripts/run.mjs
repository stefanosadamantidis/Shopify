// Runs a command with the Windows crypto warm-up preloaded into every Node
// child process (needed by esbuild-wasm). No-op wrapper on other platforms.
// Usage: node scripts/run.mjs <command> [...args]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/run.mjs <command> [...args]");
  process.exit(1);
}

const env = { ...process.env };
if (process.platform === "win32") {
  // NODE_OPTIONS treats backslashes as escapes, so use forward slashes.
  const warmup = fileURLToPath(new URL("./crypto-warmup.cjs", import.meta.url)).replace(/\\/g, "/");
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require "${warmup}"`.trim();
}

const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
const child =
  process.platform === "win32"
    ? spawn([command, ...args].map(quote).join(" "), { stdio: "inherit", env, shell: true })
    : spawn(command, args, { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
