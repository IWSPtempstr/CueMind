export type RealtimeAsrMode = "cli" | "streaming";

/** Streaming remains opt-in until real replay gates pass. */
export function getRealtimeAsrMode(env: { CUEMIND_REALTIME_ASR?: string } = process.env as { CUEMIND_REALTIME_ASR?: string }): RealtimeAsrMode {
  return env.CUEMIND_REALTIME_ASR === "cli" ? "cli" : "streaming";
}
