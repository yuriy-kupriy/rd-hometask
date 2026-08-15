// Чорноскриньові тести ДЗ №3, пункт 4 — той самий обробник поверх tls.createServer().
//
// Головна теза, яку тут перевіряємо машинно: HTTPS — це не окремий протокол, а
// той самий HTTP по зашифрованому TCP. Тому набір тестів навмисне збігається з
// http.test.mjs, а останній тест порівнює тіла plain- і TLS-відповідей побайтово.
//
// Потрібні серти: npm run certs (certs/ у .gitignore, тож на чистому клоні їх нема).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { existsSync } from 'node:fs';

import { bootServer, sendRaw, parseResponse, buildRequest, CERT, KEY } from './lib/harness.mjs';

// Гачки для прогону проти чужої реалізації (напр. лекційного stages/07-tls.mjs,
// який бере cert/key/порт із argv, а не з env). {PORT} підставляється хелпером.
const TLS_ENTRY = process.env.HW_TLS_ENTRY ?? 'src/https-server.ts';
const TLS_ARGS = process.env.HW_TLS_ARGS ? process.env.HW_TLS_ARGS.split(' ') : [];
const HTTP_ENTRY = process.env.HW_ENTRY ?? 'src/server.ts';

const certsMissing = !existsSync(CERT) || !existsSync(KEY);

describe(
  'ДЗ №3 — HTTPS на tls.createServer()',
  { skip: certsMissing ? `немає ${CERT} — спершу запусти: npm run certs` : false },
  () => {
    let tlsPort;
    let tlsChild;
    let httpPort;
    let httpChild;

    before(async () => {
      ({ port: tlsPort, child: tlsChild } = await bootServer(TLS_ENTRY, { args: TLS_ARGS }));
      ({ port: httpPort, child: httpChild } = await bootServer(HTTP_ENTRY));
    });

    after(() => {
      tlsChild?.kill('SIGKILL');
      httpChild?.kill('SIGKILL');
    });

    const getTls = async (target, headers) =>
      parseResponse(await sendRaw(tlsPort, buildRequest('GET', target, headers), { transport: 'tls' }));

    it('1. TLS-рукостискання проходить, GET / → 200 OK, Content-Type: text/plain', async () => {
      const res = await getTls('/');

      assert.equal(res.status, 200, `статус-рядок: ${JSON.stringify(res.statusLine)}`);
      assert.equal(res.httpVersion, 'HTTP/1.1');
      assert.match(
        res.headers['content-type'] ?? '',
        /^text\/plain\b/,
        `Content-Type має починатись із text/plain, отримано: ${res.headers['content-type']}`,
      );
      assert.ok(res.body.length > 0, 'тіло не має бути порожнім');
    });

    it('2. GET /nope → 404 і по TLS теж', async () => {
      const res = await getTls('/nope');
      assert.equal(res.status, 404, `статус-рядок: ${JSON.stringify(res.statusLine)}`);
    });

    it('3. GET /headers → заголовки розпарсені, ключі в lower-case', async () => {
      const res = await getTls('/headers', { 'X-Demo': 'abc' });

      assert.equal(res.status, 200);
      assert.match(
        res.text,
        /x-demo:\s*abc/,
        `у тілі має бути «x-demo: abc».\nТіло:\n${res.text}`,
      );
      assert.match(res.text, /host:/, `у тілі має бути й «host:».\nТіло:\n${res.text}`);
    });

    it('4. Сервер віддає саме наш самопідписаний серт (CN=localhost, SAN=localhost)', async () => {
      const socket = await new Promise((resolve, reject) => {
        const s = tls.connect(
          { port: tlsPort, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false },
          () => resolve(s),
        );
        s.once('error', reject);
      });

      const cert = socket.getPeerCertificate();
      const protocol = socket.getProtocol();
      socket.destroy();

      assert.equal(cert.subject?.CN, 'localhost', `CN серта: ${JSON.stringify(cert.subject)}`);
      assert.match(
        cert.subjectaltname ?? '',
        /DNS:localhost/,
        `у серті немає SAN=DNS:localhost (${cert.subjectaltname}) — сучасні клієнти звіряють ` +
          `ім'я хоста саме з SAN, а CN ігнорують`,
      );
      // Самопідписаний = issuer збігається з subject. Це рівно та властивість,
      // через яку openssl s_client каже verify error:num=18.
      assert.equal(
        cert.issuer?.CN,
        cert.subject?.CN,
        'серт мав би бути самопідписаним: issuer має збігатися з subject',
      );
      assert.match(protocol ?? '', /^TLSv1\.[23]$/, `узгоджена версія TLS: ${protocol}`);
    });

    it('5. Той самий обробник: тіло GET / по TCP і по TLS збігається побайтово', async () => {
      const plain = parseResponse(await sendRaw(httpPort, buildRequest('GET', '/')));
      const secure = await getTls('/');

      assert.equal(
        secure.body,
        plain.body,
        'тіла відповідей різні — значить обробник для HTTPS написаний окремо, ' +
          'а ДЗ вимагає переюзати той самий.\n' +
          // друкуємо .text, а не .body: порівнюємо сирі байти (latin1), але
          // показувати їх людині як latin1 — це мойбейк на кирилиці
          `по TCP: ${JSON.stringify(plain.text)}\n` +
          `по TLS: ${JSON.stringify(secure.text)}`,
      );
      assert.equal(secure.status, plain.status);
      assert.equal(
        secure.headers['content-type'],
        plain.headers['content-type'],
        'Content-Type різний — знову ж таки ознака двох різних обробників',
      );
    });

    it('6. Розрізаний на два записи запит по TLS теж збирається', async () => {
      const request = buildRequest('GET', '/headers', { 'X-Demo': 'abc' });
      const splitAt = request.indexOf('/headers') + 5;

      const res = parseResponse(await sendRaw(tlsPort, request, { splitAt, transport: 'tls' }));

      assert.equal(res.status, 200, 'запит по частинах дав інший результат, ніж цілий');
      assert.match(res.text, /x-demo:\s*abc/, 'частина заголовків загубилась при склеюванні');
    });

    it('7. Порт справді TLS: відкритий HTTP-запит на нього не обслуговується', async () => {
      // Якби сервер випадково слухав plaintext, цей запит повернув би 200 —
      // і весь пункт 4 ДЗ був би фікцією.
      let raw;
      try {
        raw = await sendRaw(tlsPort, buildRequest('GET', '/'), { transport: 'tcp' });
      } catch {
        return; // сервер обірвав з'єднання на невалідному ClientHello — саме те, що треба
      }

      assert.doesNotMatch(
        raw,
        /^HTTP\/1\.\d 200/,
        'на TLS-порт прилетів голий HTTP і отримав 200 — сервер слухає plaintext, не TLS',
      );
    });
  },
);
