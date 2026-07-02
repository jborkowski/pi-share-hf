import { spawn } from "node:child_process";
import { readHfAccessToken } from "./hf.ts";

export async function runCommand(command: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      resolve({ ok: false, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--help"]);
  return result.ok || !result.stderr.includes("ENOENT");
}

export async function ensureStartupTools(command: string): Promise<void> {
  const missing: string[] = [];

  if (command === "collect" || command === "upload") {
    if (!readHfAccessToken()) {
      missing.push([
        "Missing Hugging Face access token.",
        "Set one of:",
        "  export HF_TOKEN=hf_xxx",
        "  export HUGGINGFACE_TOKEN=hf_xxx",
        "Or write the token to:",
        "  ~/.cache/huggingface/token",
        "Create a token at:",
        "  https://huggingface.co/settings/tokens",
        "The token needs write access to the target dataset repo.",
      ].join("\n"));
    }
  }

  if (command === "collect") {
    if (!(await commandExists("trufflehog"))) {
      const install = process.platform === "darwin"
        ? ["Install it with:", "  brew install trufflehog"]
        : [
            "Install it from the TruffleHog release artifacts or installation docs:",
            "  https://github.com/trufflesecurity/trufflehog",
          ];
      missing.push([
        "Missing required command: trufflehog",
        ...install,
      ].join("\n"));
    }
  }

  if (command === "review") {
    if (!(await commandExists("pi"))) {
      missing.push([
        "Missing required command: pi",
        "Install it with:",
        "  npm install -g @mariozechner/pi-coding-agent",
      ].join("\n"));
    }
  }

  if (missing.length > 0) {
    throw new Error(missing.join("\n\n"));
  }
}
