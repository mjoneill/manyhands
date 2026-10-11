#!/usr/bin/env python3
"""
#1672 -- macOS only. Which of the given pids hold an EXACT environment entry?

stdin:  line 1 is the entry (NAME=value); every following line is a pid.
stdout: the pids whose environment contains that entry as one whole entry, one per line; and `?<pid>` for a process
        whose record does not have the expected layout, so ownership cannot be decided (the caller then never kills
        it, and fails the run and keeps the folder). Nothing else, ever: no argv, no environment text (it can hold
        credentials).
exit:   0 when the table was read; 2 when the kernel interface itself is unusable (the caller fails closed).

Why not `ps -E`: it prints argv and environment joined by spaces, so an entry boundary cannot be told from a space
inside a value, and a variable whose value merely CONTAINS the token text would read as owning it. KERN_PROCARGS2 is
the structured record ps reads: argc, the exec path, argc argv strings, then the environment strings, each
NUL-terminated. A pid we may not read (another user's, or gone) is simply not owned.
"""
import ctypes
import ctypes.util
import struct
import sys

CTL_KERN = 1
KERN_ARGMAX = 8
KERN_PROCARGS2 = 49


def main():
    lines = sys.stdin.read().split('\n')
    entry = lines[0].encode('utf-8', 'surrogateescape')
    pids = [int(x) for x in lines[1:] if x.strip().isdigit()]
    try:
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        sysctl = libc.sysctl
    except Exception:
        return 2

    argmax = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    mib = (ctypes.c_int * 2)(CTL_KERN, KERN_ARGMAX)
    if sysctl(mib, 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0 or argmax.value <= 0:
        return 2

    out = []
    for pid in pids:
        buf = ctypes.create_string_buffer(argmax.value)
        size = ctypes.c_size_t(argmax.value)
        mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
        if sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
            continue  # gone, or not ours to read: not owned
        raw = buf.raw[:size.value]
        if len(raw) < 4:
            continue
        argc = struct.unpack('i', raw[:4])[0]
        # The record: argc (4 bytes), the exec path and its NUL, NUL padding so that argv starts 8-byte aligned
        # counting from just after argc, then argc argv strings, then the environment strings. The start of argv is
        # COMPUTED from that alignment, not found by skipping NULs: an EMPTY argv[0] is itself a lone NUL, and skipping
        # it would shift the argv/environment split by one (measured 2026-10-11: a token as the first environment entry
        # of a process with argv0 '' then read as not owned).
        end = raw.find(b'\0', 4)
        if end < 0 or argc < 0:
            out.append('?' + str(pid))
            continue
        start = end + 1
        while (start - 4) % 8 != 0:
            start += 1
        if any(raw[end + 1:start]) or start > len(raw):
            out.append('?' + str(pid))  # the padding is not all NUL: not the layout we know, so undecidable
            continue
        strings = raw[start:].split(b'\0')
        if len(strings) < argc:
            out.append('?' + str(pid))
            continue
        env = strings[argc:]
        for e in env:
            if e == b'':
                break  # the environment ends at the first empty string
            if e == entry:
                out.append(str(pid))
                break
    sys.stdout.write('\n'.join(out) + ('\n' if out else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
