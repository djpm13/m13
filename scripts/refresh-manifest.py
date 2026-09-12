import base64, hashlib, os, re, sys
p = sys.argv[1] if len(sys.argv) > 1 else 'dist/latest-mac.yml'
d = os.path.dirname(p) or '.'
s = open(p).read()
def digest(f):
    h = hashlib.sha512()
    with open(f, 'rb') as fh:
        for c in iter(lambda: fh.read(1 << 20), b''):
            h.update(c)
    return base64.b64encode(h.digest()).decode()
changed = []
def fix(m):
    name = m.group('name').strip()
    path = os.path.join(d, name)
    if not name.endswith('.dmg') or not os.path.exists(path):
        return m.group(0)
    new = '  - url: %s\n    sha512: %s\n    size: %d' % (name, digest(path), os.path.getsize(path))
    if new != m.group(0):
        changed.append(name)
    return new
s = re.sub(r'  - url: (?P<name>[^\n]+)\n    sha512: [^\n]+\n    size: \d+', fix, s)
open(p, 'w').write(s)
print("  refreshed DMG entries:", ", ".join(changed) if changed else "(already current)")
