import argparse, json
from pathlib import Path
from common import read_jsonl, validate_rows, metadata
def main():
 p=argparse.ArgumentParser(); p.add_argument('--model',required=True); p.add_argument('--data',required=True); p.add_argument('--out',required=True); p.add_argument('--epochs',type=float,default=1); p.add_argument('--lr',type=float,default=5e-5); a=p.parse_args()
 rows=read_jsonl(a.data); validate_rows(rows,require_dpo=True); Path(a.out).mkdir(parents=True,exist_ok=True)
 from datasets import Dataset
 from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
 from trl import DPOTrainer, DPOConfig
 from peft import LoraConfig
 tok=AutoTokenizer.from_pretrained(a.model); tok.pad_token=tok.eos_token; train=Dataset.from_list([{'prompt':json.dumps(r['input'],ensure_ascii=False),'chosen':json.dumps(r['chosen'],ensure_ascii=False),'rejected':json.dumps(r['rejected'],ensure_ascii=False)} for r in rows if r['split']=='train']); ev=Dataset.from_list([{'prompt':json.dumps(r['input'],ensure_ascii=False),'chosen':json.dumps(r['chosen'],ensure_ascii=False),'rejected':json.dumps(r['rejected'],ensure_ascii=False)} for r in rows if r['split']=='eval'])
 q=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_compute_dtype='bfloat16',bnb_4bit_use_double_quant=True); model=AutoModelForCausalLM.from_pretrained(a.model,quantization_config=q,device_map='auto')
 cfg=DPOConfig(output_dir=a.out,num_train_epochs=a.epochs,per_device_train_batch_size=1,gradient_accumulation_steps=8,learning_rate=a.lr,bf16=True,gradient_checkpointing=True,evaluation_strategy='epoch',report_to=[])
 trainer=DPOTrainer(model=model,ref_model=None,args=cfg,train_dataset=train,eval_dataset=ev,tokenizer=tok,peft_config=LoraConfig(r=16,lora_alpha=32,lora_dropout=.05,target_modules=['q_proj','k_proj','v_proj','o_proj'])); trainer.train(); trainer.save_model(a.out); tok.save_pretrained(a.out); Path(a.out,'manifest.json').write_text(json.dumps(metadata(a.model,[a.data],a),ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__': main()
