import { Hono } from "hono";
import { existsSync, mkdirSync, chmodSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { naracli, extractTxSignature } from "../naracli/wrapper";

export const masterWalletRoute = new Hono();

function masterPath(): string {
  return resolve(env.walletsDir, "..", "master-wallet.json");
}

function ensureDir() {
  mkdirSync(dirname(masterPath()), { recursive: true });
}

masterWalletRoute.get("/state", async (c) => {
  const path = masterPath();
  const exists = existsSync(path);
  if (!exists) {
    return c.json({ imported: false, address: null, balance: null });
  }
  const addr = await naracli.address({ walletPath: path });
  const bal = await naracli.balance({ walletPath: path });
  return c.json({
    imported: true,
    path,
    address: addr,
    balance: bal.nara,
  });
});

masterWalletRoute.post("/import", async (c) => {
  const body = await c.req.json<{ privateKey?: string; mnemonic?: string }>();
  if (!body.privateKey && !body.mnemonic) {
    return c.json({ error: "provide privateKey or mnemonic" }, 400);
  }

  ensureDir();
  const path = masterPath();

  // naracli wallet import writes to the -o path
  const args = ["wallet", "import", "-o", path];
  if (body.privateKey) args.push("-k", body.privateKey);
  if (body.mnemonic) args.push("-m", body.mnemonic);

  const r = await naracli.raw(args, { timeoutMs: 60_000, logScope: "master.import" });
  if (!r.ok) {
    return c.json({ error: r.stderr.slice(0, 300) || "import failed", stdout: r.stdout.slice(-200) }, 500);
  }

  try {
    chmodSync(path, 0o600);
  } catch {}

  const addr = await naracli.address({ walletPath: path });
  const bal = await naracli.balance({ walletPath: path });

  log({ level: "success", scope: "master-wallet", message: `Imported master wallet: ${addr}` });

  return c.json({ ok: true, path, address: addr, balance: bal.nara });
});

masterWalletRoute.post("/remove", async (c) => {
  const path = masterPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
      log({ level: "warn", scope: "master-wallet", message: "Master wallet file removed" });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }
  return c.json({ ok: true });
});

/**
 * Fund an agent wallet from the master wallet.
 * Body: { targetAddress: string, amount?: number }
 * If amount not provided, uses env.minWalletBalance.
 */
masterWalletRoute.post("/fund", async (c) => {
  const body = await c.req.json<{ targetAddress: string; amount?: number }>();
  if (!body.targetAddress) return c.json({ error: "targetAddress required" }, 400);

  const path = masterPath();
  if (!existsSync(path)) return c.json({ error: "master wallet not imported" }, 400);

  const amount = body.amount ?? env.minWalletBalance;
  const r = await naracli.transfer(body.targetAddress, amount, { walletPath: path, timeoutMs: 180_000 });

  if (!r.ok) {
    return c.json({ error: r.stderr.slice(0, 300) || "transfer failed", stdout: r.stdout.slice(-200) }, 500);
  }

  const tx = extractTxSignature(r.stdout);
  log({
    level: "success",
    scope: "master-wallet.fund",
    message: `Funded ${body.targetAddress.slice(0, 10)}… with ${amount} NARA`,
    meta: { tx },
  });

  return c.json({ ok: true, txSignature: tx, amount });
});
