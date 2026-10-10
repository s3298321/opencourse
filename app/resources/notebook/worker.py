"""OpenCourse's stdlib-only cell worker. Control uses fd 3/4, never stdout."""
import ast
import json
import linecache
import os
import sys
import threading
import traceback
import types
import time
import signal
import __future__

requests = os.fdopen(3, 'r', encoding='utf-8')
events = os.fdopen(4, 'w', encoding='utf-8', buffering=1)
lock = threading.Lock()
learner_module = types.ModuleType('__main__')
namespace = learner_module.__dict__
namespace['__builtins__'] = __builtins__
sys.modules['__main__'] = learner_module
future_flags = 0
sys.stdin = open(os.devnull, 'r')
parent_pid = os.getppid()


def watch_parent():
    # Force-quitting Electron bypasses main's shutdown hooks. Do not leave a
    # running cell or its managed subprocesses behind after their owner exits.
    while True:
        time.sleep(0.25)
        if parent_pid <= 1 or os.getppid() != parent_pid:
            os.killpg(os.getpgrp(), signal.SIGKILL)


threading.Thread(target=watch_parent, daemon=True).start()


def emit(value):
    with lock:
        events.write(json.dumps(value, ensure_ascii=True) + '\n')
        events.flush()


def capture(fd, kind, run_id):
    # Incremental decoding also handles a UTF-8 character split across reads.
    import codecs
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    with os.fdopen(fd, 'rb', buffering=0) as stream:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                emit({'type': kind, 'runId': run_id, 'text': text})
        tail = decoder.decode(b'', final=True)
        if tail:
            emit({'type': kind, 'runId': run_id, 'text': tail})


emit({'type': 'ready'})
for line in requests:
    request = json.loads(line)
    run_id = request['runId']
    code = request['code']
    filename = request['filename']
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    saved = [os.dup(1), os.dup(2)]
    readers = []
    for fd, kind in [(1, 'stdout'), (2, 'stderr')]:
        read_fd, write_fd = os.pipe()
        os.dup2(write_fd, fd)
        os.close(write_fd)
        thread = threading.Thread(target=capture, args=(read_fd, kind, run_id), daemon=True)
        thread.start()
        readers.append(thread)
    status = 'complete'
    try:
        tree = compile(code, filename, 'exec', flags=future_flags | ast.PyCF_ONLY_AST, dont_inherit=True)
        # Compile the full cell first: invalid trailing code must not execute its prefix.
        compiled = compile(tree, filename, 'exec', flags=future_flags, dont_inherit=True)
        for name in __future__.all_feature_names:
            future_flags |= compiled.co_flags & getattr(__future__, name).compiler_flag
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
            exec(compile(tree, filename, 'exec', flags=future_flags, dont_inherit=True), namespace)
            result = eval(compile(ast.Expression(last.value), filename, 'eval', flags=future_flags, dont_inherit=True), namespace)
            if result is not None:
                namespace['_'] = result
                print(repr(result))
        else:
            exec(compiled, namespace)
    except BaseException:
        status = 'failed'
        traceback.print_exc()
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except BaseException:
            pass
        for fd, original in zip((1, 2), saved):
            os.dup2(original, fd)
            os.close(original)
        # Normally EOF arrives immediately. Background subprocesses must not block
        # the control loop forever; their late output retains the original run ID.
        for thread in readers:
            thread.join(timeout=0.1)
    emit({'type': 'done', 'runId': run_id, 'status': status})
