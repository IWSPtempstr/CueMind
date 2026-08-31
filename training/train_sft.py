import argparse, json
from pathlib import Path
from common import read_jsonl, validate_rows, metadata
def main():
 p=argparse.ArgumentParser(); p.add_argument("--model",required=True); p.add_argument("--data",required=True); p.add_argument("--out",required=True); p.add_argument("--epochs",type=float,default=3); p.add_argument("--max-length",type=int,default=512); p.add_argument("--grad-accum",type=int,default=8); p.add_argument("--lr",type=float,default=2e-4); a=p.parse_args()
 rows=read_jsonl(a.data); validate_rows(rows); Path(a.out).mkdir(parents=True,exist_ok=True)
 from datasets import Dataset
 from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig, TrainingArguments
 from peft import LoraConfig
 from trl import SFTTrainer
 tok=AutoTokenizer.from_pretrained(a.model); tok.pad_token=tok.eos_token
 def fmt(r): return f"### Instruction\n{r.get('instruction','')}\n### Input\n{r['input']}\n### Output\n{json.dumps(r.get('output',{}),ensure_ascii=False)}"
 train=Dataset.from_list([r for r in rows if r['split']=='train']); ev=Dataset.from_list([r for r in rows if r['split']=='eval'])
 q=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_compute_dtype='bfloat16',bnb_4bit_use_double_quant=True)
 model=AutoModelForCausalLM.from_pretrained(a.model,quantization_config=q,device_map='auto')
 args=TrainingArguments(output_dir=a.out,num_train_epochs=a.epochs,per_device_train_batch_size=1,per_device_eval_batch_size=1,gradient_accumulation_steps=a.grad_accum,learning_rate=a.lr,bf16=True,gradient_checkpointing=True,evaluation_strategy='epoch',save_strategy='epoch',logging_steps=1,report_to=[])
 trainer=SFTTrainer(model=model,tokenizer=tok,args=args,train_dataset=train,eval_dataset=ev,formatting_func=fmt,max_seq_length=a.max_length,peft_config=LoraConfig(r=16,lora_alpha=32,lora_dropout=.05,target_modules=['q_proj','k_proj','v_proj','o_proj']))
 trainer.train(); trainer.save_model(a.out); tok.save_pretrained(a.out); Path(a.out,'manifest.json').write_text(json.dumps(metadata(a.model,[a.data],a),ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__': main()
