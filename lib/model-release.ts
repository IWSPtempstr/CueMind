import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CandidateModel { version: string; modelHash: string; runtimeVersion: string; datasetVersion: string; shadow: { requests: number; errors: number; p95Ms: number } }
export interface ReleaseState { activeVersion: string | null; candidates: Record<string, CandidateModel>; history: Array<{ action: "release" | "rollback"; version: string | null; actor: string; at: string }> }
const FILE = ".cuemind-release.json";
function load(root: string): ReleaseState { try { const value = JSON.parse(readFileSync(path.join(root, FILE), "utf8")) as ReleaseState; return value; } catch { return { activeVersion: null, candidates: {}, history: [] }; } }
function save(root: string, state: ReleaseState): void { mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8"); }
export function readReleaseState(root: string): ReleaseState { return load(root); }
export function recordCandidate(root: string, candidate: CandidateModel): void { if (!candidate.version || !candidate.modelHash || !candidate.datasetVersion) throw new Error("candidate version, modelHash and datasetVersion are required"); const state = load(root); state.candidates[candidate.version] = candidate; save(root, state); }
export function decideRelease(root: string, version: string, actor: string): { status: "released"; version: string } { const state = load(root); if (!state.candidates[version]) throw new Error(`candidate not found: ${version}`); state.activeVersion = version; state.history.push({ action: "release", version, actor, at: new Date().toISOString() }); save(root, state); return { status: "released", version }; }
export function rollbackRelease(root: string, actor: string): { status: "rolled_back"; previousVersion: string | null } { const state = load(root); const previousVersion = state.activeVersion; state.activeVersion = null; state.history.push({ action: "rollback", version: previousVersion, actor, at: new Date().toISOString() }); save(root, state); return { status: "rolled_back", previousVersion }; }
