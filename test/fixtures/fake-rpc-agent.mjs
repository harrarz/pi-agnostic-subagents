import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const session = process.argv[process.argv.indexOf('--session') + 1];
let messages = existsSync(session) ? JSON.parse(readFileSync(session, 'utf8')) : [];
let pending = '';
let timer;
let options = {};
const decoder = new StringDecoder('utf8');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const answer = () => {
  writeFileSync(session, JSON.stringify(messages), { mode: 0o600 });
  emit({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text',text:messages.join(' | ')}]}});
  emit({type:'agent_end', willRetry:false});
  emit({type:'agent_settled', aborted:false});
};
process.stdin.on('data', (chunk) => {
  pending += decoder.write(chunk);
  for (;;) {
    const index = pending.indexOf('\n');
    if (index < 0) break;
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === 'prompt') {
      try { options = JSON.parse(command.message); } catch { options = {}; }
      messages.push(command.message);
      writeFileSync(session, JSON.stringify(messages), { mode:0o600 });
      if (options.write) appendFileSync(options.file ?? 'work.txt', options.write);
      emit({type:'agent_start'});
      if (options.earlyEnd) emit({type:'agent_end',willRetry:true});
      if (options.rejectPrompt) { emit({id:command.id,type:'response',command:'prompt',success:false,error:'rejected prompt'}); continue; }
      const ack = () => emit({id:command.id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
      if (options.lateAck) { answer(); setTimeout(ack, 100); }
      else { ack(); timer = setTimeout(answer, options.delayMs ?? 700); }
    } else if (command.type === 'steer') {
      if (command.message === 'reject') { emit({id:command.id,type:'response',command:'steer',success:false,error:'steer rejected'}); continue; }
      const ack = (disposition) => emit({id:command.id,type:'response',command:'steer',success:true,data:{disposition}});
      if (options.handleSteer) { ack('handled'); continue; }
      clearTimeout(timer);
      if (options.settleOnSteer) { answer(); ack('queued'); continue; }
      messages.push(command.message);
      ack('queued');
      timer = setTimeout(answer, 200);
    }
  }
});
process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
