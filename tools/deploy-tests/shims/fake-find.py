#!/usr/bin/env python3
# TEST HELPER (fake-server mode only): emulates the two read-only GNU `find -printf` forms the
# deploy guard uses, against a LOCAL fake-server folder, because macOS find has no -printf.
#   find DIR -maxdepth 1 -name BASE -printf '%y\n'
#   find DIR '(' -name node_modules -o -name .git ')' -prune -o -printf '%y\t%P\n'
import os, shlex, stat, sys
args = shlex.split(sys.argv[1])
assert args[0] == 'find'
d = args[1]
def typ(p):
    m = os.lstat(p).st_mode
    return 'd' if stat.S_ISDIR(m) else 'l' if stat.S_ISLNK(m) else 'f' if stat.S_ISREG(m) else 'p' if stat.S_ISFIFO(m) else 's' if stat.S_ISSOCK(m) else 'c'
out = sys.stdout.buffer
if '-maxdepth' in args:
    base = args[args.index('-name') + 1]
    if not os.path.isdir(d) or os.path.islink(d):
        sys.stderr.write("find: '%s': No such file or directory\n" % d); sys.exit(1)
    p = os.path.join(d, base)
    if os.path.lexists(p):
        out.write((typ(p) + '\n').encode())
    sys.exit(0)
if not os.path.lexists(d):
    sys.stderr.write("find: '%s': No such file or directory\n" % d); sys.exit(1)
out.write(('%s\t\n' % typ(d)).encode())
if typ(d) == 'd':
    for root, dirs, files in os.walk(d, topdown=True, followlinks=False):
        dirs[:] = sorted(x for x in dirs if x not in ('node_modules', '.git') and not os.path.islink(os.path.join(root, x)))
        names = sorted(x for x in os.listdir(root) if x not in ('node_modules', '.git'))
        for x in names:
            p = os.path.join(root, x)
            out.write(('%s\t%s\n' % (typ(p), os.path.relpath(p, d))).encode('utf-8', 'surrogateescape'))
sys.exit(0)
