from __future__ import annotations
import hashlib, json, os, subprocess, platform
from pathlib import Path

ALLOWED = {"train", "eval"}
def read_jsonl(path: str | Path):
    rows=[]
    for n,line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(),1):
        if not line.strip(): continue
        try: rows.append(json.loads(line))
        except Exception as e: raise ValueError(f"invalid JSON at {path}:{n}") from e
    return rows
def validate_rows(rows, *, require_dpo=False):
    if not rows: raise ValueError("empty dataset")
    for row in rows:
        if row.get("split") not in ALLOWED: raise ValueError("freeze or invalid split detected")
        if row.get("humanConfirmed") is not True: raise ValueError("human confirmation required")
        if not row.get("input"): raise ValueError("input missing")
        if require_dpo and not row.get("chosen") or require_dpo and not row.get("rejected"): raise ValueError("DPO chosen/rejected missing")
    if not any(r["split"] == "train" for r in rows): raise ValueError("train split empty")
    if not any(r["split"] == "eval" for r in rows): raise ValueError("eval split empty")
def sha256_file(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""): h.update(block)
    return h.hexdigest()
def git_commit():
    try: return subprocess.check_output(["git","rev-parse","HEAD"], text=True).strip()
    except Exception: return "unknown"
def metadata(base_model, data_files, args):
    import torch
    return {"baseModel":base_model,"dataFiles":[str(x) for x in data_files],"dataSha256":{str(x):sha256_file(x) for x in data_files},"gitCommit":git_commit(),"promptVersion":os.getenv("CUEMIND_PROMPT_VERSION","unknown"),"schemaVersion":os.getenv("CUEMIND_SCHEMA_VERSION","unknown"),"hardware":{"platform":platform.platform(),"gpu":torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu","cuda":torch.version.cuda,"torch":torch.__version__},"trainingArgs":vars(args)}
