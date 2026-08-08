#!/usr/bin/env bash
# Прогін acceptance criteria ДЗ №3 — дослівно тими командами, що в умові.
# Запуск: npm run verify
#
# Скрипт нічого не «підганяє»: він піднімає сервери на тих самих портах 3000/3443,
# що названі в умові, і бʼє по них тими самими curl/grep. Якщо тут зелено —
# зелено буде й у перевіряючого.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
HTTP_PID=""
HTTPS_PID=""

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

ok()   { green "  PASS"; echo "  $1"; PASS=$((PASS + 1)); }
bad()  { red   "  FAIL"; echo "  $1"; [ $# -gt 1 ] && echo "        ↳ $2"; FAIL=$((FAIL + 1)); }

cleanup() {
  [ -n "$HTTP_PID" ]  && kill "$HTTP_PID"  2>/dev/null
  [ -n "$HTTPS_PID" ] && kill "$HTTPS_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_for_port() {
  local port="$1" pid="$2" deadline=$((SECONDS + 10))
  while [ $SECONDS -lt $deadline ]; do
    kill -0 "$pid" 2>/dev/null || return 1   # процес помер — далі чекати нема сенсу
    port_busy "$port" && return 0
    sleep 0.2
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── AC 1: без http/https ───────────────────────────────────────────────"
# Джерело правди й рантайм — .ts напряму (Node ≥22 стрипає типи на льоту),
# тому й грепаємо .ts: окремого build-кроку в проєкті більше нема.

hits=$(grep -REn "(require\(|from )['\"](node:)?https?['\"]" src/ || true)
if [ -z "$hits" ]; then
  ok "жоден файл у src/ не імпортує http/https"
else
  bad "у src/ є імпорт http/https" "$(echo "$hits" | head -5)"
  dim "        (регекс ловить і КОМЕНТАРІ на кшталт // без require('https') — приберіть їх з коду)"
  echo
fi

if grep -q "net.createServer" src/server.ts 2>/dev/null; then
  ok "src/server.ts містить net.createServer"
else
  bad "src/server.ts не містить рядка «net.createServer»" \
      "import { createServer } from 'node:net' збігу НЕ дає — потрібен namespace-імпорт: import net from 'node:net'"
fi

if grep -q "tls.createServer" src/https-server.ts 2>/dev/null; then
  ok "src/https-server.ts містить tls.createServer"
else
  bad "src/https-server.ts не містить рядка «tls.createServer»" \
      "те саме: import tls from 'node:tls' → tls.createServer(...)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── AC 2–3: плейн-сервер на :3000 ──────────────────────────────────────"

if port_busy 3000; then
  bad "порт 3000 уже зайнятий" "зупини те, що на ньому висить: lsof -ti:3000 | xargs kill"
elif [ ! -f src/server.ts ]; then
  bad "немає src/server.ts" "спершу напиши сервер"
else
  node src/server.ts >/dev/null 2>&1 &
  HTTP_PID=$!
  if ! wait_for_port 3000 "$HTTP_PID"; then
    bad "src/server.ts не піднявся на :3000" "перевір, що дефолтний порт саме 3000: Number(process.env.PORT) || 3000"
    HTTP_PID=""
  else
    first_line=$(curl -sv http://localhost:3000/ 2>&1 >/dev/null | grep -m1 '^< HTTP/' | sed 's/^< //; s/\r$//')
    if [ "$first_line" = "HTTP/1.1 200 OK" ]; then
      ok "curl -sv http://localhost:3000/ → $first_line"
    else
      bad "перший рядок відповіді не «HTTP/1.1 200 OK»" "отримано: ${first_line:-（нічого）}"
    fi

    ctype=$(curl -sv http://localhost:3000/ 2>&1 >/dev/null | grep -im1 '^< content-type:' | sed 's/^< //; s/\r$//')
    case "$ctype" in
      [Cc]ontent-[Tt]ype:*text/plain*) ok "хедер $ctype" ;;
      *) bad "Content-Type не text/plain" "отримано: ${ctype:-（хедера немає）}" ;;
    esac

    code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/nope)
    [ "$code" = "404" ] && ok "GET /nope → 404" || bad "GET /nope → $code, очікували 404"

    body=$(curl -s http://localhost:3000/headers -H "X-Demo: abc")
    if echo "$body" | grep -q "^host:" && echo "$body" | grep -q "^x-demo: abc$"; then
      ok "/headers віддає розпарсені заголовки (host:, x-demo: abc)"
    else
      bad "/headers не містить «host:» і/або «x-demo: abc» у lower-case" "тіло:
$(echo "$body" | sed 's/^/          /')"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── AC 4: HTTPS на :3443 ───────────────────────────────────────────────"

if [ ! -f certs/localhost-cert.pem ]; then
  bad "немає certs/localhost-cert.pem" "згенеруй: npm run certs"
elif port_busy 3443; then
  bad "порт 3443 уже зайнятий" "lsof -ti:3443 | xargs kill"
elif [ ! -f src/https-server.ts ]; then
  bad "немає src/https-server.ts" "спершу напиши сервер"
else
  node src/https-server.ts >/dev/null 2>&1 &
  HTTPS_PID=$!
  if ! wait_for_port 3443 "$HTTPS_PID"; then
    bad "src/https-server.ts не піднявся на :3443" "дефолтний порт має бути 3443; перевір і шляхи до cert/key"
    HTTPS_PID=""
  else
    code=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost:3443/)
    if [ "$code" = "200" ]; then
      ok "curl -sk https://localhost:3443/ → 200"
    else
      bad "curl -sk https://localhost:3443/ → $code, очікували 200" \
          "код 000 = зʼєднання не відбулось. Часта причина: socket.destroy() замість socket.end() — TLS обривається без close_notify"
    fi
  fi
fi

if grep -q "openssl req -x509 -newkey rsa:2048 -nodes" README.md 2>/dev/null; then
  ok "README.md містить команду генерації серта"
else
  bad "у README.md немає «openssl req -x509 -newkey rsa:2048 -nodes»" "умова вимагає саме дослівну команду, не лише npm run certs"
fi

if grep -qE '^\*\.(pem|key)$' .gitignore 2>/dev/null; then
  ok ".gitignore ігнорує *.pem і *.key"
else
  bad ".gitignore не ігнорує *.pem / *.key"
fi

tracked=$(git ls-files | grep -E '\.(pem|key)$' || true)
if [ -z "$tracked" ]; then
  ok "жодного .pem/.key не закомічено"
else
  bad "у git лежать ключі/серти" "$tracked"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── AC 5: debug-сесія в README ─────────────────────────────────────────"

if grep -q "openssl s_client -connect localhost:3443" README.md 2>/dev/null &&
   grep -q -- "-servername localhost" README.md 2>/dev/null; then
  ok "README.md містить команду openssl s_client"
else
  bad "у README.md немає «openssl s_client -connect localhost:3443 -servername localhost»"
fi

if grep -q "ВСТАВ СЮДИ" README.md 2>/dev/null; then
  bad "у README.md досі плейсхолдер замість виводу s_client" \
      "прожени команду, вклей вивід у порожній блок під коментарем і видали сам коментар"
elif grep -qE "verify (error|return code)" README.md 2>/dev/null; then
  ok "README.md містить рядок verify error / verify return code"
else
  bad "grep -E \"verify (error|return code)\" README.md не дає збігу" \
      "УВАГА: цей регекс чутливий до регістру. OpenSSL друкує «Verify return code» з ВЕЛИКОЇ V — воно не підійде.
          Треба вклеїти рядок «verify error:num=18:self-signed certificate» з початку виводу s_client."
fi

if grep -q "num=18" README.md 2>/dev/null; then
  ok "README.md пояснює код 18 (self-signed)"
else
  bad "у README.md немає згадки коду 18" "потрібен вивід із verify error:num=18 і одне речення пояснення"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "───────────────────────────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  green "  усі $PASS перевірок зелені"; echo
  echo
  exit 0
fi
red "  провалено: $FAIL"; echo "   ·  пройдено: $PASS"
echo
exit 1
