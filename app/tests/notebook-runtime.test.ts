// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUNDLED_PYTHON_VERSION, bundledPythonPath } from '../src/main/bundled-python'
import { PythonCellWorker, provisionNotebookEnv } from '../src/main/notebook-runtime'
const enabled = Boolean(process.env.OPENCOURSE_TEST_PYTHON)
const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-runtime-')), env = join(root, '.venv'), python = join(env, 'bin', 'python')
const workers: PythonCellWorker[] = []
const worker = (): PythonCellWorker => { const value = new PythonCellWorker(python, resolve(__dirname, '../resources/notebook/worker.py'), root, env); workers.push(value); return value }
const text = (value: Awaited<ReturnType<PythonCellWorker['execute']>>): string => value.outputs.map(output => output.text).join('')
afterAll(async () => { await Promise.all(workers.map(worker => worker.stop())); rmSync(root, { recursive: true, force: true }) })
describe.skipIf(!enabled)('real notebook Python', () => {
  beforeAll(async () => { await provisionNotebookEnv(env, bundledPythonPath(), BUNDLED_PYTHON_VERSION, new AbortController().signal) }, 180_000)
  it('creates an isolated environment offline with pip and no test or notebook dependencies', () => {
    const output = execFileSync(python, ['-c', 'import sys,importlib.util; print(sys.prefix != sys.base_prefix); print([importlib.util.find_spec(n) is not None for n in ["pip", "pytest", "IPython", "ipykernel"]])'], { encoding: 'utf8' })
    expect(output).toContain('True\n[True, False, False, False]')
  })
  it('shares notebook variables, evaluates final expressions and survives ordinary exceptions', async () => {
    const kernel = worker()
    expect((await kernel.execute('value = 40', '<cell-one>', () => {})).status).toBe('complete')
    expect(text(await kernel.execute('value + 2', '<cell-two>', () => {}))).toBe('42\n')
    const failure = await kernel.execute('value / 0', '<cell-error>', () => {})
    expect(failure.status).toBe('failed'); expect(text(failure)).toContain('<cell-error>'); expect(text(failure)).toContain('value / 0')
    expect(text(await kernel.execute('value', '<cell-three>', () => {}))).toBe('40\n')
    expect(text(await kernel.execute('None', '<none>', () => {}))).toBe('')
    const isolated = worker(); expect(text(await isolated.execute('value', '<independent>', () => {}))).toContain('NameError')
  })
  it('streams Unicode and subprocess output without interpreting printed protocol text', async () => {
    const kernel = worker(), updates: string[] = []
    const result = await kernel.execute('import subprocess,sys\nprint("héllo 🌍")\nprint(\'{"type":"done"}\')\nsubprocess.run([sys.executable, "-c", "print(123)"])\nprint("stderr", file=sys.stderr)', '<streams>', run => updates.push(text(run)))
    expect(text(result)).toContain('héllo 🌍'); expect(text(result)).toContain('{"type":"done"}'); expect(text(result)).toContain('123'); expect(text(result)).toContain('stderr')
    expect(updates.some(output => output.includes('héllo'))).toBe(true)
  })
  it('rejects simultaneous execution and stops an infinite loop, with a fresh restart namespace', async () => {
    const kernel = worker()
    const pending = kernel.execute('while True: pass', '<loop>', () => {})
    await expect(kernel.execute('1', '<second>', () => {})).rejects.toThrow('busy')
    await new Promise(resolve => setTimeout(resolve, 100))
    await kernel.stop(); expect((await pending).status).toBe('stopped')
    expect(text(await worker().execute('value', '<restart>', () => {}))).toContain('NameError')
  })
  it('limits output without deadlocking and handles process exit and input', async () => {
    const kernel = worker()
    const result = await kernel.execute('print("x" * (2 * 1024 * 1024))', '<large>', () => {})
    expect(result.truncated).toBe(true); expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(1024 * 1024)
    expect((await kernel.execute('input("name")', '<input>', () => {})).status).toBe('failed')
    expect((await kernel.execute('import os\nos._exit(7)', '<crash>', () => {})).status).toBe('failed')
  })
  it('installs a local wheel using sys.executable, and keeps it across re-provisioning and workers', async () => {
    const wheel = join(root, 'notebook_sample-1.0-py3-none-any.whl')
    execFileSync(python, ['-c', 'import zipfile,sys\nw=zipfile.ZipFile(sys.argv[1],"w")\nw.writestr("notebook_sample.py","answer = 42\\n")\nw.writestr("notebook_sample-1.0.dist-info/METADATA","Metadata-Version: 2.1\\nName: notebook-sample\\nVersion: 1.0\\n")\nw.writestr("notebook_sample-1.0.dist-info/WHEEL","Wheel-Version: 1.0\\nGenerator: opencourse-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")\nw.writestr("notebook_sample-1.0.dist-info/RECORD", "")\nw.close()', wheel])
    const result = await worker().execute(`import subprocess,sys\nsubprocess.check_call([sys.executable, "-m", "pip", "install", "--no-index", ${JSON.stringify(wheel)}])`, '<install>', () => {})
    expect(result.status).toBe('complete')
    await provisionNotebookEnv(env, bundledPythonPath(), BUNDLED_PYTHON_VERSION, new AbortController().signal)
    expect(text(await worker().execute('import notebook_sample\nnotebook_sample.answer', '<dependency>', () => {}))).toBe('42\n')
  }, 30_000)
  it('refuses an incompatible runtime without clearing files', async () => {
    const stamp = join(env, '.opencourse-notebook-runtime.json'), previous = readFileSync(stamp, 'utf8')
    writeFileSync(stamp, JSON.stringify({ version: '3.13.0', base: '/old' }))
    try { await expect(provisionNotebookEnv(env, bundledPythonPath(), BUNDLED_PYTHON_VERSION, new AbortController().signal)).rejects.toThrow('different Python version'); expect(existsSync(python)).toBe(true) }
    finally { writeFileSync(stamp, previous) }
  })
  it('repairs a compatible moved interpreter without losing packages and refuses unrelated damage', async () => {
    const stamp = join(env, '.opencourse-notebook-runtime.json'), original = readFileSync(stamp, 'utf8')
    writeFileSync(stamp, JSON.stringify({ ...JSON.parse(original), base: '/previous/app/location' }))
    renameSync(python, `${python}.previous-location`)
    symlinkSync('/previous/app/location/python3', python)
    await provisionNotebookEnv(env, bundledPythonPath(), BUNDLED_PYTHON_VERSION, new AbortController().signal)
    expect(text(await worker().execute('import notebook_sample\nnotebook_sample.answer', '<after-move>', () => {}))).toBe('42\n')
    renameSync(python, `${python}.damaged`)
    try { await expect(provisionNotebookEnv(env, bundledPythonPath(), BUNDLED_PYTHON_VERSION, new AbortController().signal)).rejects.toThrow('damaged') }
    finally { renameSync(`${python}.damaged`, python) }
    expect(existsSync(python)).toBe(true)
  })
  it('terminates managed descendants and honors lesson execution timeouts', async () => {
    const kernel = worker()
    let childPid = 0
    const pending = kernel.execute('import subprocess,sys,time\nchild=subprocess.Popen([sys.executable,"-c","import time;time.sleep(600)"])\nprint(child.pid, flush=True)\nwhile True: time.sleep(1)', '<children>', run => { const value = Number(text(run).trim()); if (value) childPid = value })
    for (let i = 0; !childPid && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(childPid).toBeGreaterThan(0)
    await kernel.stop(); expect((await pending).status).toBe('stopped')
    for (let i = 0; i < 100; i++) { try { process.kill(childPid, 0) } catch { childPid = 0; break }; await new Promise(resolve => setTimeout(resolve, 10)) }
    expect(childPid).toBe(0)
    expect((await worker().execute('while True: pass', '<timeout>', () => {}, 50)).status).toBe('stopped')
  })
  it('reports persistence callback failures and still closes its process', async () => {
    const kernel = worker()
    await expect(kernel.execute('1+1', '<disk-failure>', () => { throw new Error('Disk is full') })).rejects.toThrow('Disk is full')
    await kernel.stop(); expect(kernel.stopped).toBe(true)
  })
  it('does not leave a busy worker behind if its owner process exits unexpectedly', async () => {
    const script = 'import os,subprocess,sys,json\nr,w=os.pipe()\ner,ew=os.pipe()\nchild=subprocess.Popen([sys.executable,"-u",sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,pass_fds=(r,w,ew),preexec_fn=lambda:os.dup2(ew,4))\nos.close(r);os.close(ew)\nos.fdopen(er,"r").readline()\nos.write(w,(json.dumps({"runId":"orphan","code":"while True: pass","filename":"<orphan>"})+"\\n").encode())\nprint(child.pid,flush=True)\nos._exit(0)'
    const pid = Number(execFileSync(python, ['-c', script, resolve(__dirname, '../resources/notebook/worker.py')], { encoding: 'utf8', timeout: 5000 }).trim())
    let alive = true
    try { for (let i = 0; i < 150; i++) { try { process.kill(pid, 0) } catch { alive = false; break }; await new Promise(resolve => setTimeout(resolve, 10)) }; expect(alive).toBe(false) }
    finally { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  })
})
