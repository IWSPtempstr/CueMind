import argparse,json,time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--adapter',required=True); p.add_argument('--input',required=True); p.add_argument('--out',required=True); a=p.parse_args()
Path(a.out).parent.mkdir(parents=True,exist_ok=True); Path(a.out).write_text(json.dumps({'adapter':a.adapter,'input':a.input,'status':'pending_live_replay','metrics':['quality','schemaValidity','latency','cache','gpu','cpu','vram','failureFinalState','recovery'],'startedAt':time.time()},indent=2)+'\n')
print(a.out)
