## Nara Bot Dashboard — User Guide

Panduan lengkap pakai dashboard bot Nara Chain. Open **https://nara.mystr.dev**.

---

## 🎯 Konsep Dasar

Dashboard ini adalah **operator panel untuk menjalankan bot Nara Chain** — bot yang punya wallet on-chain sendiri, register sebagai AI agent di AgentX, bind Twitter, stake, kerjain task harian (Daily X Post + Dragon Ball Hunt), dan kumpulin NARA rewards.

**Komponen:**
- **Master wallet** — wallet utama lo (punya banyak NARA). Dipakai buat modal fund agent + nerima hasil sweep.
- **Agents** — bot individu dengan wallet sendiri. Masing-masing register on-chain, bind X, stake, dan farm NARA.
- **Dragon Ball Hunt** — task utama, code muncul di DM AgentX, claim on-chain dapet 1-5 NARA.
- **Auto-distribute** — sweeper otomatis yang ngirim earnings agent balik ke master wallet.
- **AI Agent (chat)** — chatbot yang bisa jalanin semua tool di atas pakai natural language.

---

## 🚀 Flow Lengkap — Dari Nol Sampai Farming

### Step 0: Requirement

- Master wallet Nara dengan **minimal 0.5 NARA** (0.15 NARA per agent × jumlah agent + buffer)
- Private key atau mnemonic master wallet lo

### Step 1: Import Master Wallet

1. Buka **https://nara.mystr.dev/settings**
2. Di section "Master wallet", pilih **Private key** atau **Mnemonic**
3. Paste secret-nya
4. Klik **▸ Import wallet**

✅ Dashboard akan simpan wallet file di server (`/data/master-wallet.json`, chmod 600). Address + balance otomatis tampil.

### Step 2: Register Agent Baru

1. Pindah ke **/agents**
2. Isi:
   - **Agent ID**: 8-32 char, lowercase alphanumeric + hyphen. Contoh: `ryhn-bot-01`
   - **Display name**: optional
   - **Referral**: optional (kasih `pretnara-build` biar gue dapet referral 🙏)
3. Klik **+ Add agent**

Yang terjadi di backend:
- Record dibuat di DB lokal
- `naracli wallet create` → keypair baru di `/data/wallets/<agent-id>.json`
- Address muncul di panel hasil

### Step 3: Jalanin Full Flow

**Cara termudah:** di panel agent yang baru dibuat, klik **▸ Run full flow (auto-fund)**.

Flow-nya eksekusi 9 step otomatis:

| # | Step | Tool | Keterangan |
|---|---|---|---|
| 1 | check-wallet | `naracli address` | Verify wallet ada |
| 2 | fund-wallet | (auto-fund) | Kalau balance < 0.15, transfer dari master |
| 3 | register-agent | `naracli agent register --relay` | On-chain registration, gasless |
| 4 | bind-twitter | `naracli agent bind-twitter <url> --relay` | 1 NARA + 100 boost credit |
| 5 | stake | `agentx-cli stake 0.01` | Required buat Dragon Ball |
| 6 | submit-daily-tweet | `naracli agent submit-tweet <url> --relay` | 0.1 NARA + boost |
| 7 | check-dm-inbox | `agentx-cli dm-inbox` | Harvest Dragon Ball codes |
| 8 | claim-dragonballs | `agentx-cli code claim <code>` | Per code: 1-5 NARA |
| 9 | first-post-campaign | `naracli skills add agentx-first-post-campaign` | Install skill (manual post) |

Total durasi: ~2-5 menit per agent.

### Step 4: Pantau Progress

- **/logs** — SSE live stream semua command + output
- **/agents** — panel tiap agent, klik "steps" buat liat progress run terakhir
- **/dragonball** — list semua Dragon Ball codes yang ke-discover + status claim

### Step 5: Enable Auto-Distribute (Optional)

Kalau mau earnings otomatis balik ke master wallet tiap beberapa jam:

1. Di **/settings**, scroll ke "Auto-distribute earnings"
2. Centang **Enabled**
3. Set **Sweep target** (default: master wallet address)
4. Min balance: 0.5 NARA (sweep kalau balance agent >= ini)
5. Keep: 0.05 NARA (sisain di agent wallet buat rent)
6. Interval: 6 jam (atau sesuai mau lo)
7. Klik **Save config**

Bisa juga klik **▸ Run sweep now** buat trigger manual.

---

## 🔮 Dragon Ball Hunt — Task Utama

Dragon Ball = item virtual yang muncul di AgentX. Claim on-chain dapet 1-5 NARA (sering 3).

### 3 cara dapet code:

1. **Activity Lottery** — aktif di AgentX (post, like, comment, follow), random winner tiap 3 menit. DM 30 menit expire.
2. **Feed Signed** — panggil feed API dengan signature wallet, 3% chance dapet code per call. 30 menit expire.
3. **Quality Post** — post konten bagus di AgentX, kalau terpilih dapet code via DM. 12 jam expire, **wajib tweet buat claim**.

### Cara dashboard handle:

**Otomatis** (via `run_flow` atau cron):
- Step `check-dm-inbox` panggil `agentx-cli dm-inbox`
- Regex ekstrak code format `<8hex>.<22+alnum>` (contoh: `a8f3e2b1.7KxNpQ4wRvY2mTjDs`)
- Step `claim-dragonballs` loop semua code → `agentx-cli code claim <code>`
- Hasil disimpan di DB — lo bisa pantau di `/dragonball`

**Manual** (kalau lo dapet code dari X atau kanal lain):
1. Buka **/dragonball**
2. Section "Manual claim", pilih agent
3. Paste code `a8f3e2b1.7KxNpQ4wRvY2mTjDs`
4. (Optional) Paste tweet URL buat 2x boost reward
5. Klik **▸ Claim via agentx-cli**

### Boost 2x rewards:
- Post di X dengan **BOTH hashtags**: `#AgentXDragonBall` + `#AgentX`
- Include link AgentX post
- Paste tweet URL saat claim → reward jadi 2-10 NARA

### Limit harian:
- Activity + Feed: **10 claim/hari/agent** (gabungan)
- Quality: **3 claim/hari/agent**
- Reset UTC 00:00

---

## 🤖 AI Agent (Chat) — Natural Language Operator

Buka **/chat**, toggle mode ke **AGENT**.

AI bisa eksekusi 22 tool yang mencakup semua operasi dashboard. Pilih agent context dari dropdown, lalu chat biasa.

### Contoh prompt yang bisa lo pakai:

**Setup agent baru:**
```
buat agent baru nama "nara-farm-01" referral pretnara-build,
fund dari master, terus jalanin full flow
```
AI: create_agent → get_master_wallet_state → fund_agent_from_master → run_flow

**Harvest Dragon Ball semua agent:**
```
check dm inbox semua agent, claim semua dragon ball yang ke-detect
```
AI: list_agents → check_dm_inbox (untuk tiap agent aktif) → claim_dragonball (untuk tiap code valid)

**Consolidate earnings:**
```
sweep semua earnings balik ke master, kasih tau total
```
AI: get_distribute_state → run_distribute_now → report

**Debug agent stuck:**
```
agent ryhn-bot-01 kenapa lastRunStatus nya error?
```
AI: get_agent → get_recent_logs → analyze → explain

**Diagnose balance:**
```
cek balance semua agent, kasih tau yang perlu di-fund
```
AI: list_agents → get_balance (tiap agent) → summary dengan list

### Yang AI TIDAK bisa lakuin:

- ❌ **Print private key atau mnemonic** — hard-guarded di system prompt
- ❌ **Akses data user lain** — saat ini single-user, tapi system prompt udah siap untuk multi-user isolation (lo tinggal tempel middleware nanti)
- ❌ **Delete tanpa konfirmasi** — `delete_agent` butuh `confirm: true` explicit
- ❌ **Transfer besar tanpa konfirmasi** — AI diinstruksi minta confirm di chat dulu
- ❌ **Posting langsung ke X** — AI cuma generate tweet draft, lo post manual

---

## 📋 Full Tool Reference (untuk AI Agent)

### Read-only (safe, bisa dipanggil kapan aja)
| Tool | Fungsi |
|---|---|
| `list_agents` | List semua agent |
| `get_agent` | Detail satu agent |
| `get_balance` | On-chain balance agent wallet |
| `get_master_wallet_state` | Master wallet address + balance |
| `list_dragonball_claims` | History claim Dragon Ball |
| `get_recent_logs` | Log bot terakhir |
| `get_last_flow_run` | Progress run terakhir per agent |
| `list_flow_runs` | 20 run terbaru semua agent |
| `get_distribute_state` | Worker sweeper state |

### Write — Agent lifecycle
| Tool | Fungsi |
|---|---|
| `create_agent` | Create record + auto-generate wallet |
| `delete_agent` | Delete dari DB lokal (butuh confirm) |
| `register_agent_onchain` | `naracli agent register --relay` |

### Write — Flow orchestration
| Tool | Fungsi |
|---|---|
| `run_flow` | Full 9-step flow (fund + register + bind + stake + tweet + claim) |
| `cancel_flow` | Cancel running flow |

### Write — Wallet ops
| Tool | Fungsi |
|---|---|
| `fund_agent_from_master` | Transfer dari master → agent |
| `transfer_from_agent` | Transfer dari agent → destination (manual consolidate) |
| `run_distribute_now_for_agent` | Sweep satu agent ke master |
| `run_distribute_now` | Sweep semua agent (batch) |
| `configure_distribute` | Update sweeper settings |

### Write — Campaigns
| Tool | Fungsi |
|---|---|
| `bind_twitter` | `naracli agent bind-twitter` |
| `submit_daily_tweet` | `naracli agent submit-tweet` |
| `stake_on_agentx` | `agentx-cli stake` |
| `check_dm_inbox` | `agentx-cli dm-inbox` |
| `claim_dragonball` | `agentx-cli code claim` |
| `install_skill` | `naracli skills add <name>` |

### Write — AI
| Tool | Fungsi |
|---|---|
| `generate_tweet` | Draft tweet (gak post) |

---

## 🔒 Data Isolation (Multi-User Roadmap)

Saat ini dashboard **single-user**. Semua data visible di dashboard yang sama.

**Saat lo pasang auth portal nanti:**
1. Tambah `user_id` column di tabel `agents`, `bot_logs`, `dragonball_claims`, `flow_runs`, `chat_messages`
2. Wrap semua DB query dengan filter `WHERE user_id = :currentUser`
3. Agent wallet dir jadi `data/wallets/<user_id>/<agent-id>.json`
4. Master wallet jadi `data/masters/<user_id>.json`
5. AI system prompt udah siap — ada instruksi **"Never attempt to access other users' data"**

Tool handler juga siap di-augment:
```typescript
function resolveAgent(args, ctx) {
  const agent = getAgent(db, id);
  if (agent.userId !== ctx.userId) throw new Error("forbidden");  // ← tambah baris ini
  return agent;
}
```

---

## 🧪 Troubleshooting

**"insufficient balance: 0.1 NARA (need 0.15)"**
→ Master wallet kurang NARA atau auto-fund gak jalan. Cek /settings master balance, klik "Fund from master" manual di /agents.

**"twitter_not_bound" / claim gagal**
→ Run flow gagal di step bind-twitter. Pastiin tweet URL valid (format `https://x.com/user/status/id`). Retry run flow.

**"daily_claim_cap" saat claim Dragon Ball**
→ Udah 10 claim/hari. Tunggu UTC 00:00 reset.

**Flow stuck di "check-dm-inbox"**
→ Normal kalau inbox kosong. Bot aktif hunt di AgentX (post, like) nanti dapet DM.

**Agent "not found" di AI chat**
→ Agent context belum di-set. Pilih di dropdown atau kasih `agentId` eksplisit: "untuk agent ryhn-bot-01, check balance".

**Master wallet "not imported" padahal sudah di-import**
→ Refresh /settings page. Kalau masih, cek file `/var/www/nara/data/master-wallet.json` di VPS.

---

## ⚙️ Maintenance

**Update dashboard dari GitHub:**
```bash
ssh customer@192.151.150.34
cd /var/www/nara
git pull
pnpm install
pnpm --filter @nara-bot/web build
pm2 restart nara-daemon nara-web
```

**Backup wallets:**
```bash
tar -czf /tmp/nara-wallets-$(date +%Y%m%d).tgz /var/www/nara/data/
```

**Check logs:**
```bash
pm2 logs nara-daemon --lines 100
pm2 logs nara-web --lines 50
```

---

## 📞 Feedback

Kalau ada masalah atau request fitur, buka issue di https://github.com/ryhnxyz/nara/issues.
