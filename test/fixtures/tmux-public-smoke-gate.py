#!/usr/bin/env python3
"""One narrow public dispatch smoke. Oracle fixed in Larra11968/11969 before edits."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('accepted_oracle',HERE/'tmux-team-validation-gate.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior)
identity=prior.identity
# Reuse only the accepted pure comparator, never its six live scenarios.
result_oracle=prior.result_oracle
BASE=Path('/srv/devops/scratch/clankers-tmux-public-smoke-20261105')
BASE.mkdir(exist_ok=True,mode=0o700)
ROOT=Path(tempfile.mkdtemp(prefix='cps-',dir='/srv/devops/scratch'));os.chmod(ROOT,0o700)
WHOLE=time.monotonic()+250
phase=min(WHOLE-15,time.monotonic()+30)
saved={};parent=None;natural=False;failure=None;cleanup=[];checks=[]

def dump(p,v):
    p.write_text(json.dumps(v));os.chmod(p,0o600)
def load(p):
    try:return json.loads(p.read_text())
    except (FileNotFoundError,json.JSONDecodeError):return None
def collect():
    todo=[os.getpid()];seen=set(todo)
    while todo:
        pid=todo.pop()
        try:children=Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        except FileNotFoundError:continue
        for c in map(int,children):
            if c in seen:continue
            seen.add(c);assert len(seen)<100,'descendant_cap'
            stamp=identity(c)
            if stamp:saved.setdefault(c,stamp);todo.append(c)
def artifacts():return [p for p in (ROOT/'workers').rglob('*') if p.name in ['control.sock','tmux.sock','ready.json','config.json']]
def gone():
    collect();return not any(identity(pid)==stamp for pid,stamp in saved.items() if parent is None or pid!=parent.pid) and not artifacts()
def reset():
    global phase
    phase=min(WHOLE-15,time.monotonic()+30)
def wait(fn,label):
    while time.monotonic()<phase:
        collect();v=fn()
        if v:return v
        time.sleep(.04)
    raise AssertionError(label)
def call(q):
    assert parent.poll() is None,'parent_exited'
    parent.stdin.write((json.dumps(q)+'\n').encode());parent.stdin.flush();data=b''
    while time.monotonic()<phase:
        collect()
        if not select.select([parent.stdout],[],[],.04)[0]:continue
        chunk=os.read(parent.stdout.fileno(),65536);assert chunk,'parent_eof';data+=chunk
        assert len(data)<1048576,'response_cap'
        if data.endswith(b'\n'):
            v=json.loads(data);assert v['ok'],json.dumps(v);return v
    raise AssertionError('public_response_deadline')
def workers():return call({'action':'tmux.workers.list'})['data']['workers']
def state():return call({'fixture':'state'})['data']
def settled(run):
    s=state();a=s['agents'].get(run)
    return s if a and a['status']!='running' else None
def providers():
    rows=[load(p) for p in ROOT.glob('provider-*.json')];rows=[r for r in rows if r]
    assert not any(r['error'] for r in rows),'provider_contract'
    return rows
def current(role,scenario):
    return next(((r,c) for r in providers() for c in r['calls'] if c['role']==role and c['scenario']==scenario),None)
def release(role,scenario):
    r,c=wait(lambda:current(role,scenario),'provider_'+role+'_'+scenario)
    (ROOT/f"release-{r['pid']}-{r['calls'].index(c)+1}").touch()
def exact(role,member,parent_id,task_id,text):
    reply=call({'action':'agents.result','id':role,'runId':parent_id,'memberRunId':member,'full':True})['data']
    assert reply['status']=='found','public_result_missing'
    result_oracle(reply['result'],role,member,{'runId':parent_id,'taskId':task_id},text)
    return reply['result']
def close_all():
    for r in workers():call({'action':'tmux.workers.close','workerId':r['workerId']})
    wait(lambda:not workers(),'public_close_zero_workers');wait(gone,'public_close_zero_resources')
def run_action(task,agent='team'):
    return {'action':'run','agent':agent,'task':task,'backend':'tmux','background':True,'concurrency':1 if agent=='solo' else 2}

def main():
    global parent,natural,failure,phase
    start=time.monotonic();assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
    try:
        # Same comparator, independent fixed data, before any worker is launched.
        prior.planted();checks.append('two_planted_faults_rejected')
        env={'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','PI_OFFLINE':'1','PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0','PI_IMAGE_PROTOCOL':'none','TMUX_GATE_ROOT':str(ROOT),'TMUX_GATE_SDK':os.environ['TMUX_GATE_SDK']}
        for key,d in [('HOME','home'),('XDG_CONFIG_HOME','xdg'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('PI_CODING_AGENT_DIR','agent')]:
            (ROOT/d).mkdir(mode=0o700);env[key]=str(ROOT/d)
        for d in ['workers','workspace']:(ROOT/d).mkdir(mode=0o700)
        assert subprocess.check_output(['/usr/bin/tmux','-V'],env=env,text=True,timeout=3).strip()=='tmux 3.8'
        assert load(Path(env['TMUX_GATE_SDK']).parent.parent/'package.json')['version']=='1.5.0'
        shutil.copyfile(HERE/'tmux-team-validation-provider.ts',ROOT/'provider.ts')
        shutil.copyfile(HERE/'tmux-standalone-no-network.mjs',ROOT/'no-network.mjs')
        dump(ROOT/'agent/settings.json',{'quietStartup':True,'compaction':{'enabled':False},'retry':{'enabled':False}})
        dump(ROOT/'agent/models.json',{'providers':{'team-fixture':{'baseUrl':'http://fixture.invalid','api':'openai-completions','apiKey':'synthetic-not-a-key','models':[{'id':'fixed','name':'Offline team fixture','reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':65536,'maxTokens':4096}]}}})
        stderr=(ROOT/'parent.stderr').open('wb');os.chmod(ROOT/'parent.stderr',0o600)
        parent=subprocess.Popen([shutil.which('node'),'--import',str(ROOT/'no-network.mjs'),str(HERE/'tmux-public-smoke-parent.mjs')],env=env,cwd=ROOT/'workspace',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,bufsize=0);saved[parent.pid]=identity(parent.pid)
        for role in ['a','b','c','lead','solo']:
            agent=call({'action':'agents.create','id':role,'prompt':role,'tools':[],'model':'team-fixture/fixed:off'})['data']['agent']
            assert (agent['id'],agent['prompt'],agent['tools'],agent['model'])==(role,role,[],'team-fixture/fixed:off'),'public_agent_config'
        team=call({'action':'team.create','id':'team','leader':'lead','members':['a','b','c']})['data']['team']
        assert team['id']=='team' and team['leaderAgentId']=='lead' and team['memberAgentIds']==['a','b','c'],'public_team_config'
        p=call(run_action('SUCCESS'));assert (p['runId'],p['taskId'])==('zerg-pub-run-1','task-pub-task-1'),'public_parent_ids'
        reset();wait(lambda:current('a','SUCCESS') and current('b','SUCCESS'),'public_dispatch_two')
        rows=workers();assert len(rows)==4 and {r['agentId']:r['currentRunId'] for r in rows if r['phase']=='busy'}=={'a':'zerg-pub-run-2','b':'zerg-pub-run-3'},'public_concurrency_ids'
        release('b','SUCCESS');release('c','SUCCESS');assert not current('lead','SUCCESS'),'leader_before_a'
        release('a','SUCCESS');release('lead','SUCCESS')
        s=wait(lambda:settled('zerg-pub-run-1'),'public_success_settled');assert s['agents']['zerg-pub-run-1']['status']=='done','public_aggregate'
        for role,n,text in [('a',2,'A_OK'),('b',3,'B_OK'),('c',4,'C_OK'),('lead',5,'LEAD_OK'),('lead',1,'LEAD_OK')]:exact(role,f'zerg-pub-run-{n}','zerg-pub-run-1','task-pub-task-1',text)
        checks.append('public_config_dispatch_exact_results_aggregate');close_all();reset()
        p=call({'fixture':'tool','action':run_action('CANCEL')});assert (p['runId'],p['taskId'])==('zerg-pub-run-6','task-pub-task-6'),'registered_tool_parent_ids'
        wait(lambda:current('a','CANCEL') and current('b','CANCEL'),'cancel_two_active')
        solo=call(run_action('SOLO','solo'));assert (solo['runId'],solo['taskId'])==('zerg-pub-run-11','task-pub-task-11'),'solo_ids'
        wait(lambda:current('solo','SOLO'),'solo_active');rows=workers();assert len(rows)==5,'five_slots'
        before=next(r for r in rows if r['agentId']=='solo')
        call({'fixture':'tool','action':{'action':'interrupt','runId':'zerg-pub-run-6'}})
        s=wait(lambda:settled('zerg-pub-run-6'),'public_cancel_settled');assert s['agents']['zerg-pub-run-6']['status']=='cancelled','public_cancelled'
        assert not current('c','CANCEL') and not current('lead','CANCEL'),'queued_leader_executed'
        after=next(r for r in workers() if r['agentId']=='solo');assert after['phase']=='busy' and after['job']==before['job'],'unrelated_worker_affected'
        release('solo','SOLO');wait(lambda:settled('zerg-pub-run-11'),'solo_settled');exact('solo','zerg-pub-run-11','zerg-pub-run-11','task-pub-task-11','SOLO_OK')
        checks.append('registered_tool_cancel_exact_team_unrelated_exact_result')
        # Invoke registered slash parser without driving any terminal or launching work.
        slash=call({'fixture':'slash','text':'tmux workers list'})
        assert slash['notifications'] and all(n['type']!='error' for n in slash['notifications']),'registered_slash_list'
        checks.append('captured_registered_slash_list')
        assert sum(len(r['calls']) for r in providers())==7,'exact_seven_synthetic_calls'
        for r in providers():
            ui=load(ROOT/f"ui-{r['pid']}.json");assert ui and ui['mode']=='tui' and all(ui[k] for k in ['hasUI','stdinTTY','stdoutTTY']),'actual_pi_tty'
            assert load(ROOT/f"network-guard-{r['pid']}.json")=={'pid':r['pid'],'installed':True},'worker_network_guard'
        assert load(ROOT/f'network-guard-{parent.pid}.json')=={'pid':parent.pid,'installed':True},'parent_network_guard'
        close_all();phase=min(WHOLE,time.monotonic()+15);call({'fixture':'dispose'});wait(gone,'dispose_zero_resources');natural=True;checks.append('public_close_dispose_zero_resources')
    except BaseException as exc:failure=str(exc) if isinstance(exc,AssertionError) else type(exc).__name__+': '+str(exc)
    finally:
        end=min(WHOLE,time.monotonic()+15)
        if parent and parent.poll() is None and not natural:
            try:phase=end;call({'fixture':'dispose'})
            except BaseException:cleanup.append('emergency_dispose_failed')
        for sig in [signal.SIGTERM,signal.SIGKILL]:
            collect()
            for pid,stamp in saved.items():
                if identity(pid)==stamp:
                    try:os.kill(pid,sig)
                    except ProcessLookupError:pass
            until=min(end,time.monotonic()+1)
            while time.monotonic()<until and any(identity(pid)==stamp for pid,stamp in saved.items()):time.sleep(.03)
        if parent:
            try:parent.wait(timeout=max(.01,end-time.monotonic()))
            except subprocess.TimeoutExpired:cleanup.append('parent_not_reaped')
        while time.monotonic()<end:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if not pid:time.sleep(.02)
            except ChildProcessError:break
        remaining=sum(identity(pid)==stamp for pid,stamp in saved.items())+len(artifacts())
        if remaining:cleanup.append('owned_resources_remain')
        if time.monotonic()>WHOLE:cleanup.append('whole_250s')
        observed=[load(p) for p in ROOT.glob('provider-*.json')]
        summary={'pass':failure is None and natural and not cleanup,'failure':failure,'checks':checks,'providerInvocations':sum(len(r['calls']) for r in observed if r),'naturalCleanup':natural,'ownedResources':remaining,'cleanupErrors':cleanup,'elapsedSeconds':round(time.monotonic()-start,3),'root':str(ROOT),'pids':saved}
        dump(ROOT/'summary.json',summary);print(json.dumps(summary),flush=True)
    return 0 if summary['pass'] else 1
if __name__=='__main__':raise SystemExit(main())
