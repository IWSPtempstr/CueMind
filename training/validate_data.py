import argparse, json
from common import read_jsonl, validate_rows
p=argparse.ArgumentParser(); p.add_argument("files", nargs="+"); a=p.parse_args()
summary={}
for f in a.files:
    rows=read_jsonl(f); validate_rows(rows, require_dpo="dpo" in f.lower()); summary[f]={"count":len(rows),"train":sum(r["split"]=="train" for r in rows),"eval":sum(r["split"]=="eval" for r in rows)}
print(json.dumps(summary,ensure_ascii=False,indent=2))
