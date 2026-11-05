#!/usr/bin/env python3
"""Independent real Pi1.5/tmux3.8 gate. One run, first failure stops. No runtime edits."""
import ctypes
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
WHOLE=time.monotonic()+250

def identity(pid):
    try:
        f=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
        return None if f[0] in ['Z','X'] else f[19]
    except FileNotFoundError: return None

def result_oracle(row, role, member, parent, text, state='done'):
    assert row['agent_id']==role and row['member_run_id']==member, 'wrong_member_identity'
    assert row['run_id']==parent['runId'] and row['task_id']==parent['taskId'], 'wrong_parent_identity'
    assert row['final_message']==text, 'wrong_output'
    assert row['state']==state, 'wrong_outcome'

def planted():
    p={'runId':'run-1','taskId':'task-1'}
    r={'agent_id':'a','member_run_id':'run-2','run_id':'run-1','task_id':'task-1','final_message':'A_OK','state':'done'}
    caught=[]
    for key,value,expected in [('member_run_id','run-3','wrong_member_identity'),('final_message','B_OK','wrong_output')]:
        try: result_oracle({**r,key:value},'a','run-2',p,'A_OK')
        except AssertionError as e:
            assert str(e)==expected
            caught.append(str(e))
    assert len(caught)==2
    print(json.dumps({'plantedFaultsCaught':caught}),flush=True)

def scenario(name):
    start=time.monotonic(); root=Path(tempfile.mkdtemp(prefix='ctv-',dir='/srv/devops/scratch'));os.chmod(root,0o700)
    env={'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','PI_OFFLINE':'1','PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0','PI_IMAGE_PROTOCOL':'none','TMUX_GATE_ROOT':str(root),'TMUX_GATE_SDK':os.environ['TMUX_GATE_SDK']}
    for key,d in [('HOME','home'),('XDG_CONFIG_HOME','xdg'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('PI_CODING_AGENT_DIR','agent')]:
        (root/d).mkdir(mode=0o700);env[key]=str(root/d)
    for d in ['workers','workspace']:(root/d).mkdir(mode=0o700)
    saved={};sentinel_ids={};parent=sentinel=None;natural=False;preserved=False;error=None;cleanup=[];checks=[];phase=time.monotonic()+30
    def dump(p,v):p.write_text(json.dumps(v));os.chmod(p,0o600)
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
                seen.add(c);assert len(seen)<160,'descendant_cap'
                stamp=identity(c)
                if stamp:
                    (sentinel_ids if c in sentinel_ids or pid in sentinel_ids else saved).setdefault(c,stamp);todo.append(c)
    def alive(pid):return saved.get(pid) is not None and identity(pid)==saved[pid]
    def artifacts():return [p for p in (root/'workers').rglob('*') if p.name in ['control.sock','tmux.sock','ready.json','config.json']]
    def gone():
        collect();return not any(alive(pid) for pid in saved if parent is None or pid!=parent.pid) and not artifacts()
    def reset(seconds=30):
        nonlocal phase
        phase=min(WHOLE-15,time.monotonic()+seconds)
    def wait(fn,label):
        while time.monotonic()<phase:
            collect();value=fn()
            if value:return value
            time.sleep(.04)
        raise AssertionError(label)
    def call(q):
        assert parent.poll() is None,'parent_exited'
        parent.stdin.write((json.dumps(q)+'\n').encode());parent.stdin.flush();data=b''
        while time.monotonic()<phase:
            collect()
            if not select.select([parent.stdout],[],[],.04)[0]:continue
            c=os.read(parent.stdout.fileno(),65536);assert c,'parent_eof';data+=c
            assert len(data)<262144,'response_cap'
            if data.endswith(b'\n'):return json.loads(data)
        raise AssertionError('response_deadline')
    def ok(q):
        r=call(q);assert r['ok'],'command_refused';return r
    def providers():
        rows=[load(p) for p in root.glob('provider-*.json')];rows=[r for r in rows if r]
        assert not any(r['error'] for r in rows),'provider_contract'
        return rows
    def calls():return [(r,c) for r in providers() for c in r['calls']]
    def current(role,scenario_name=None):
        return next(((r,c) for r,c in calls() if c['role']==role and (scenario_name is None or c['scenario']==scenario_name)),None)
    def release(role,scenario_name=None):
        r,c=wait(lambda:current(role,scenario_name),'provider_start_'+role)
        (root/f"release-{r['pid']}-{r['calls'].index(c)+1}").touch()
    def records():return ok({'action':'results'})['rows']
    def settled(parent_id):
        v=ok({'action':'results'});a=v['agents'].get(parent_id)
        return v if a and a['status']!='running' else None
    def rows():return ok({'action':'list'})['rows']
    def start_team(task,agent='team'):return ok({'action':'start','agent':agent,'task':task})
    try:
        assert subprocess.check_output(['/usr/bin/tmux','-V'],env=env,text=True,timeout=3).strip()=='tmux 3.8','tmux_version'
        assert load(Path(env['TMUX_GATE_SDK']).parent.parent/'package.json')['version']=='1.5.0','pi_version'
        shutil.copyfile(HERE/'tmux-team-validation-provider.ts',root/'provider.ts')
        shutil.copyfile(HERE/'tmux-standalone-no-network.mjs',root/'no-network.mjs')
        dump(root/'agent/settings.json',{'quietStartup':True,'compaction':{'enabled':False},'retry':{'enabled':False}})
        dump(root/'agent/models.json',{'providers':{'team-fixture':{'baseUrl':'http://fixture.invalid','api':'openai-completions','apiKey':'synthetic-not-a-key','models':[{'id':'fixed','name':'Offline team fixture','reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':65536,'maxTokens':4096}]}}})
        if name=='SETUP':(root/'hold-setup').touch()
        sock=str(root/'sentinel.sock')
        sentinel=subprocess.Popen(['/usr/bin/tmux','-D','-S',sock,'-f','/dev/null'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        sentinel_ids[sentinel.pid]=identity(sentinel.pid)
        wait(lambda:Path(sock).exists(),'sentinel_start')
        pane=int(subprocess.check_output(['/usr/bin/tmux','-S',sock,'new-session','-d','-P','-F','#{pane_pid}','sleep 260'],env=env,text=True,timeout=3).strip());sentinel_ids[pane]=identity(pane)
        assert all(sentinel_ids.values()),'sentinel_ids'
        stderr=(root/'parent.stderr').open('wb');os.chmod(root/'parent.stderr',0o600)
        parent=subprocess.Popen([shutil.which('node'),'--import',str(root/'no-network.mjs'),str(HERE/'tmux-team-validation-parent.mjs')],env=env,cwd=root/'workspace',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,bufsize=0);saved[parent.pid]=identity(parent.pid)
        p=start_team('PARENTLOSS' if name=='SETUP' else name)
        assert p=={**p,'runId':'run-1','taskId':'task-1'},'parent_ids'
        reset()
        if name=='SETUP':
            wait(lambda:len(list(root.glob('setup-*')))==2,'setup_barriers')
            assert len(rows())==4 and not calls(),'setup_slots_and_zero_requests'
            ok({'action':'interrupt','runId':p['runId']});(root/'release-setup').touch()
            v=wait(lambda:settled(p['runId']),'setup_cancel_settlement')
            assert v['agents'][p['runId']]['status']=='cancelled' and not calls(),'setup_cancel_no_request'
            wait(lambda:not rows(),'setup_workers_closed');checks.append('real_setup_cancellation')
        else:
            wait(lambda:current('a') and current('b'),'first_two_requests')
            assert sorted(c['role'] for r,c in calls())==['a','b'],'fifo_first_two'
            initial=rows();busy=[r for r in initial if r['phase']=='busy'];assert len(initial)==4 and len(busy)==2,'reserved4_busy2'
            assert {r['agentId']:r['currentRunId'] for r in busy}=={'a':'run-2','b':'run-3'},'exact_initial_ids'
            assert len({r['workerId'] for r in initial})==4 and len({r['sessionId'] for r in busy})==2,'unique_sessions'
            if name=='PARENTLOSS':
                os.kill(parent.pid,signal.SIGKILL);reset(15);wait(gone,'parentloss_cleanup');natural=True;checks.append('real_parentloss')
                assert len(calls())==2,'parentloss_no_queued_calls'
            elif name=='CANCEL':
                solo=start_team('SOLO','solo');sibling=start_team('SIBLING','sibling');reset()
                wait(lambda:current('solo','SOLO') and current('s','SIBLING'),'unrelated_active')
                assert len(rows())==7,'seven_slots'
                snapshot={r['agentId']:r for r in rows() if r['agentId'] in ['solo','s']}
                ok({'action':'interrupt','runId':p['runId']});v=wait(lambda:settled(p['runId']),'cancel_settlement')
                assert v['agents'][p['runId']]['status']=='cancelled','parent_cancelled'
                assert not current('c') and not current('lead'),'queued_leader_zero_requests'
                for r in rows():
                    if r['agentId'] in snapshot:assert r['phase']=='busy' and r['job']==snapshot[r['agentId']]['job'],'unrelated_unchanged'
                release('solo','SOLO');release('s','SIBLING');release('slead','SIBLING')
                wait(lambda:settled(solo['runId']) and settled(sibling['runId']),'unrelated_complete')
                assert len(calls())==5,'cancel_exact_call_count';checks.append('real_cancel_sibling_standalone_isolation')
            else:
                release('b');reset();wait(lambda:current('c'),'fifo_third')
                assert not current('lead') and not current('a')[1]['finished'],'leader_waits_for_a'
                release('c');wait(lambda:current('c')[1]['finished'],'c_finished')
                assert not current('lead'),'leader_waits_all'
                release('a');reset();lr,lc=wait(lambda:current('lead'),'leader_start')
                assert all(current(x)[1]['finished']<=lc['started'] for x in ['a','b','c']),'leader_only_after_all'
                prompt=lc['text'];assert len(prompt.encode())<=8192 and 'agents.result' not in prompt,'bounded_prompt'
                summary=[json.loads(x) for x in prompt.split('Untrusted member results (bounded JSON rows):\n',1)[1].splitlines()]
                assert [(r['agent_id'],r['member_run_id']) for r in summary]==[('a','run-2'),('b','run-3'),('c','run-4')],'summary_exact_ids'
                if name=='BOUNDED':
                    assert summary[0]['final_message']=='X'*128+'ANSWER=42' and not summary[0]['truncated'] and not summary[0]['unavailable'],'short_answer_preserved'
                    big=('😀'+chr(34)+chr(92)+'\n')*1100
                    assert summary[1]['final_message'] and big.startswith(summary[1]['final_message']) and summary[1]['truncated'] and not summary[1]['unavailable'],'unicode_bounded_prefix'
                else:
                    for i,role in enumerate(['a','b','c']):
                        assert summary[i]['final_message']==(role.upper()+'_PARTIAL' if name=='FAILURE' and role=='a' else role.upper()+'_OK'),'leader_exact_evidence'
                release('lead');v=wait(lambda:settled(p['runId']),'parent_settlement');expected='failed' if name=='FAILURE' else 'done'
                assert v['agents'][p['runId']]['status']==expected,'truthful_parent'
                result_oracle(next(r for r in v['rows'] if r['member_run_id']=='run-1'),'lead','run-1',p,'LEAD_OK',expected)
                for role,member in [('a','run-2'),('b','run-3'),('c','run-4'),('lead','run-5')]:
                    r=next(r for r in v['rows'] if r['member_run_id']==member)
                    if name!='BOUNDED':result_oracle(r,role,member,p,role.upper()+'_PARTIAL' if name=='FAILURE' and role=='a' else 'LEAD_OK' if role=='lead' else role.upper()+'_OK','failed' if name=='FAILURE' and role=='a' else 'done')
                assert len(calls())==4,'four_requests'
                if name=='SUCCESS':
                    before=v['rows'];a=next(r for r in rows() if r['agentId']=='a');reuse=ok({'action':'prompt','workerId':a['workerId'],'task':'REUSE'});reset();wait(lambda:current('solo','REUSE'),'reuse_started')
                    assert reuse['runId']=='run-6' and reuse['taskId']=='task-6','reuse_fresh_ids'
                    assert not call({'action':'interrupt','runId':'run-1'})['ok'] and not call({'action':'interrupt','runId':'run-2'})['ok'],'stale_routes_refused'
                    release('solo','REUSE');wait(lambda:settled(reuse['runId']),'reuse_settlement')
                    assert records()[:5]==before,'immutable_results'
                    result_oracle(records()[-1],'a','run-6',reuse,'REUSE_OK');assert len(calls())==5,'reuse_call_count'
                checks.append('real_'+name.lower())
        # Independent proof of real TTY and installed no-network guards, not just injected callbacks.
        for r in providers():
            ui=load(root/f"ui-{r['pid']}.json");assert ui and ui['mode']=='tui' and all(ui[k] for k in ['hasUI','stdinTTY','stdoutTTY']),'actual_pi_tty'
            assert load(root/f"network-guard-{r['pid']}.json")=={'pid':r['pid'],'installed':True},'worker_network_guard'
        assert load(root/f'network-guard-{parent.pid}.json')=={'pid':parent.pid,'installed':True},'parent_network_guard'
        if not natural:
            reset(15);ok({'action':'dispose'});wait(gone,'dispose_zero_resources');natural=True
        preserved=all(identity(pid)==stamp for pid,stamp in sentinel_ids.items());assert preserved,'sentinel_changed'
    except BaseException as exc:
        error=str(exc) if isinstance(exc,AssertionError) else type(exc).__name__
    finally:
        end=min(WHOLE,time.monotonic()+15)
        if parent and parent.poll() is None and not natural:
            try:phase=end;call({'action':'dispose'})
            except BaseException:cleanup.append('emergency_dispose_failed')
        for sig in [signal.SIGTERM,signal.SIGKILL]:
            collect()
            for pid,stamp in {**saved,**sentinel_ids}.items():
                if stamp and identity(pid)==stamp:
                    try:os.kill(pid,sig)
                    except ProcessLookupError:pass
            until=min(end,time.monotonic()+1)
            while time.monotonic()<until and any(stamp and identity(pid)==stamp for pid,stamp in {**saved,**sentinel_ids}.items()):time.sleep(.03)
        for proc in [parent,sentinel]:
            if proc:
                try:proc.wait(timeout=max(.01,end-time.monotonic()))
                except subprocess.TimeoutExpired:cleanup.append('child_not_reaped')
        while time.monotonic()<end:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if not pid:time.sleep(.02)
            except ChildProcessError:break
        remaining=sum(bool(stamp and identity(pid)==stamp) for pid,stamp in {**saved,**sentinel_ids}.items())+len(artifacts())
        sentinel_path=root/'sentinel.sock'
        if sentinel_path.exists() and not any(stamp and identity(pid)==stamp for pid,stamp in sentinel_ids.items()):sentinel_path.unlink()
        if remaining:cleanup.append('owned_resources_remain')
        if time.monotonic()>WHOLE:cleanup.append('whole_250s')
        observed=[load(p) for p in root.glob('provider-*.json')]
        summary={'scenario':name,'pass':error is None and natural and preserved and not cleanup,'error':error,'checks':checks,'providerInvocations':sum(len(r['calls']) for r in observed if r),'naturalCleanup':natural,'sentinelPreserved':preserved,'ownedResources':remaining,'cleanupErrors':cleanup,'elapsedSeconds':round(time.monotonic()-start,3),'root':str(root)}
        dump(root/'summary.json',summary);print(json.dumps(summary),flush=True)
    return summary['pass']

def main():
    assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
    planted()
    for name in ['SUCCESS','BOUNDED','FAILURE','CANCEL','SETUP','PARENTLOSS']:
        if not scenario(name):return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
