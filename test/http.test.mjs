// Чорноскриньові тести ДЗ №3, пункти 1–3 — сирий HTTP поверх net.createServer().
//
// Ганяються проти ЗІБРАНОГО src/server.js (саме його грепають acceptance criteria),
// тому `npm test` спершу робить `npm run build`. Правиш .ts — запускай npm test,
// а не node --test напряму, інакше перевіриш стару збірку.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootServer, sendRaw, parseResponse, buildRequest } from './lib/harness.mjs';

// HW_ENTRY — службовий гачок: дозволяє прогнати ці ж тести проти іншого сервера
// (напр. еталона з лекції), щоб перевірити самі тести.
const ENTRY = process.env.HW_ENTRY ?? 'src/server.js';

describe('ДЗ №3 — HTTP-сервер на сирому TCP', () => {
  let port;
  let child;

  before(async () => {
    ({ port, child } = await bootServer(ENTRY));
  });

  after(() => {
    child?.kill('SIGKILL');
  });

  const get = async (target, headers) =>
    parseResponse(await sendRaw(port, buildRequest('GET', target, headers)));

  it('1. GET / → 200 OK, Content-Type: text/plain, непорожнє тіло', async () => {
    const res = await get('/');

    assert.equal(res.status, 200, `статус-рядок: ${JSON.stringify(res.statusLine)}`);
    assert.equal(res.httpVersion, 'HTTP/1.1');
    assert.equal(res.reason, 'OK', 'після коду потрібна reason-фраза «OK»');
    assert.match(
      res.headers['content-type'] ?? '',
      /^text\/plain\b/,
      `Content-Type має починатись із text/plain, отримано: ${res.headers['content-type']}`,
    );
    assert.ok(res.body.length > 0, 'тіло не має бути порожнім');
  });

  it('2. GET /nope → 404 з reason-фразою', async () => {
    const res = await get('/nope');

    assert.equal(res.status, 404, `статус-рядок: ${JSON.stringify(res.statusLine)}`);
    assert.ok(
      res.reason.length > 0,
      `після 404 потрібна reason-фраза, отримано: ${JSON.stringify(res.statusLine)}`,
    );
  });

  it('3. GET /headers → 200, заголовки запиту в тілі, ключі в lower-case', async () => {
    const res = await get('/headers', { 'X-Demo': 'abc' });

    assert.equal(res.status, 200);
    assert.match(
      res.text,
      /x-demo:\s*abc/,
      `у тілі має бути «x-demo: abc» (ключ у нижньому регістрі).\nТіло:\n${res.text}`,
    );
    assert.match(
      res.text,
      /host:/,
      `у тілі має бути й «host:» — цей заголовок шле будь-який клієнт.\nТіло:\n${res.text}`,
    );
    assert.doesNotMatch(res.text, /X-Demo/, 'ключ не нормалізовано до lower-case');
  });

  it('4. Нормалізація не залежить від регістру вхідного заголовка', async () => {
    // Значення — навмисно ASCII. Заголовки HTTP/1.1 за RFC 7230 і є ASCII;
    // кирилиця у ЗНАЧЕННІ заголовка не переживає ланцюжок latin1 → utf8 і
    // вертається подвійно закодованою навіть у коректній реалізації.
    // Тому тут перевіряємо рівно те, що вимагає ДЗ: регістр КЛЮЧА.
    const res = await get('/headers', { 'X-MIXED-Case': 'MixedValue-42' });

    assert.equal(res.status, 200);
    assert.match(
      res.text,
      /x-mixed-case:/,
      `ключ у ВЕРХНЬОМУ регістрі теж має стати нижнім.\nТіло:\n${res.text}`,
    );
    assert.match(
      res.text,
      /MixedValue-42/,
      'нормалізується тільки КЛЮЧ — регістр ЗНАЧЕННЯ чіпати не можна',
    );
  });

  it('5. Content-Length дорівнює кількості БАЙТІВ тіла (кирилиця)', async () => {
    // Кирилицю в тіло заганяємо через сам запит: /headers віддає його назад,
    // тож тест не залежить від того, якою мовою написані твої відповіді.
    const res = await get('/headers', { 'X-Cyr': 'привіт-світ' });

    assert.equal(res.status, 200);

    const declared = Number(res.headers['content-length']);
    assert.ok(
      Number.isInteger(declared),
      `заголовок Content-Length відсутній або не число: ${res.headers['content-length']}`,
    );
    assert.equal(
      declared,
      res.bodyBytes,
      `Content-Length оголошено ${declared}, а тіло займає ${res.bodyBytes} байт.\n` +
        `Класична причина: довжину рахували в СИМВОЛАХ (body.length), а не в байтах. ` +
        `У кирилиці один символ — два байти.`,
    );
  });

  it('6. Запит, розрізаний на два TCP-записи, обробляється так само', async () => {
    // Ріжемо всередині шляху: перший write не містить ані кінця request-line,
    // ані CRLFCRLF. Сервер зобов'язаний накопичити й дочекатись.
    const request = buildRequest('GET', '/headers', { 'X-Demo': 'abc' });
    const splitAt = request.indexOf('/headers') + 5; // між «/head» і «ers»

    const res = parseResponse(await sendRaw(port, request, { splitAt }));

    assert.equal(
      res.status,
      200,
      'запит по частинах дав інший результат, ніж цілий — ' +
        'значить одна подія data вважається цілим запитом',
    );
    assert.match(res.text, /x-demo:\s*abc/, 'частина заголовків загубилась при склеюванні');
  });

  it('7. Формат відповіді: статус-рядок, CRLF, рівно один порожній рядок перед тілом', async () => {
    const raw = await sendRaw(port, buildRequest('GET', '/'));

    assert.ok(
      raw.startsWith('HTTP/1.1 '),
      `відповідь має починатись зі «HTTP/1.1 », отримано: ${JSON.stringify(raw.slice(0, 40))}`,
    );

    const sep = raw.indexOf('\r\n\r\n');
    assert.notEqual(sep, -1, 'немає порожнього рядка між заголовками й тілом');

    const head = raw.slice(0, sep);
    assert.doesNotMatch(
      head,
      /(?<!\r)\n/,
      'у заголовках є голий \\n — роздільник HTTP це \\r\\n, а не \\n',
    );
    assert.ok(head.split('\r\n').length >= 2, 'після статус-рядка має бути хоча б один заголовок');
  });

  // Поки ти не вирішив, як сервер ставиться до методу, «правильної» відповіді немає.
  // Специфікація ДЗ описує лише GET. Обери 404 / 405 / «ігнорувати метод» — і скажи мені,
  // я замість цієї заглушки допишу справжній асерт.
  it.todo('8. POST / → поведінка за твоїм рішенням (404 / 405 / ігнорувати метод)');
});
