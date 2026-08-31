import argparse, json
from pathlib import Path
from common import read_jsonl, validate_rows
p=argparse.ArgumentParser(); p.add_argument('--data',required=True); p.add_argument('--adapter',required=True); p.add_argument('--out',required=True); a=p.parse_args()
rows=read_jsonl(a.data); validate_rows(rows); eval_rows=[r for r in rows if r['split']=='eval']
Path(a.out).parent.mkdir(parents=True,exist_ok=True)
Path(a.out).write_text(json.dumps({'adapter':a.adapter,'split':'eval','count':len(eval_rows),'status':'pending_inference','note':'Run model-specific generation and score JSON/schema here; no freeze data read.'},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(a.out)
