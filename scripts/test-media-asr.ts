import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertMediaToWav, MediaConvertError } from "@/lib/local-asr";

// Mock ffmpeg that validates required flags and writes a minimal valid mono 16kHz WAV.
const SUCCESS_FFMPEG_SH = `#!/bin/sh
set -eu
if ! printf '%s\\n' "$*" | grep -q -- '-ar 16000'; then
  echo "mock-ffmpeg: missing -ar 16000 argument" >&2
  exit 90
fi
if ! printf '%s\\n' "$*" | grep -q -- '-ac 1'; then
  echo "mock-ffmpeg: missing -ac 1 argument" >&2
  exit 91
fi
last=''
for arg in "$@"; do
  last="$arg"
done
node -e '
const fs = require("fs");
const out = process.argv[1];
const dataBytes = 32000;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0, "ascii");
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8, "ascii");
buf.write("fmt ", 12, "ascii");
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(16000, 24);
buf.writeUInt32LE(32000, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36, "ascii");
buf.writeUInt32LE(dataBytes, 40);
fs.writeFileSync(out, buf);
' "$last"
`;

const SLOW_FFMPEG_SH = `#!/bin/sh
sleep 30
`;

const FAILING_FFMPEG_SH = `#!/bin/sh
echo "mock-ffmpeg: invalid audio stream (cannot decode frame)" >&2
exit 1
`;

// 无音轨输入（如静音视频）时 ffmpeg 的典型 stderr。
const NO_AUDIO_FFMPEG_SH = `#!/bin/sh
echo "Output file #0 does not contain any stream" >&2
exit 1
`;

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function expectMediaConvertError(
  code: string,
  action: () => Promise<unknown>,
  contextMessage: string,
): Promise<MediaConvertError> {
  let thrown: unknown = null;
  let rejected = false;
  try {
    await action();
  } catch (caught) {
    rejected = true;
    thrown = caught;
  }
  assert.equal(rejected, true, `${contextMessage}: expected a rejection`);
  assert.equal(
    thrown instanceof MediaConvertError,
    true,
    `${contextMessage}: expected MediaConvertError with code "${code}", got ${String(thrown)}`,
  );
  const mediaError = thrown as MediaConvertError;
  assert.equal(mediaError.code, code, contextMessage);
  return mediaError;
}

async function testUnsupportedFormatRejected(root: string): Promise<void> {
  const input = join(root, "sample.avi");
  const output = join(root, "sample.wav");
  await writeFile(input, Buffer.alloc(0));

  const error = await expectMediaConvertError(
    "unsupported_media",
    () => convertMediaToWav(input, output),
    "avi input must be rejected before spawning any process",
  );
  assert.match(error.message, /mp4/, "unsupported_media message must list supported formats");
  assert.match(error.message, /webm/, "unsupported_media message must list supported formats");
  // No subprocess may have run for an unsupported extension.
  assert.equal(existsSync(output), false);
}

async function prepareCaseDir(root: string, prefix: string): Promise<{ dir: string; input: string; output: string }> {
  const dir = join(root, prefix);
  await mkdir(dir, { recursive: true });
  const input = join(dir, "sample.mp3");
  const output = join(dir, "sample-16k.wav");
  await writeFile(input, Buffer.alloc(0));
  return { dir, input, output };
}

async function testSuccessfulConversion(root: string): Promise<void> {
  const { dir, input, output } = await prepareCaseDir(root, "ok-");
  const ffmpegMock = join(dir, "ffmpeg-mock.sh");
  await writeExecutable(ffmpegMock, SUCCESS_FFMPEG_SH);

  const result = await convertMediaToWav(input, output, { ffmpegPath: ffmpegMock });
  assert.equal(result.wavPath, output);
  assert.equal(existsSync(output), true);
  // Mock WAV payload: 32000 bytes at mono 16kHz 16-bit -> exactly 1000 ms.
  assert.equal(result.originalDurationMs, 1000);
}

async function testTimedOutConversion(root: string): Promise<void> {
  const { dir, input, output } = await prepareCaseDir(root, "timeout-");
  const ffmpegMock = join(dir, "ffmpeg-mock.sh");
  await writeExecutable(ffmpegMock, SLOW_FFMPEG_SH);

  await expectMediaConvertError(
    "ffmpeg_timed_out",
    () => convertMediaToWav(input, output, { ffmpegPath: ffmpegMock, timeoutMs: 500 }),
    "hanging ffmpeg must be killed and reported as ffmpeg_timed_out",
  );
}

async function testFfmpegFailed(root: string): Promise<void> {
  const { dir, input, output } = await prepareCaseDir(root, "failed-");
  const ffmpegMock = join(dir, "ffmpeg-mock.sh");
  await writeExecutable(ffmpegMock, FAILING_FFMPEG_SH);

  const error = await expectMediaConvertError(
    "ffmpeg_failed",
    () => convertMediaToWav(input, output, { ffmpegPath: ffmpegMock }),
    "non-zero exit must be classified as ffmpeg_failed",
  );
  assert.match(error.message, /cannot decode frame/, "ffmpeg_failed message should carry a stderr summary");
}

async function testNoAudioTrackFriendlyMessage(root: string): Promise<void> {
  const { dir, input, output } = await prepareCaseDir(root, "no-audio-");
  const ffmpegMock = join(dir, "ffmpeg-mock.sh");
  await writeExecutable(ffmpegMock, NO_AUDIO_FFMPEG_SH);

  const error = await expectMediaConvertError(
    "ffmpeg_failed",
    () => convertMediaToWav(input, output, { ffmpegPath: ffmpegMock }),
    "no-audio-track stderr must map to the friendly no-audio-track message",
  );
  assert.match(error.message, /没有可用的音频轨道/, "message must carry the friendly Chinese copy");
  assert.match(error.message, /无法进行语音转写/, "message must explain the consequence");
  assert.match(error.message, /does not contain any stream/, "message must keep the truncated raw stderr summary");
}

async function testFfmpegNotFound(root: string): Promise<void> {
  const { input, output } = await prepareCaseDir(root, "enoent-");

  await expectMediaConvertError(
    "ffmpeg_not_found",
    () =>
      convertMediaToWav(input, output, {
        ffmpegPath: join(root, "missing-bin", "no-such-ffmpeg"),
      }),
    "spawn ENOENT must be classified as ffmpeg_not_found",
  );
}

async function runCase(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`failed - ${name}`);
    console.error(error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cuemind-media-asr-test-"));
  try {
    await runCase("unsupported format rejected with whitelist hint", () => testUnsupportedFormatRejected(root));
    await runCase("successful conversion through mock ffmpeg", () => testSuccessfulConversion(root));
    await runCase("slow ffmpeg reports ffmpeg_timed_out", () => testTimedOutConversion(root));
    await runCase("failing ffmpeg reports ffmpeg_failed", () => testFfmpegFailed(root));
    await runCase("no-audio-track stderr reports the friendly Chinese message", () => testNoAudioTrackFriendlyMessage(root));
    await runCase("missing ffmpeg binary reports ffmpeg_not_found", () => testFfmpegNotFound(root));
    console.log("media -> WAV conversion regression tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
