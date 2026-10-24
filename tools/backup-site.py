#!/usr/bin/env python3
"""Private source/state backup with checksummed restore verification; no network access."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
from datetime import datetime, timezone


def verify(archive_path, restore_dir=None):
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            if (not member.isfile() or Path(member.name).is_absolute() or '\\' in member.name
                    or ':' in member.name or '..' in Path(member.name).parts):
                raise ValueError('Unsafe backup member')
        manifest = json.load(archive.extractfile('BACKUP-MANIFEST.json'))
        member_names = {member.name for member in members}
        if not isinstance(manifest, dict) or any(name not in member_names for name in manifest):
            raise ValueError('Invalid backup manifest')
        if restore_dir:
            restore_dir = Path(restore_dir).resolve()
            restore_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name, expected in manifest.items():
            target_file = None
            if restore_dir:
                target = restore_dir / name
                if not target.resolve().is_relative_to(restore_dir):
                    raise ValueError('Unsafe restore destination')
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target_file = target.open('wb')
                target.chmod(0o600)
            digest = hashlib.sha256()
            try:
                with archive.extractfile(name) as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                        if target_file: target_file.write(chunk)
            finally:
                if target_file: target_file.close()
            if digest.hexdigest() != expected:
                raise ValueError('Backup checksum mismatch: ' + name)
        return len(manifest)


def backup(root, destination, retention=7):
    os.umask(0o077)
    root, destination = Path(root).resolve(), Path(destination).resolve()
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.chmod(0o700)
    files = set()
    for directory in ('server', 'public', 'config', 'map', 'scripts', 'tools'):
        for path in (root / directory).rglob('*'):
            if path.is_file() and not path.is_symlink() and '__pycache__' not in path.parts and '.pyc' != path.suffix:
                files.add(path)
    for name in ('server.js', 'package.json', 'package-lock.json', '.gitignore', 'README.md'):
        if (root / name).is_file():
            files.add(root / name)
    for path in (root / '.cache').glob('*.json*'):
        if path.is_file(): files.add(path)
    if (root / '.cache/bilibili-cookie.txt').is_file():
        files.add(root / '.cache/bilibili-cookie.txt')
    pointer = root / '.cache/profile-index-current.json'
    if pointer.exists():
        name = json.loads(pointer.read_text())['filename']
        if Path(name).name == name and name.startswith('profile-index-') and name.endswith('.sqlite'):
            if (root / '.cache' / name).is_file(): files.add(root / '.cache' / name)
    state_dir = root / '.cache/danmaku'
    if state_dir.exists():
        files.update(p for p in state_dir.rglob('*.json') if p.is_file() and not p.is_symlink())
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = destination / ('aoe2de-' + timestamp + '.tar.gz')
    temporary = target.with_suffix('.gz.partial')
    manifest = {}
    try:
        with tarfile.open(temporary, 'w:gz') as archive:
            for path in sorted(files):
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    continue
                name = path.relative_to(root).as_posix()
                if path.stat().st_size > 8 * 1024 * 1024 and path.suffix != '.json':
                    digest = hashlib.sha256()
                    with path.open('rb') as source:
                        while chunk := source.read(1024 * 1024): digest.update(chunk)
                        source.seek(0)
                        info = tarfile.TarInfo(name); info.size = os.fstat(source.fileno()).st_size; info.mode = 0o600
                        archive.addfile(info, source)
                    manifest[name] = digest.hexdigest()
                    continue
                content = path.read_bytes()
                # Atomic JSON state is backed up as one complete snapshot. Do
                # not quietly publish an archive containing corrupted state.
                if path.suffix == '.json' and '.cache' in path.parts:
                    json.loads(content)
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(content), 0o600
                archive.addfile(info, io.BytesIO(content))
                manifest[name] = hashlib.sha256(content).hexdigest()
            content = json.dumps(manifest).encode()
            info = tarfile.TarInfo('BACKUP-MANIFEST.json'); info.size = len(content); info.mode = 0o600
            archive.addfile(info, io.BytesIO(content))
        count = verify(temporary)
        temporary.replace(target)
        for old in sorted(destination.glob('aoe2de-*.tar.gz'), reverse=True)[retention:]:
            old.unlink()
        return {'archive': str(target), 'files': count, 'verified': True, 'bytes': target.stat().st_size}
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/opt/aoe2de-cn')
    parser.add_argument('--destination', default='/var/backups/aoe2de-cn')
    parser.add_argument('--verify')
    parser.add_argument('--restore-dir')
    args = parser.parse_args()
    if args.verify:
        print(json.dumps({'verified': True, 'files': verify(args.verify, args.restore_dir)}))
    else:
        print(json.dumps(backup(args.root, args.destination)))
