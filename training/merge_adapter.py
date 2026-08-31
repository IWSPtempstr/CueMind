import argparse
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
p=argparse.ArgumentParser(); p.add_argument('--base',required=True); p.add_argument('--adapter',required=True); p.add_argument('--out',required=True); a=p.parse_args()
base=AutoModelForCausalLM.from_pretrained(a.base,torch_dtype='auto',device_map='cpu'); model=PeftModel.from_pretrained(base,a.adapter); model.merge_and_unload().save_pretrained(a.out,safe_serialization=True); AutoTokenizer.from_pretrained(a.base).save_pretrained(a.out); print(a.out)
