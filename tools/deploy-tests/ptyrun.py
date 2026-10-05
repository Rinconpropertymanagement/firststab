#!/usr/bin/env python3
# Like ptyrun.py, but an answer may be "@@<shell command>@@<text to type>": the shell command runs
# first (to simulate something happening while the prompt waits), then the text is typed.
import os, pty, select, subprocess, sys, time
args = sys.argv[1:]
i = args.index('--')
answers = [a.split('=>', 1) for a in args[:i]]
cmd = args[i+1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
buf = b''
pending = list(answers)
start = time.time()
while True:
    if time.time() - start > 240:
        os.kill(pid, 9); print('\n[ptyrun] TIMEOUT'); break
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try: data = os.read(fd, 4096)
        except OSError: data = b''
        if not data: break
        sys.stdout.buffer.write(data); sys.stdout.flush()
        buf += data
        if pending and pending[0][0].encode() in buf:
            prompt, answer = pending.pop(0)
            time.sleep(0.3)
            if answer.startswith('@@'):
                _, shcmd, answer = answer.split('@@', 2)
                subprocess.run(shcmd, shell=True)
            os.write(fd, (answer + '\n').encode())
            buf = b''
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
if pending: print('\n[ptyrun] NOTE: prompts never seen: ' + ', '.join(p[0] for p in pending))
sys.exit(code)
