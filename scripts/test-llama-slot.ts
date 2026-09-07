// 槽位队列回归（D1/D4 修复验证）：withLlamaSlot 必须满足
// 1) 许可内并行、许可外串行：并发调用不超出 CUEMIND_LLAMA_SLOTS 许可数；
// 2) FIFO：排队调用按到达顺序拿许可；
// 3) 预算起算：每次调用的内部计时从拿到许可后才开始（排队不计入）；
// 4) 异常安全：某次调用抛错不影响后续调用拿许可；
// 5) Abort 语义：排队中被 abort 的调用直接出队（不烧许可），已拿的不受影响。
// 单许可语义（slots=1）沿用 D1/D4 时期的全部断言；双许可语义（slots=2，
// 与 cuemind-llama.service 的 -np 2 对应）单独验证并行度与 FIFO。

import assert from "node:assert/strict";
import { withLlamaSlot } from "@/lib/llama-cpp";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sets CUEMIND_LLAMA_SLOTS for the duration of one test; restores on exit. */
async function withSlots<T>(slots: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CUEMIND_LLAMA_SLOTS;
  process.env.CUEMIND_LLAMA_SLOTS = String(slots);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CUEMIND_LLAMA_SLOTS;
    else process.env.CUEMIND_LLAMA_SLOTS = previous;
  }
}

async function testSerialAndFifo(): Promise<void> {
  const events: string[] = [];
  const task = (name: string, delayMs: number): Promise<void> =>
    withLlamaSlot(async () => {
      events.push(`enter:${name}`);
      await sleep(delayMs);
      events.push(`exit:${name}`);
    });
  // a 先启动，b/c 随后排队：b 必须先于 c 拿槽。
  const a = task("a", 30);
  const b = task("b", 10);
  const c = task("c", 10);
  await Promise.all([a, b, c]);
  assert.deepEqual(events, ["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"]);
  console.log("serial + FIFO order passed:", events.join(" "));
}

async function testBudgetStartsAfterSlot(): Promise<void> {
  // 语义断言：fn（generateOpenAiCompatibleJson 的等价物，AbortController 在其内部
  // 创建）在拿到槽之前绝不能被调用——否则 10ms 预算会在 80ms 的持槽期内烧完。
  let holderEnteredAt = 0;
  let queuedEnteredAt = 0;
  const enqueueQueuedAt = performance.now();
  const holder = withLlamaSlot(async () => {
    holderEnteredAt = performance.now();
    await sleep(80);
    return "holder";
  });
  await sleep(10); // 确保 holder 先拿槽
  const queued = withLlamaSlot(async () => {
    queuedEnteredAt = performance.now();
    return "queued";
  });
  assert.equal(await queued, "queued");
  assert.equal(await holder, "holder");
  // 排队方必须等 holder 释放（~80ms）后才进入 fn：预算从拿槽起算。
  assert.ok(
    queuedEnteredAt - enqueueQueuedAt >= 70,
    `排队方 fn 应在持槽结束后才执行（差值 ${(queuedEnteredAt - enqueueQueuedAt).toFixed(1)}ms）`,
  );
  assert.ok(queuedEnteredAt >= holderEnteredAt + 70, "fn 调用与持槽期不得重叠");
  console.log("budget starts after slot acquisition passed");
}

async function testErrorDoesNotLeakSlot(): Promise<void> {
  await assert.rejects(
    withLlamaSlot(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const startedAt = performance.now();
  const result = await withLlamaSlot(async () => "next");
  assert.equal(result, "next");
  // 若槽泄漏，这次调用会挂起；保守再断言未发生长时间阻塞。
  assert.ok(performance.now() - startedAt < 1000, "异常后槽必须立即释放");
  console.log("error releases slot passed");
}

async function testAbortWhileQueued(): Promise<void> {
  // holder 占槽 60ms；queuer 排队并在 20ms 时 abort → 应立即以 AbortError
  // 拒绝（不等 holder），且不占用槽：后续的 follower 应在 holder 释放后立即拿槽。
  const holder = withLlamaSlot(async () => {
    await sleep(60);
    return "holder";
  });
  const controller = new AbortController();
  const queuer = withLlamaSlot(async () => "should-not-run", { signal: controller.signal });
  const rejectAt = performance.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(queuer, (error: unknown) => {
    assert.ok(error instanceof Error && error.name === "AbortError");
    return true;
  });
  const abortElapsed = performance.now() - rejectAt;
  assert.ok(abortElapsed < 50, `排队中 abort 应立即拒绝（实际 ${abortElapsed.toFixed(1)}ms）`);
  let followerEnteredAt = 0;
  const follower = withLlamaSlot(async () => {
    followerEnteredAt = performance.now();
    return "follower";
  });
  assert.equal(await holder, "holder");
  assert.equal(await follower, "follower");
  // follower 必须在 holder 结束（~60ms）后才能进入，证明 abort 的 queuer
  // 没有烧掉槽位（若它仍拿槽，follower 要等 queuer 的空 fn 也会晚一拍，
  // 这里用 holder 结束时间做锚点断言）。
  assert.ok(followerEnteredAt >= rejectAt + 55, "follower 应在 holder 释放后拿槽");
  console.log("abort while queued dequeues immediately passed");
}

async function testPreAbortedSignal(): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withLlamaSlot(async () => "never", { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  // 槽未被占用：下一个调用应立即成功。
  assert.equal(await withLlamaSlot(async () => "ok"), "ok");
  console.log("pre-aborted signal rejects without touching slot passed");
}

async function testAbortAfterHandoverIsNoop(): Promise<void> {
  // 已拿槽（无排队）后 signal 才 abort：调用自身照常完成，不被 slot 层拒绝。
  const controller = new AbortController();
  const task = withLlamaSlot(async () => {
    await sleep(20);
    controller.abort();
    return "done";
  }, { signal: controller.signal });
  assert.equal(await task, "done");
  assert.equal(await withLlamaSlot(async () => "next"), "next");
  console.log("abort after handover is no-op passed");
}

async function testDualPermitConcurrencyAndFifo(): Promise<void> {
  await withSlots(2, async () => {
    const events: string[] = [];
    const task = (name: string, delayMs: number): Promise<void> =>
      withLlamaSlot(async () => {
        events.push(`enter:${name}`);
        await sleep(delayMs);
        events.push(`exit:${name}`);
      });
    // a/b 各占一个许可并行；c/d 排队，且按到达顺序（c 先于 d）拿许可。
    const a = task("a", 60);
    await sleep(5); // 保证 a 先于 b 拿许可
    const b = task("b", 60);
    await sleep(5); // 保证 b 先于 c 排队
    const c = task("c", 10);
    await sleep(5);
    const d = task("d", 10);
    await Promise.all([a, b, c, d]);
    // 1) 并行度恰好为 2：a、b 持许可期间，c/d 未进入。
    assert.deepEqual(events.slice(0, 2), ["enter:a", "enter:b"], "a 与 b 应同时持许可");
    // 2) FIFO：c 在 d 之前拿许可。
    assert.ok(events.indexOf("enter:c") < events.indexOf("enter:d"), "排队必须 FIFO");
    // 3) c 等到 a/b 之一释放后才能进入。
    assert.ok(events.indexOf("enter:c") >= events.indexOf("exit:a") || events.indexOf("enter:c") >= events.indexOf("exit:b"), "c 必须等许可释放");
    console.log("dual-permit concurrency + FIFO passed:", events.join(" "));
  });
}

async function testQueueTimeout(): Promise<void> {
  await withSlotsAndQueueTimeout(1, 30, async () => {
    // holder 占许可 120ms；queuer 排队 30ms 后必须以队列超时错误拒绝，
    // 且不占许可：后续调用在 holder 释放后立即成功。
    const holder = withLlamaSlot(async () => {
      await sleep(120);
      return "holder";
    });
    const queuedAt = performance.now();
    await assert.rejects(
      withLlamaSlot(async () => "never"),
      (error: unknown) => {
        assert.ok(error instanceof Error && error.name === "LlamaSlotQueueTimeoutError");
        return true;
      },
    );
    assert.ok(performance.now() - queuedAt < 90, "排队超时应在 30ms 附近触发");
    assert.equal(await holder, "holder");
    assert.equal(await withLlamaSlot(async () => "after"), "after");
    console.log("queue timeout dequeues and rejects passed");
  });
}

/** Sets CUEMIND_LLAMA_SLOTS and the queue timeout for one test. */
async function withSlotsAndQueueTimeout<T>(
  slots: number,
  queueTimeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const previousSlots = process.env.CUEMIND_LLAMA_SLOTS;
  const previousTimeout = process.env.CUEMIND_LLAMA_QUEUE_TIMEOUT_MS;
  process.env.CUEMIND_LLAMA_SLOTS = String(slots);
  process.env.CUEMIND_LLAMA_QUEUE_TIMEOUT_MS = String(queueTimeoutMs);
  try {
    return await run();
  } finally {
    if (previousSlots === undefined) delete process.env.CUEMIND_LLAMA_SLOTS;
    else process.env.CUEMIND_LLAMA_SLOTS = previousSlots;
    if (previousTimeout === undefined) delete process.env.CUEMIND_LLAMA_QUEUE_TIMEOUT_MS;
    else process.env.CUEMIND_LLAMA_QUEUE_TIMEOUT_MS = previousTimeout;
  }
}

async function main(): Promise<void> {
  await withSlots(1, async () => {
    await testSerialAndFifo();
    await testBudgetStartsAfterSlot();
    await testErrorDoesNotLeakSlot();
    await testAbortWhileQueued();
    await testPreAbortedSignal();
    await testAbortAfterHandoverIsNoop();
    await testQueueTimeout();
  });
  await testDualPermitConcurrencyAndFifo();
  console.log("llama slot queue tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
