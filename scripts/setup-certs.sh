#!/usr/bin/env bash
# Генерує самопідписаний сертифікат у ./certs для ДЗ №3.
# Серти в .gitignore — перегенерувати будь-коли: npm run certs
#
#   localhost  SAN=localhost + 127.0.0.1, дійсний 365 днів
#              -> openssl s_client покаже verify error:num=18 (self-signed)
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

echo "openssl: $(openssl version)"

# Саме ця команда процитована в README — якщо міняєш її тут, онови й там:
# acceptance criteria вимагають наявності `openssl req -x509 -newkey rsa:2048 -nodes`
# у README.md.
#
# Чому такі прапорці:
#   -x509      одразу самопідписаний сертифікат, а не CSR на підпис комусь
#   -nodes     («no DES») не шифрувати приватний ключ парольною фразою —
#              інакше сервер питав би пароль на кожному старті
#   -addext SAN  сучасні клієнти (curl, браузери, Node) звіряють ім'я хоста
#              з SubjectAltName, а CN ігнорують; без SAN буде не 18, а помилка імені
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/localhost-key.pem \
  -out    certs/localhost-cert.pem \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1

echo "  certs/localhost-cert.pem + localhost-key.pem  (SAN=DNS:localhost,IP:127.0.0.1, 365 днів)"
echo
echo "готово. вміст certs/:"
ls -1 certs/

# Прострочений серт (код 10) тут НЕ генерується свідомо: прапорці
# `-not_before/-not_after` з'явились у `openssl req` аж у OpenSSL 3.5,
# а тут $(openssl version). На 3.5+ його дає:
#   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/expired-key.pem \
#     -out certs/expired-cert.pem -subj "/CN=localhost" \
#     -addext "subjectAltName=DNS:localhost" \
#     -not_before 20240101000000Z -not_after 20240201000000Z
# Для ДЗ він не потрібен — пункт 5 просить пояснити лише код self-signed.
