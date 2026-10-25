#!/usr/bin/env bash
# Prepare BundoPay on this computer: check the tools, create the config files, and install packages.
# Safe to run again: it never overwrites a config value you've already filled in.
# Then run ./dev.sh to start the app.
set -euo pipefail
cd "$(dirname "$0")"

ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; missing=1; }

echo "Checking tools..."
missing=0
command -v git >/dev/null && ok "git" || fail "git: install it (docs/SETUP.md step 2)"
if command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
else
  fail "Python 3.12 or newer: install it (docs/SETUP.md step 2)"
fi
command -v uv >/dev/null && ok "uv" || fail "uv: install it, then open a new terminal (docs/SETUP.md step 2)"
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  ok "node $(node --version)"
else
  fail "Node.js 20 or newer: install it (docs/SETUP.md step 2)"
fi
command -v npm >/dev/null && ok "npm" || fail "npm: it comes with Node.js (docs/SETUP.md step 2)"
[ "$missing" -eq 0 ] || { echo; echo "Install the missing tools, open a new terminal, and run ./setup.sh again."; exit 1; }

echo
echo "Config files..."
for pair in "backend/.env.example:backend/.env" "frontend/.env.example:frontend/.env.local"; do
  src=${pair%%:*} dst=${pair#*:}
  if [ -f "$dst" ]; then ok "$dst already exists, keeping it"; else cp "$src" "$dst"; ok "created $dst from $src"; fi
done

# Fill APPROVAL_SIGNING_KEY with a random key if it's still empty.
python3 - <<'EOF'
import re, secrets
path = "backend/.env"
text = open(path).read()
if re.search(r"^APPROVAL_SIGNING_KEY=\s*$", text, re.M):
    text = re.sub(r"^APPROVAL_SIGNING_KEY=\s*$", "APPROVAL_SIGNING_KEY=" + secrets.token_urlsafe(48), text, count=1, flags=re.M)
    open(path, "w").write(text)
    print("  ✓ generated APPROVAL_SIGNING_KEY")
EOF

echo
echo "Installing packages (this can take a few minutes the first time)..."
(cd backend && uv sync)
(cd frontend && npm install)
chmod +x dev.sh

echo
echo "Checking required settings..."
python3 - <<'EOF'
required = {
    "backend/.env": ["PAYPAL_PARTNER_CLIENT_ID", "PAYPAL_PARTNER_CLIENT_SECRET", "PAYPAL_PARTNER_MERCHANT_ID",
                     "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "APPROVAL_SIGNING_KEY"],
    "frontend/.env.local": ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
}
empty = []
for path, keys in required.items():
    values = {}
    for line in open(path):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()
    empty += [f"{path}: {k}" for k in keys if not values.get(k)]
    if path == "backend/.env":
        if "YOUR-PASSWORD" in values.get("DATABASE_URL", "") and not values.get("DATABASE_PASSWORD"):
            empty.append(f"{path}: DATABASE_PASSWORD")
        if values.get("PAYPAL_DEV_SELF_MERCHANT", "").lower() != "true":
            print("  ! PAYPAL_DEV_SELF_MERCHANT isn't true, so there'll be no 'Use test account' button (docs/SETUP.md step 7.3)")
if empty:
    print("  Still to fill in (docs/SETUP.md step 7):")
    for e in empty:
        print("    - " + e)
    print("\nFill these in, then run ./dev.sh")
else:
    print("  ✓ all required settings are filled in\n\nReady. Run ./dev.sh and open http://localhost:3000")
EOF
