"""AUTHOR-ONLY: actual isolated terminal controller, not human visual evidence.
Kernel ancestry + pidfd authorization copied UNCHANGED from existing controller.
No terminal screen-emulator claim: raw ANSI and bounded frame references retained.
"""
import ctypes
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
root = sys.argv[1]
assert sys.platform == 'linux'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
# BEGIN STAGE9 EVIDENCE PUBLICATION (finite fixture messages only).
# Separate supervisor/controller processes share code, not target ownership.
EVIDENCE_NAMES = ('driver-supervision.json', 'ui-live.json', 'ui-settings.json', 'ui-reload.json', 'ui-restart.json', 'pty-result.json')
EVIDENCE_PENDING = '.stage9-python-evidence.pending'
def evidence_stat(path):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    assert __import__('stat').S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid()
    return st

def evidence_path(name):
    assert name in EVIDENCE_NAMES or name == EVIDENCE_PENDING, 'Unowned evidence path'
    assert root.startswith('/tmp/zerg-stage9-') and os.path.abspath(root) == root
    owner = os.lstat(root)
    assert __import__('stat').S_ISDIR(owner.st_mode) and owner.st_uid == os.getuid() and owner.st_mode & 0o077 == 0
    path = root + '/evidence/' + name
    assert os.path.abspath(path) == path and path.startswith(root + '/evidence/')
    parent = os.path.dirname(path)
    while True:
        st = os.lstat(parent)
        assert __import__('stat').S_ISDIR(st.st_mode) and os.path.realpath(parent) == parent
        if parent == os.path.dirname(parent):
            break
        parent = os.path.dirname(parent)
    evidence_stat(path)
    return path

def put(name, value):
    assert name in EVIDENCE_NAMES, 'Unowned evidence publisher'
    data = json.dumps(value, indent=2, allow_nan=False).encode()
    target, pending = evidence_path(name), evidence_path(EVIDENCE_PENDING)
    prior = evidence_stat(target)
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    owned, published = os.fstat(fd), False
    try:
        with os.fdopen(fd, 'wb') as f:
            assert __import__('stat').S_ISREG(owned.st_mode) and owned.st_nlink == 1 and owned.st_uid == os.getuid()
            f.write(data)
        st = evidence_stat(evidence_path(EVIDENCE_PENDING))
        assert st and (st.st_dev, st.st_ino) == (owned.st_dev, owned.st_ino)
        current = evidence_stat(evidence_path(name))
        assert ((current and (current.st_dev, current.st_ino) == (prior.st_dev, prior.st_ino)) if prior else not current), 'Competing evidence writer'
        os.rename(pending, target)
        published = True
    finally:
        if not published:
            st = evidence_stat(evidence_path(EVIDENCE_PENDING))
            assert st and (st.st_dev, st.st_ino) == (owned.st_dev, owned.st_ino)
            os.unlink(pending) # Exactly one owned cleanup attempt; never a foreign slot.
# END STAGE9 EVIDENCE PUBLICATION

if len(sys.argv) > 2 and sys.argv[2] == '--driver':
    driver = subprocess.Popen(sys.argv[3:], cwd=root + '/work')
    code = driver.wait(timeout=165)
    reaped = []
    end = time.monotonic() + 4
    while time.monotonic() < end:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            reaped.append({'pid': pid, 'exit': os.waitstatus_to_exitcode(status)})
        else:
            time.sleep(.02)
    else:
        raise Exception('Owned driver descendants did not naturally settle')
    put('driver-supervision.json', {'ok': code == 0, 'driverPid': driver.pid, 'exit': code, 'reaped': reaped})
    sys.exit(code)
config = json.load(open(root + '/evidence/config.json'))
mode = config['mode']
start = time.monotonic()
stopping = False
proc = None
master = None
seen = {}
raw = bytearray()
report = {'ok': False, 'mode': mode, 'keys': [], 'captures': {}, 'remaining': []}
ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def load(name):
    try:
        with open(root + '/evidence/' + name) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


# BEGIN STAGE9 PROTOCOL (standalone class; fake tests inject IO and monotonic clock).
STAGE9_PLAN = [('live', 1, 'startup'), ('live', 1, 'mixed'), ('live', 1, 'team'), ('live', 1, 'implementation'), ('live', 1, 'application'), ('live', 1, 'approval-settled'), ('live', 1, 'reuse-first'), ('live', 1, 'reuse-retry'), ('live', 1, 'dynamic-parallel'), ('live', 1, 'dynamic-conditional'), ('live', 1, 'cancel'), ('live', 1, 'failure'), ('live', 1, 'reload-ready'), ('live', 2, 'reload'), ('live', 2, 'old-retirement'), ('live', 2, 'fresh-run'), ('live', 2, 'completion'), ('restart', 1, 'restart-startup'), ('restart', 1, 'recovery'), ('restart', 1, 'restart-completion')]
STAGE9_RECORD_BYTES = 512
STAGE9_TOTAL_BYTES = 21504
class StageProgress:
    def __init__(self, start, clock, reader, writer):
        self.start, self.clock, self.reader, self.writer = start, clock, reader, writer
        self.state_start = clock()
        self.index, self.end, self.seen = 0, min(start + 140, self.state_start + 20), {}
    def expected(self):
        phase, generation, state = STAGE9_PLAN[self.index]
        return {'version': 1, 'phase': phase, 'generation': generation, 'seq': self.index + 1, 'state': state}
    def tick(self):
        now = self.clock()
        if now >= self.start + 140 or now >= self.end:
            raise Exception('Protocol deadline: seq=%s state=%s stateElapsed=%s overall=%s' %
                (self.index + 1, STAGE9_PLAN[self.index][2] if self.index < len(STAGE9_PLAN) else 'host-exit',
                 now - self.state_start, now - self.start))
        rows = self.reader()
        for seq, prior in self.seen.items():
            assert rows.get(seq) == prior, 'Duplicate/changed/deleted prior progress'
        for seq in rows:
            assert type(seq) is int and seq <= self.index + 1, 'Skipped/out-of-order progress'
        if self.index == len(STAGE9_PLAN):
            assert len(rows) == len(self.seen), 'Progress after completion'
            return
        row = rows.get(self.index + 1)
        if row is None:
            return # Heartbeat/log/HTTP/render/repeated prior state never renews end.
        expected = self.expected()
        assert type(row) is dict and row.keys() == expected.keys(), 'Malformed progress'
        assert all(type(row[k]) is type(v) and row[k] == v for k, v in expected.items()), 'Stale phase/generation/seq/state'
        assert self.clock() < min(self.end, self.start + 140), 'State deadline before ack'
        self.writer(self.index + 1, expected) # exclusive exact ack, never overwritten
        assert self.clock() < min(self.end, self.start + 140), 'State deadline during ack'
        self.seen[self.index + 1] = row.copy()
        self.index += 1
        self.state_start = self.clock()
        self.end = min(self.start + 140, self.state_start + 20)
# END STAGE9 PROTOCOL

def protocol_path(name):
    assert re.fullmatch(r'(?:progress|ack)-[0-9]{2}\.json(?:\.pending)?|budget\.json', name)
    path = root + '/evidence/' + name
    assert os.path.realpath(path) == path and path.startswith(root + '/evidence/')
    parent = os.path.dirname(path)
    while True:
        st = os.lstat(parent)
        assert __import__('stat').S_ISDIR(st.st_mode) and not __import__('stat').S_ISLNK(st.st_mode)
        if parent == os.path.dirname(parent):
            break
        parent = os.path.dirname(parent)
    if os.path.lexists(path):
        st = os.lstat(path)
        assert __import__('stat').S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid()
        assert st.st_size <= STAGE9_RECORD_BYTES
    return path

def protocol_write(name, value):
    data = json.dumps(value, separators=(',', ':')).encode()
    assert len(data) <= STAGE9_RECORD_BYTES
    target = protocol_path(name)
    assert not os.path.lexists(target), 'Duplicate protocol write'
    pending = protocol_path(name + '.pending') if name != 'budget.json' else target
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    if pending != target:
        assert not os.path.lexists(target), 'Duplicate protocol publish'
        os.rename(pending, target)

protocol_identities = {}
def protocol_rows():
    rows, total, count = {}, 0, 0
    for name in os.listdir(root + '/evidence'):
        if not name.startswith(('progress-', 'ack-')) and name != 'budget.json':
            continue
        path = protocol_path(name)
        total += os.lstat(path).st_size
        count += 1
        assert count <= 42 and total <= STAGE9_TOTAL_BYTES, 'Protocol record/byte ceiling'
        if name == 'budget.json':
            continue
        seq = int(name.split('-')[1].split('.')[0])
        assert 1 <= seq <= len(STAGE9_PLAN), 'Unallowed record'
        if name.endswith('.pending'):
            assert not os.path.lexists(path[:-8]), 'Duplicate pending record'
            continue # Atomic publish only; pending activity cannot advance/renew.
        st = os.lstat(path)
        identity = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        assert name not in protocol_identities or protocol_identities[name] == identity, 'Rewritten duplicate record'
        protocol_identities[name] = identity
        # Canonical form rejects duplicate JSON keys and malformed wire syntax.
        with open(path) as f:
            text = f.read()
        row = json.loads(text)
        assert text == json.dumps(row, separators=(',', ':')), 'Malformed protocol wire form'
        if name.startswith('progress-'):
            rows[seq] = row
        else:
            assert seq in progress.seen and type(row) is dict and row.keys() == progress.seen[seq].keys(), 'Stale/malformed/duplicate ack'
            assert all(type(row[k]) is type(v) and row[k] == v for k, v in progress.seen[seq].items()), 'Malformed ack type/value'
    return rows

protocol_write('budget.json', {'version': 1, 'start': str(start), 'deadline': str(start + 140)})
progress = StageProgress(start, time.monotonic, protocol_rows,
                         lambda seq, row: protocol_write('ack-%02d.json' % seq, row))

def stat(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        return {'pid': pid, 'ppid': int(fields[1]), 'birth': fields[19], 'state': fields[0]}
    except (FileNotFoundError, ProcessLookupError):
        return None

def owned():
    result = {}
    queue = [os.getpid()]
    visited = set(queue)
    while queue:
        parent = queue.pop()
        try:
            threads = os.listdir('/proc/' + str(parent) + '/task')
        except (FileNotFoundError, ProcessLookupError):
            continue
        assert len(threads) <= 128, 'Owned thread ceiling'
        for thread in threads:
            try:
                with open('/proc/' + str(parent) + '/task/' + thread + '/children') as f:
                    children = f.read().split()
            except (FileNotFoundError, ProcessLookupError):
                continue
            for child in children:
                pid = int(child)
                value = stat(pid)
                if pid in visited or not value or value['ppid'] != parent:
                    continue
                result[pid] = value
                visited.add(pid)
                queue.append(pid)
                assert len(result) <= 64, 'Owned descendant ceiling'
    for pid, value in result.items():
        seen[(pid, value['birth'])] = value
    return result

def send(value, sig):
    try:
        fd = os.pidfd_open(value['pid'])
        try:
            now = stat(value['pid'])
            if now and now['birth'] == value['birth'] and value['pid'] in owned():
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass

def reap():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if not pid:
            return

def stop(_sig, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def pump(wait=.03):
    streams = [master] if master is not None else [s for s in [proc.stdout, proc.stderr] if s]
    for stream in select.select(streams, [], [], wait)[0]:
        try:
            data = os.read(stream if isinstance(stream, int) else stream.fileno(), 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                continue
            raise
        raw.extend(data)
        assert len(raw) <= 1024 * 1024, 'Terminal/stdout byte ceiling'
        if master is not None:
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')
            if b'\x1b[>c' in data:
                os.write(master, b'\x1b[>0;0;0c')
    owned()
    progress.tick()
def text(offset=0):
    return ansi.sub('', bytes(raw[offset:]).decode('utf-8', 'replace'))
def emitted(value, offset=0):
    return re.sub(r'\s+', '', value) in re.sub(r'\s+', '', text(offset))
def until(check, label, allow_exit=False):
    end = min(start + 140, time.monotonic() + 20)
    while not stopping and time.monotonic() < end:
        pump()
        if check():
            return
        if load('failure.json') or load('server-failure.json'):
            raise Exception('Fixture failed: ' + str(load('failure.json') or load('server-failure.json')))
        if proc.poll() is not None and not allow_exit:
            if check():
                return
            raise Exception('Host exited: ' + label + '\n' + text()[-4000:])
    raise Exception('Deadline: ' + label + '\n' + text()[-4000:])
def resize(cols, rows):
    for c, r in [(cols - 1, rows - 1), (cols, rows)]:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        value = owned().get(proc.pid)
        if value:
            send(value, signal.SIGWINCH)
        pump(.15)
def key(value, label):
    os.write(master, value)
    report['keys'].append(label)
    pump(.15)
def steady(seconds=.4):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()
def observed():
    return load('observed.json')
def custom_closed():
    row = observed()
    return row.get('opens', 0) == row.get('closes', 0)
def draft(value):
    until(lambda: observed().get('draft') == value, 'exact unsubmitted editor draft')
def clear_draft(label):
    # Pi keybindings.md: Ctrl+E goes to line end; Ctrl+U deletes to line start.
    # Owned one/two-line drafts leave the cursor on the last line. Three kills
    # remove last-line text, its newline, then first-line text (empty is safe).
    # Never use Ctrl+C here: a second press within 500ms legitimately exits Pi.
    key(b'\x05\x15\x15\x15', label)
    draft('') # Actual editor readiness, not a blind wait or synthetic setText.
def open_manage(binding=b'\x1bg'):
    opens = observed().get('opens', 0)
    key(binding, 'actual active opener')
    until(lambda: observed().get('opens') == opens + 1, 'actual shared management UI opened')
    return opens + 1
def close_manage():
    key(b'q', 'close management observer only')
    until(custom_closed, 'management close/focus return')
def live_ui():
    until(lambda: load('live.json'), 'real mixed standalone/team/workflow activity')
    offset = len(raw)
    resize(240, 55)
    until(lambda: emitted('Clankers', offset) and emitted('S9 companion widget', offset)
          and emitted('S9 companion status', offset), 'fresh strip+companion+default-footer status')
    before = observed().get('opens', 0)
    # Real bracketed paste containing escape-like shortcut bytes must not open.
    key(b'\x1b[200~literal \x1bg pasted\x1b[201~', 'escape-like bracketed paste')
    steady(1.1)
    assert observed().get('opens') == before
    clear_draft('explicitly clear synthetic paste without submitting')
    value = 'S9 DRAFT 一\nsecond line'
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'unsubmitted multiline Unicode draft')
    draft(value)
    # BOTH actual entries: explicit public /zerg config and effective hotkey.
    clear_draft('clear synthetic draft ONLY for config command submission')
    command_opens = observed().get('opens', 0)
    key(b'/zerg config\r', 'actual canonical configuration TUI command (no run automation)')
    until(lambda: observed().get('opens') == command_opens + 1, 'actual config command component')
    close_manage()
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'restore unsubmitted draft after command')
    draft(value)
    opened = open_manage()
    key(b'\x1bg', 'repeat opener with modal already owning input')
    steady()
    assert observed().get('opens') == opened, 'duplicate management overlays'
    before_work = [(r['sessionId'], r['starts'], r['ends']) for r in observed()['native'] if not r['disposed']]
    request_before = load('http-count.json')['requests']
    close_manage()
    draft(value)
    assert before_work == [(r['sessionId'], r['starts'], r['ends']) for r in observed()['native'] if not r['disposed']]
    assert load('http-count.json')['requests'] == request_before, 'Closing monitor changed provider work'
    assert len(before_work) == 3, 'Closing monitor cancelled genuine mixed work'
    key(b'Z', 'editor focus continuity')
    draft(value + 'Z')
    # Real modal command, not a fake hasOverlay flag. This intentional fixture
    # command submission is separate from the unsubmitted draft acceptance above.
    clear_draft('explicitly clear ONLY synthetic test draft')
    key(b'/s9modal\r', 'owned public modal command')
    until(lambda: load('modal-open.json'), 'real confirm dialog active')
    modal_opens = load('modal-open.json')['opens']
    key(b'\x1bg', 'opener rejected while another modal owns input')
    steady()
    assert observed().get('opens') == modal_opens
    key(b'\x1b', 'close owned confirm modal without approval')
    until(lambda: load('modal-closed.json'), 'real modal closed')
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'restore synthetic draft through actual input')
    draft(value)
    for cols, rows in [(40, 20), (240, 55), (40, 6), (240, 55)]:
        resize(cols, rows)
        draft(value)
    put('ui-live.json', {'assertions': ['unsubmitted-multiline-draft', 'paste-no-open', 'modal-no-steal',
         'active-shortcut-shared-config', 'command-shortcut-component-latch', 'no-duplicate-overlay', 'close-without-cancel',
         'draft-focus-continuity', 'footer-widget-coexistence', 'wide-narrow-wide', 'short-resize']})
def settings_ui():
    until(lambda: load('stage.json').get('stage') == 'settings', 'terminal runs settled')
    open_manage()
    # New overlays start at tree; Tab moves to settings, where o opens Input.
    offset = len(raw)
    key(b'\t', 'actual settings focus via Tab')
    key(b'o', 'actual UI preference subview')
    until(lambda: emitted('2 UI preferences', offset) and emitted('Active: alt+g', offset)
          and emitted('Desired: alt+g', offset)
          and emitted('Shortcut: type key, off, or default; Enter saves', offset), 'fresh editable preference UI')
    path = root + '/agent/zerg-swarm/ui.json'
    def desired():
        try:
            return json.load(open(path))['managementShortcut']
        except FileNotFoundError:
            return None
    # Input.setValue retains caret0: documented Ctrl+E then Ctrl+U clears ALL.
    key(b'\x05\x15alt+j\r', 'desired Alt+j save using actual settings Input')
    until(lambda: desired() == 'alt+j', 'human-only desired setting saved')
    offset = len(raw)
    # A same-size SIGWINCH need not repaint unchanged Active text in Pi.
    resize(239, 55)
    resize(240, 55)
    until(lambda: emitted('Active: alt+g', offset) and emitted('Desired: alt+j', offset)
          and emitted('pending /reload', offset), 'active versus desired reload semantics')
    for binding in [b'ctrl+i', b'alt+k', b'alt+n']:
        key(b'\x05\x15' + binding + b'\r', 'real ambiguity/extension/user collision proposal')
        steady()
        assert desired() == 'alt+j', 'invalid proposal overwrote previous desired binding'
    offset = len(raw)
    key(b'\x1b', 'leave preferences subview only')
    until(lambda: emitted('2 Settings', offset), 'preferences closed before next key')
    close_manage()
    key(b'\x1bk', 'previously owned companion binding remains usable')
    until(lambda: load('collision-fired.json').get('ok'), 'genuine conflicting shortcut retains authority')
    put('ui-settings.json', {'assertions': ['alternate-alt-j', 'real-conflict-rejected', 'ctrl-i-rejected',
        'desired-versus-active'] + load('ui-live.json')['assertions']})
def reload_ui():
    until(lambda: load('stage.json').get('stage') == 'reload-ready', 'settled owner ready for actual reload')
    old = observed()['generation']
    value = 'S9 RELOAD DRAFT 一\nnever submitted to model'
    clear_draft('clear ONLY old synthetic draft')
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'real unsubmitted draft before reload')
    draft(value)
    request_before = load('http-count.json')['requests']
    assert all(row['disposed'] for row in observed()['native'])
    # /reload intentionally clears its command buffer in Pi. Do not claim that
    # the draft continues across this intentional command submission. Restore it
    # by actual paste after reload; test new focus and unsent content separately.
    clear_draft('intentionally clear synthetic draft to submit Pi /reload')
    key(b'/reload\r', 'actual Pi built-in reload; no zerg execution automation')
    until(lambda: observed().get('generation', 0) > old and load('stage.json').get('stage') == 'reload', 'same-process new Pi generation')
    steady()
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'restore unsent draft via actual new-generation editor')
    draft(value)
    before = observed()['opens']
    key(b'\x1bg', 'old Alt+g must no longer open')
    steady()
    assert observed()['opens'] == before
    # Old escape bytes may become ordinary editor input now; clear only test text.
    clear_draft('clear synthetic old-binding input')
    key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'restore unsent draft')
    draft(value)
    open_manage(b'\x1bj')
    offset = len(raw)
    key(b'\t', 'reload settings focus via Tab')
    key(b'o', 'reload UI preferences')
    until(lambda: emitted('2 UI preferences', offset) and emitted('Active: alt+j', offset)
          and emitted('Desired: alt+j', offset)
          and emitted('Shortcut: type key, off, or default; Enter saves', offset), 'fresh desired key activates on same-process reload')
    offset = len(raw)
    key(b'\x1b', 'leave reload preferences')
    until(lambda: emitted('2 Settings', offset), 'reload preferences closed before next key')
    close_manage()
    draft(value)
    key(b'Z', 'new-generation editor focus continuity')
    draft(value + 'Z')
    assert load('http-count.json')['requests'] == request_before, 'Reload/history/UI created provider work before explicit fresh run'
    put('ui-reload.json', {'assertions': ['reload', 'reload-draft-focus', 'reload-old-resources-retired'],
        'draftContract': 'intentional /reload command clears old synthetic buffer; actual paste restores unsubmitted draft afterward',
        'oldGeneration': old, 'newGeneration': observed()['generation']})
def restart_ui():
    until(lambda: load('stage.json').get('stage') == 'restart', 'inert fresh restart inspected')
    assert not observed().get('native'), 'recovery replayed SDK work'
    offset = len(raw)
    resize(240, 55)
    open_manage(b'\x1bj')
    offset = len(raw)
    key(b'\t', 'restart settings focus via Tab')
    key(b'o', 'restart UI preference subview')
    until(lambda: emitted('2 UI preferences', offset) and emitted('Active: alt+j', offset)
          and emitted('Desired: alt+j', offset)
          and emitted('Shortcut: type key, off, or default; Enter saves', offset), 'fresh new generation activates desired alternate')
    offset = len(raw)
    key(b'\x1b', 'leave restart preference subview')
    until(lambda: emitted('2 Settings', offset), 'restart preferences closed before next key')
    close_manage()
    put('ui-restart.json', {'assertions': ['fresh-restart']})
def launch(phase):
    global proc, master
    env = {'PATH': '/usr/bin:/bin', 'HOME': root + '/home', 'TMPDIR': root + '/tmp',
           'LANG': 'C.UTF-8', 'XDG_CONFIG_HOME': root + '/xdg', 'XDG_CACHE_HOME': root + '/xdg',
           'XDG_DATA_HOME': root + '/xdg', 'PI_CODING_AGENT_DIR': root + '/agent',
           'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0',
           'STAGE9_ROOT': root, 'STAGE9_PHASE': phase}
    args = [config['node'], '--max-old-space-size=512', '--import', root + '/preload.mjs']
    if mode == 'sdk':
        args += [root + '/sdk-bootstrap.mjs']
        proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 55, 240, 0, 0))
        env['TERM'] = 'xterm-256color'
        args += [config['cli'], '--offline', '--no-session', '--no-approve', '--no-extensions',
                 '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
                 '--no-tools', '--model', 'fixture/solo', '--thinking', 'off',
                 '--tui-mode', mode, '-e', config['fixture']]
        proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
    report['captures'][phase] = len(raw)
try:
    for phase in ['live', 'restart']:
        launch(phase)
        if mode != 'sdk':
            if phase == 'live':
                live_ui()
                settings_ui()
                reload_ui()
            else:
                restart_ui()
        target = 17 if phase == 'live' else len(STAGE9_PLAN)
        while progress.index < target:
            assert not stopping, 'Controller stopping'
            pump()
            if load('failure.json') or load('server-failure.json'):
                raise Exception('Fixture failed: ' + str(load('failure.json') or load('server-failure.json')))
            if progress.index < target:
                assert proc.poll() is None, 'Host exited before verified protocol completion'
        until(lambda: load('phase-finished.json').get('phase') == phase, 'verified fixture phase completed', True)
        until(lambda: proc.poll() is not None, 'natural isolated host shutdown', True)
        assert proc.returncode == 0
        end = time.monotonic() + 4
        while time.monotonic() < end:
            reap()
            if not owned():
                break
            time.sleep(.02)
        assert not owned(), 'Owned native descendants leaked after host exit'
        if master is not None:
            os.close(master)
            master = None
    report['ok'] = True
except Exception as error:
    report['error'] = str(error)[-10000:]
finally:
    leaked = bool(owned())
    end = time.monotonic() + 8
    term_end = time.monotonic() + 3
    while time.monotonic() < end:
        members = owned()
        if not members:
            break
        for value in members.values():
            send(value, signal.SIGTERM if time.monotonic() < term_end else signal.SIGKILL)
        if proc and proc.poll() is not None:
            reap()
        time.sleep(.02)
    if proc:
        proc.poll()
    reap()
    report.update({'remaining': list(owned()), 'seen': list(seen.values()),
                   'hostExit': proc.returncode if proc else None, 'cleanupRequired': leaked})
    if report['remaining'] or leaked:
        report['ok'] = False
    with open(root + '/evidence/terminal.ansi', 'wb') as f:
        f.write(raw)
    if master is not None:
        os.close(master)
    put('pty-result.json', report)
if not report['ok']:
    sys.exit(1)
