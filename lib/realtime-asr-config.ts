export type RealtimeAsrMode = "cli" | "streaming";

/** Streaming remains opt-in until real replay gates pass. */
export function getRealtimeAsrMode(env: NodeJS.ProcessEnv = process.env): RealtimeAsrMode {
  return env.CUEMIND_REALTIME_ASR === "streaming" ? "streaming" : "cli";
}
