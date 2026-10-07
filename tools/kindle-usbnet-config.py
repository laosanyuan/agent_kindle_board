#!/usr/bin/env python3
"""USBNetwork 装完后，配置 Kindle 的 WiFi SSH。

用法（Kindle 以 U 盘模式插着电脑时）：
    python tools/kindle-usbnet-config.py          # 自动找盘符
    python tools/kindle-usbnet-config.py E:       # 指定盘符

做三件事：
  1. usbnet/etc/config  打开 WiFi SSH（USE_WIFI / USE_WIFI_SSHD_ONLY）
  2. usbnet/etc/authorized_keys  写入本机公钥（FW>=5.3 root 账户被锁，只能公钥登录）
  3. usbnet/auto        开机自动拉起 sshd（不切换 USB 模式，U 盘仍可用）

注意：config 必须用 UNIX 换行（LF），否则 hack 读不出来。
"""
import os
import sys
import string

PUBKEY = os.path.expanduser('~/.ssh/id_rsa.pub')

# 关键三行：WiFi SSH + 只起 sshd（不动 USB 大容量存储）+ 用 dropbear
WANT = {
    'USE_WIFI': 'true',
    'USE_WIFI_SSHD_ONLY': 'true',
    'USE_OPENSSH': 'false',
}


def find_drive():
    for letter in string.ascii_uppercase:
        root = f'{letter}:/'
        try:
            if os.path.isdir(os.path.join(root, 'usbnet', 'etc')):
                return root
        except OSError:
            continue
    return None


def write_lf(path, text):
    with open(path, 'wb') as f:
        f.write(text.replace('\r\n', '\n').encode('utf-8'))


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else find_drive()
    if not root:
        print('没找到 usbnet/etc 目录。先确认：')
        print('  1) USBNetwork 已通过「更新您的 Kindle」装好并重启过')
        print('  2) Kindle 用 U 盘模式插着电脑')
        return 1
    if not root.endswith(('/', '\\')):
        root += '/'

    usbnet = os.path.join(root, 'usbnet')
    etc = os.path.join(usbnet, 'etc')
    print(f'找到 Kindle: {root}')

    # 1) config
    cfg_path = os.path.join(etc, 'config')
    lines = []
    if os.path.exists(cfg_path):
        with open(cfg_path, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.read().replace('\r\n', '\n').split('\n')
    out = []
    seen = set()
    for ln in lines:
        key = ln.split('=')[0].strip()
        if key in WANT:
            out.append(f'{key}="{WANT[key]}"')
            seen.add(key)
        else:
            out.append(ln)
    for key, val in WANT.items():
        if key not in seen:
            out.append(f'{key}="{val}"')
    write_lf(cfg_path, '\n'.join(out))
    print('  config 已写入:', ', '.join(f'{k}={v}' for k, v in WANT.items()))

    # 2) authorized_keys
    if not os.path.exists(PUBKEY):
        print(f'  !! 本机没有 {PUBKEY}，跳过公钥写入（之后将只能靠密码登录，而 root 被锁）')
    else:
        with open(PUBKEY, 'r', encoding='utf-8') as f:
            key = f.read().strip()
        ak_path = os.path.join(etc, 'authorized_keys')
        old = ''
        if os.path.exists(ak_path):
            with open(ak_path, 'r', encoding='utf-8', errors='replace') as f:
                old = f.read()
        if key not in old:
            write_lf(ak_path, (old.rstrip('\n') + '\n' if old.strip() else '') + key + '\n')
            print('  已写入 authorized_keys:', key[:40] + '...')
        else:
            print('  authorized_keys 里已有本机公钥，跳过')

    # 3) auto（空白文件，开机自动起 sshd）
    auto_path = os.path.join(usbnet, 'auto')
    if not os.path.exists(auto_path):
        with open(auto_path, 'wb') as f:
            f.write(b'')
        print('  已创建 usbnet/auto（开机自动起 sshd）')
    else:
        print('  usbnet/auto 已存在')

    print('\n完成。安全弹出 → 拔线 → Kindle 上重启一次，sshd 就会随开机起来。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
