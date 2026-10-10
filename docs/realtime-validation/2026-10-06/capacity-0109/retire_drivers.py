# Guarded retirement: only labelled, stopped capacity drivers; logs + identity archived first.
import json, subprocess, sys, pathlib, datetime
dest = pathlib.Path(sys.argv[1]); dest.mkdir(parents=True, exist_ok=True)
names = subprocess.check_output(['docker','ps','-a','--filter','label=orgiq.validation=bff-capacity-driver','--format','{{.Names}}'], text=True).split()
for name in names:
    if not name.startswith('orgiq-bff-capacity-driver-'): continue
    row = json.loads(subprocess.check_output(['docker','inspect',name], text=True))[0]
    if row['Config']['Labels'].get('orgiq.validation') != 'bff-capacity-driver' or row['State']['Running'] or row['State']['Status'] not in ('exited','created'):
        print('skip', name); continue
    fin = row['State']['FinishedAt']
    ts = int(datetime.datetime.fromisoformat(fin[:19]).replace(tzinfo=datetime.timezone.utc).timestamp()) if not fin.startswith('0001') else 0
    base = dest / f'{name}-{ts}'
    logs = subprocess.run(['docker','logs',row['Id']], capture_output=True, text=True)
    base.with_suffix('.log').write_text(logs.stdout + logs.stderr)
    base.with_suffix('.txt').write_text(f"id={row['Id']} exit={row['State']['ExitCode']} finished={fin}\n")
    subprocess.run(['docker','rm',row['Id']], check=True, stdout=subprocess.DEVNULL)
    print('retired', name, row['Id'][:12])
