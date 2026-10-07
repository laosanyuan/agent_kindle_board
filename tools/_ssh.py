# 临时：通过 SSH 在群晖上执行命令
import sys, paramiko
HOST, USER, PASS = '192.168.100.218', 'yuanhonglai', 'Yuan123456'
cmd = ' '.join(sys.argv[1:]) or 'whoami'
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, USER, PASS, timeout=20, allow_agent=False, look_for_keys=False)
stdin, stdout, stderr = c.exec_command(cmd, timeout=180)
print(stdout.read().decode('utf-8', 'ignore'), end='')
e = stderr.read().decode('utf-8', 'ignore')
if e.strip():
    print('[stderr] ' + e[:800])
c.close()
