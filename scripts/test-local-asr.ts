import { chmod, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  ensureWarmedUp,
  filterHallucinatedSegments,
  transcribeWithWhisperCpp,
  type LocalAsrRequest,
  type LocalAsrResult,
} from "@/lib/local-asr";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cuemind-asr-test-"));
  try {
  const executable = join(root, "fake-whisper.sh");
  const wav = join(root, "sample.wav");
  const script = `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then output="$2"; shift 2; continue; fi
  shift
done
cat > "$output.json" <<'JSON'
{"transcription":[{"offsets":{"from":0,"to":1200},"text":" KV Cache "},{"offsets":{"from":1200,"to":2400},"text":" 提升吞吐 "}]}
JSON
printf 'ignored progress output\\n'
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  await writeFile(wav, createWavHeader(16_000, 1, 16, 16_000), undefined);

  const result = await transcribeWithWhisperCpp({
    whisperPath: executable,
    modelPath: join(root, "qwen-whisper-small.bin"),
    audioPath: wav,
    language: "zh",
  });

  assert.equal(result.text, "KV Cache 提升吞吐");
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1200, text: "KV Cache" },
    { startMs: 1200, endMs: 2400, text: "提升吞吐" },
  ]);
  assert.equal(result.audioDurationMs, 500);
  assert.equal(result.provider, "local-whisper");
  assert.equal(result.modelPath.endsWith("qwen-whisper-small.bin"), true);
  assert.equal(typeof result.latencyMs, "number");

  const output = await readFile(executable, "utf8");
  assert.match(output, /ignored progress output/);

  // --- filterHallucinatedSegments: blocklist, consecutive duplicates, keep normal ---
  const blocklisted = filterHallucinatedSegments([
    { startMs: 0, endMs: 1000, text: "谢谢观看" },
    { startMs: 1000, endMs: 2000, text: "字幕由Amara.org生成" },
    { startMs: 2000, endMs: 3000, text: "字幕by索兰娅" },
    { startMs: 3000, endMs: 4000, text: "请订阅 请点赞" },
    { startMs: 4000, endMs: 5000, text: "关注频道" },
    { startMs: 5000, endMs: 6000, text: "真实内容" },
  ]);
  assert.deepEqual(blocklisted, [{ startMs: 5000, endMs: 6000, text: "真实内容" }]);

  const repeated = filterHallucinatedSegments([
    { startMs: 0, endMs: 1000, text: "重复段" },
    { startMs: 1000, endMs: 2000, text: "重 复 段" },
    { startMs: 2000, endMs: 3000, text: "重复段" },
    { startMs: 3000, endMs: 4000, text: "结尾" },
  ]);
  assert.deepEqual(repeated, [
    { startMs: 0, endMs: 1000, text: "重复段" },
    { startMs: 3000, endMs: 4000, text: "结尾" },
  ]);

  const twoRepeatsKept = filterHallucinatedSegments([
    { startMs: 0, endMs: 1000, text: "短重复" },
    { startMs: 1000, endMs: 2000, text: "短重复" },
  ]);
  assert.equal(twoRepeatsKept.length, 2);

  const normal = filterHallucinatedSegments([
    { startMs: 0, endMs: 1000, text: "大家好" },
    { startMs: 1000, endMs: 2000, text: "今天讨论 Harness" },
    { startMs: 2000, endMs: 2000, text: "   " },
  ]);
  assert.deepEqual(normal, [
    { startMs: 0, endMs: 1000, text: "大家好" },
    { startMs: 1000, endMs: 2000, text: "今天讨论 Harness" },
  ]);

  // --- 2.3-b ASR 预热（ensureWarmedUp）：全部走注入 fake，不跑真模型 ---

  // 幂等：多次调用只触发一次底层转写，并共享同一缓存的 promise。
  const warmFake = makeWarmupFake();
  const warmupRequest: Pick<LocalAsrRequest, "whisperPath" | "modelPath" | "language"> = {
    whisperPath: "fake-whisper",
    modelPath: "fake-model.bin",
    language: "auto",
  };
  const warmPromiseA = ensureWarmedUp(warmupRequest, { transcribe: warmFake.fn });
  const warmPromiseB = ensureWarmedUp(warmupRequest, { transcribe: warmFake.fn });
  await warmPromiseA;
  await warmPromiseB;
  assert.equal(warmFake.requests.length, 1, "repeated warmup calls must trigger exactly one transcription");
  assert.equal(warmPromiseA, warmPromiseB, "repeated warmup calls must share the cached promise");
  assert.match(warmFake.requests[0].audioPath, /\.wav$/, "warmup must feed a WAV file to the transcriber");
  assert.equal(warmFake.requests[0].whisperPath, "fake-whisper");
  assert.equal(warmFake.requests[0].modelPath, "fake-model.bin");

  // 失败吞掉：fake 抛错时 promise 仍 resolve，不向调用方泄漏 rejection。
  const failingFake = makeWarmupFake(true);
  await assert.doesNotReject(
    ensureWarmedUp({ whisperPath: "fake-whisper", modelPath: "fake-model.bin", language: "auto" }, { transcribe: failingFake.fn }),
    "warmup failures must be swallowed (promise resolves)",
  );
  assert.equal(failingFake.requests.length, 1);

  // 并发共享：两个并发调用只触发一次底层转写（计数 = 1）。
  const concurrentFake = makeWarmupFake();
  await Promise.all([
    ensureWarmedUp({ whisperPath: "fake-whisper", modelPath: "fake-model.bin", language: "auto" }, { transcribe: concurrentFake.fn }),
    ensureWarmedUp({ whisperPath: "fake-whisper", modelPath: "fake-model.bin", language: "auto" }, { transcribe: concurrentFake.fn }),
  ]);
  assert.equal(concurrentFake.requests.length, 1, "concurrent warmup calls must share one transcription");

  // --- 2.3-c initial prompt argv 验收（空上下文 / 超长 glossary 截断） ---
  await testInitialPromptArgv();

  console.log("local ASR adapter assertions passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- 2.3-b 测试注入件：可计数的 transcribe fake（ensureWarmedUp deps 注入） ---

function makeWarmupFake(shouldThrow = false): {
  fn: typeof transcribeWithWhisperCpp;
  requests: LocalAsrRequest[];
} {
  const requests: LocalAsrRequest[] = [];
  const fn = async (request: LocalAsrRequest): Promise<LocalAsrResult> => {
    requests.push(request);
    if (shouldThrow) throw new Error("warmup fake failure");
    return {
      text: "",
      latencyMs: 0,
      audioDurationMs: null,
      realTimeFactor: null,
      segments: [],
      provider: "local-whisper",
      modelPath: request.modelPath,
    };
  };
  return { fn, requests };
}

// --- 2.3-c initial prompt argv 验收用例（master plan 2.3-c） ---

/**
 * 用记录 argv 的假 whisper 二进制验证 buildInitialPrompt 的两条契约：
 *   1. 空 glossary + 空 topic（无 promptContext）→ argv 不含 --prompt 参数；
 *   2. glossary 超长 → --prompt 值截断到 200 字符以内，且固定模板头保留、
 *      --carry-initial-prompt 照常携带。
 */
async function testInitialPromptArgv(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cuemind-asr-prompt-"));
  try {
    const argvLogPath = join(root, "whisper-argv.log");
    const executable = join(root, "fake-whisper-argv.sh");
    await writeFile(executable, `#!/bin/sh
set -eu
printf '%s\\n' "$@" > '${argvLogPath}'
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then output="$2"; shift 2; continue; fi
  shift
done
cat > "$output.json" <<'JSON'
{"transcription":[{"offsets":{"from":0,"to":1200},"text":" prompt "},{"offsets":{"from":1200,"to":2400},"text":" 截断 "}]}
JSON
`, "utf8");
    await chmod(executable, 0o755);
    const wav = join(root, "prompt-sample.wav");
    await writeFile(wav, createWavHeader(16_000, 1, 16, 16_000));

    const readArgv = async (): Promise<string[]> =>
      (await readFile(argvLogPath, "utf8")).split("\n").filter((line) => line.length > 0);

    // 用例 1：空 glossary + 空 topic → 不加 --prompt 参数。
    await transcribeWithWhisperCpp({
      whisperPath: executable,
      modelPath: join(root, "model.bin"),
      audioPath: wav,
      language: "zh",
    });
    const bareArgv = await readArgv();
    assert.equal(bareArgv.indexOf("--prompt"), -1, "empty topic+glossary must not add --prompt");

    // 用例 2：超长 glossary → --prompt 值长度 ≤ 200 字符，模板头保留。
    const longGlossary = Array.from({ length: 40 }, (_, index) => `术语${index}领域词长期保留`).join(",");
    await transcribeWithWhisperCpp({
      whisperPath: executable,
      modelPath: join(root, "model.bin"),
      audioPath: wav,
      language: "zh",
      promptContext: { glossary: longGlossary },
    });
    const glossaryArgv = await readArgv();
    const promptIndex = glossaryArgv.indexOf("--prompt");
    assert.notEqual(promptIndex, -1, "non-empty glossary must produce an initial prompt");
    const prompt = glossaryArgv[promptIndex + 1] ?? "";
    assert.ok(
      prompt.length > 0 && prompt.length <= 200,
      `prompt must be truncated to <= 200 chars, got ${prompt.length}`,
    );
    assert.match(prompt, /^以下是普通话的句子/, "truncation must keep the fixed template head");
    assert.notEqual(
      glossaryArgv.indexOf("--carry-initial-prompt"),
      -1,
      "prompt must be carried across segments",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createWavHeader(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

void main();
