import argparse,json
from pathlib import Path
from common import read_jsonl
p=argparse.ArgumentParser(); p.add_argument('--data',required=True); p.add_argument('--baseline',required=True); p.add_argument('--candidate',nargs='+',required=True); p.add_argument('--out',required=True); a=p.parse_args()
rows=read_jsonl(a.data)
if any(r.get('split')=='freeze' for r in rows)==False: raise SystemExit('freeze comparison requires freeze split')
Path(a.out).parent.mkdir(parents=True,exist_ok=True); Path(a.out).write_text(json.dumps({'status':'pending_inference','split':'freeze','count':sum(r.get('split')=='freeze' for r in rows),'baseline':a.baseline,'candidates':a.candidate,'runOnce':True},indent=2)+'\n')
print(a.out)
