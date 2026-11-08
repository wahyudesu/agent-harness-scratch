# minimal browser agent harness 

minimal agent utk demonstrasiin cara kerja agent, sama seperti claude, openai punya harness via codex, tapi kali ini kita bikin sratch tanpa framework agent. tools utama yg kita pakai chromium utk kontrol browser dan TUI di
`minimal-agent/opentui` adalah konsumen referensinya.

```
agent/minimal-agent/
├── api/                       server Hono (target produksi)
│   ├── src/index.ts           route: /api/models, /api/run, /api/tools, …
│   └── src/harness/
│       ├── 1-model.ts         client provider, katalog model
│       ├── 2-context.ts       system prompt, daftar tool, pemangkasan
│       ├── 3-guardrails.ts    batas iterasi/konteks, komposisi
│       ├── 4-tools.ts         definisi tool + executor
│       ├── 5-loop.ts          loop inferensi
│       ├── 6-harness.ts       sesi per-attempt + verify/retry
│       ├── browser.ts         sesi Playwright (backend chromium)
│       └── exa.ts             sesi API Exa (backend exa)
├── opentui/                   client terminal (ambil daftar model dari API)
├── docker-compose.yml         stack produksi
└── README.md
```

terminal ui ini gw bikin fully vibe coding. Kalau by scratch udh pasti slop, jadi pengembangannya sama kayak web: build on top of component biar hasilnya lebih better. Gw pakenya [termcn.dev](https://termcn.dev).

Ada rekomen lainnya juga di [brainless.swerdlow.dev](https://brainless.swerdlow.dev) buat komponen yg niru Claude Code, Codex, Grok.

https://term.ink buat alternative opentui nya

---

## 1. Model

Konfigurasi di sini pakai prinsip OOP: tiap konfigurasi ditaruh di class-nya sendiri. Begitu juga komponen harness lainnya nanti — tools, guardrails, dan seterusnya.

> The fastest way to call or interface with an AI model programmatically is by using the official lightweight SDK/library provided directly by your LLM provider (such as the official openai, anthropic, or google-genai SDKs) rather than heavy wrapper or orchestration frameworks.

```typescript
import OpenAI from "openai";

export const getClient = (): OpenAI =>
  new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });
```

Katalog model juga didefine di sini, karena API yang pegang datanya dan client tinggal fetch — bukan hardcode id model:

```typescript
export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  efforts: Effort[];
};

export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", provider: "Groq", efforts: ["low", "medium", "high"] },
];
```

Nambah model cukup satu baris; picker TUI dan opsi `/effort` ikut otomatis.
`efforts: []` artinya model itu tidak menerima `reasoning_effort`, jadi request
untuknya tidak usah menyertakan field tersebut.

## 2. Tools

Tool itu cara agent "bertindak". Satu tool = nama + deskripsi (buat model paham kapan pakainya) + fungsi yang benar-benar menjalankan aksinya.

Ada dua set tool yang bisa dipilih:

| Pilihan | Tools | Cocok untuk |
| --- | --- | --- |
| `chromium` (default) | buka URL, baca halaman, klik, isi form | alur yang butuh interaksi UI (login, klik tombol) |
| `exa` | cari web, ambil isi halaman | riset — lebih murah, tidak perlu browser |

Contoh satu tool, `browser_navigate`:

```typescript
// api/src/harness/4-tools.ts
{
  // Ini yang dilihat model: nama, deskripsi, parameter
  definition: fn(
    "browser_navigate",
    "Navigate the browser to a URL.",
    { url: { type: "string" } },
    ["url"],
  ),
  // Ini yang benar-benar jalan saat model memanggilnya
  execute: async ({ url }) => session.navigate(url as string),
}
```

Di baliknya, `browser_navigate` cuma membungkus Playwright (library kontrol browser):

```typescript
// api/src/harness/browser.ts
async navigate(url: string, timeoutMs = 15000): Promise<string> {
  await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  return `Navigated to ${url}`;
}
```

Backend `exa` sama principalnya, hanya browser-nya diganti panggilan API ke Exa — agent tidak tahu bedanya, dia cuma memanggil nama tool.

## 3. Context

Context = semua yang model "lihat" saat menjawab: instruksi, task, dan hasil-hasil tool.

Dua hal yang diurus di sini:

**1. Kasih tahu model tool apa saja yang tersedia.** Kalau tidak, model bisa mengarang nama tool dan request langsung ditolak provider. Jadi daftar tool diinject ke system prompt:

```typescript
// api/src/harness/2-context.ts
const availableTools = toolNames?.length
  ? `You have EXACTLY these tools — never call any tool not in this list:
${toolNames.map((n) => `- ${n}`).join("\n")}`
  : "";
```

**2. Pangkas context yang sudah panjang.** Semakin lama agent bekerja, semakin banyak pesan menumpuk dan makin mahal panjangnya. Solusinya sederhana: simpan instruksi + task awal, buang percakapan tool paling lama duluan:

```typescript
// api/src/harness/2-context.ts
if (messages.length <= maxMessages) return messages;
const [system, user] = messages;              // instruksi + task selalu dipertahankan
const rest = messages.slice(2);
return [system, user, ...rest.slice(rest.length - (maxMessages - 2))]; // sisanya: ambil yang terbaru
```

## 4. Guardrails

Tiap cek itu fungsi murni `input -> ok | {reason}`. Komposisinya berhenti di
kegagalan pertama; alasannya jadi jawaban run dengan `stoppedBy: "guardrail"`.

```typescript
// api/src/harness/3-guardrails.ts
export function maxIterations(
  limit: number,
): (input: { iterations: number }) => { ok: true } | { ok: false; reason: string } {
  return ({ iterations }) =>
    iterations >= limit
      ? { ok: false, reason: `Guardrail: reached iteration limit (${limit})` }
      : { ok: true };
}

export function combineGuardrails(...fns: GuardrailFn[]): GuardrailFn {
  return (input) => {
    for (const check of fns) {
      const result = check(input);
      if (!result.ok) return result;
    }
    return { ok: true };
  };
}

export const defaultGuardrails = combineGuardrails(maxIterations(15), maxMessages(50));
```

## 5. Agent loop

Satu iterasi = satu panggilan model. `finish_reason` yang menentukan langkah
berikutnya: `stop` mengakhiri run, `tool_calls` mengeksekusi semua panggilan,
meng-append tiap hasil sebagai pesan `tool`, lalu loop lagi. Tiap iterasi
di-trace (beserta ukuran konteks) supaya pemanggil bisa menampilkan apa yang
terjadi.

```typescript
// api/src/harness/5-loop.ts
const streaming = Boolean(hooks.onAnswerDelta);

while (true) {
  signal?.throwIfAborted();
  const iterationIndex = trace.length + 1;

  // ── Pemangkasan konteks ───────────────────
  const beforeTrim = messages.length;
  messages = trimContext(messages, MAX_CONTEXT_MESSAGES);
  const contextTrimmed = messages.length < beforeTrim;

  // ── Cek guardrail ─────────────────────────
  const check = guardrail({ iterations: trace.length, messages });
  if (!check.ok) {
    // Ruang habis, tapi model sudah punya bukti: minta satu jawaban terakhir
    // tanpa tools, supaya run tidak berakhir cuma dengan pesan guardrail.
    const finalMessages: ChatCompletionMessageParam[] = [
      ...messages,
      {
        role: "user",
        content: "You are out of tool budget. Answer the original task now using only what you already gathered. If something is unverified, say so.",
      },
    ];
    const final = await getClient().chat.completions.create(
      { model, messages: finalMessages, ...(effort ? { reasoning_effort: effort } : {}) },
      { signal },
    );
    const answer = final.choices[0]?.message.content ?? check.reason;
    hooks.onAnswer?.(answer);
    return { answer, iterations: trace.length, trace, stoppedBy: "guardrail" };
  }

  // ── Panggilan model ───────────────────────
  const request = {
    model,
    messages,
    tools: tools.definitions,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
  // Mode streaming (kalau ada hooks.onAnswerDelta): bikin request yang sama dengan
  // `stream: true`, gabungkan chunk lewat collectStream(), lalu buang pesan tool
  // call yang argumen JSON-nya rusak dan minta ulang — jangan pernah mengirim
  // history yang tidak valid ke provider.

  const response = await getClient().chat.completions.create(request, { signal });
  const choice = response.choices[0];
  const contextSize = messages.length;

  messages.push(choice.message as ChatCompletionMessageParam);

  if (choice.finish_reason === "stop") {
    trace.push({ index: iterationIndex, outcome: "answer", toolEvents: [], contextSize, contextTrimmed });
    const answer = choice.message.content ?? "(no response)";
    hooks.onAnswer?.(answer);
    return { answer, iterations: trace.length, trace, stoppedBy: "model" };
  }

  if (choice.finish_reason === "tool_calls") {
    await executeToolCalls(choice.message, iterationIndex, messages, tools, hooks, trace, {
      contextSize,
      contextTrimmed,
    });
  }
}
```

Eksekusi tool-nya menangani dua hal yang mudah bikin run mati: argumen yang
terpotong mid-JSON (stream bisa memutusnya) dan nama tool yang dikarang model.
Dua-duanya dibalas sebagai pesan `tool` berisi `Error: …`, bukan dilempar,
supaya model bisa memperbaiki diri di iterasi berikutnya:

```typescript
// api/src/harness/5-loop.ts (executeToolCalls)
let malformed: string | null = null;
try {
  args = JSON.parse(call.function.arguments || "{}");
} catch {
  malformed = call.function.arguments.slice(0, 200);
}

const tool = tools.byName.get(name);
let result: string;
try {
  result = malformed
    ? `Error: arguments for "${name}" were not valid JSON (${JSON.stringify(malformed)}). Call it again with complete arguments.`
    : tool
      ? await tool.execute(args)
      : `Error: unknown tool "${name}". Use only: ${[...tools.byName.keys()].join(", ")}`;
} catch (err) {
  result = `Error: ${err instanceof Error ? err.message : String(err)}`;
}

messages.push({ role: "tool", tool_call_id: call.id, content: result });
```


## 6. Verifikasi dan retry

Verifikasi jalan sekali per attempt dan bisa memveto jawaban. `fatal` melewati
retry kalau retry memang tidak akan menolong — misalnya ketika semua panggilan
tool sudah gagal.

```typescript
// api/src/harness/6-harness.ts
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const result = await runHarnessAttempt(task, model, options);
  const verification = options.verify ? options.verify(result) : null;
  const answer = verification && !verification.passed ? verification.reason : result.answer;
  const final = { ...result, answer, attempts: attempt, verification };

  if (!verification || verification.passed || verification.fatal || attempt === maxAttempts) {
    return final;
  }
}
```

Verifier bawaan mewajibkan minimal satu panggilan tool yang sukses, karena tugas
browser yang dijawab tanpa menyentuh browser biasanya tidak berpijak pada data:

```typescript
// api/src/index.ts
const verifyToolCallHappened = (result: LoopResult): VerifyResult => {
  const events = result.trace.flatMap((iteration) => iteration.toolEvents);
  const successful = events.find((event) => !event.result.startsWith("Error:"));
  return successful
    ? { passed: true, reason: `Tool call confirmed: ${successful.tool}` }
    : { passed: false, reason: "No successful tool call found", fatal: events.length > 0 };
};
```

## 7. Permukaan HTTP

```typescript
// api/src/index.ts
app.get("/api/models", (c) => c.json({ default: DEFAULT_MODEL, models: MODELS }));

app.post("/api/run", async (c) => {
  const body = RunRequest.parse(await c.req.json());   // zod, 400 kalau input salah
  if (!isKnownModel(body.model)) return c.json({ error: "unknown model" }, 400);
  // …cek dukungan effort, lalu runHarness() dengan AbortController
});
```

| Method | Path | Kegunaan |
| --- | --- | --- |
| `GET` | `/api/models` | Katalog model + model default (yang dirender client) |
| `GET` | `/api/tools?provider=chromium\|exa` | Nama tool untuk backend itu, plus daftar provider |
| `POST` | `/api/run` | Jalankan task; balikin answer, trace, attempts, verification |
| `DELETE` | `/api/runs/:id` | Batalkan run yang sedang jalan |
| `GET` | `/health` | Liveness probe (Docker `HEALTHCHECK`) |

## 8. Sisi client

Client terminal tidak menyimpan daftar model sendiri:

```typescript
// minimal-agent/opentui/src/index.tsx
useEffect(() => {
  void (async () => {
    const res = (await apiFetch("/api/models")) as { default: string; models: ApiModel[] };
    setModels(res.models);
    setModel((current) => current || res.default);
  })();
}, []);
```

Field `efforts` di tiap model menggerakkan picker `/effort`, dan request
menghilangkan `effort` untuk model yang tidak menerima apa pun. `/tools`
membuka picker backend, dan nilai yang dipilih dikirim sebagai `tools` di setiap
run.

Skill yang dipakai membangun backend Exa di-vendor di
`minimal-agent/.agents/skills/build-with-exa`
(`npx skills add exa-labs/agent-skills --skill build-with-exa`); di situ
didokumentasikan tiap endpoint Exa dan jebakan bentuk request-nya.

---

## Cara menjalankan

```bash
cd agent/api
cp .env.example .env          # isi OPENAI_API_KEY (Groq)
bun i && bun run dev    # http://localhost:3000

cd ../opentui
bun i && bun run dev    # API_URL default-nya http://localhost:3000
```

prod

`docker compose up -d --build` dari `agent/minimal-agent/` — 

