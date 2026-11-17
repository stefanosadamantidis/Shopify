import { execSync } from "node:child_process";

// Creates a fresh, isolated SQLite schema for the test run (never touches dev.sqlite).
export default function setup() {
  execSync("npx prisma db push --force-reset --skip-generate", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:./test.sqlite" },
  });
}
