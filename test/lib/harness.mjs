// Спільна інфраструктура для http.test.mjs і tls.test.mjs.
//
// Тести чорноскриньові: піднімають сервер окремим процесом на вільному порту,
// шлють сирі байти в сокет і читають сирі байти відповіді. Про твою реалізацію
// вони не знають нічого — ні імен функцій, ні експортів.
//
// Єдина різниця між HTTP- і HTTPS-набором — транспорт: net.connect vs tls.connect.
// Усе інше (кадрування, парсинг відповіді, асерти) спільне. Це і є машинна
// перевірка тези «HTTPS = той самий HTTP по зашифрованому TCP».
import net from 'node:net';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const CERT = path.join(ROOT, 'certs', 'localhost-cert.pem');
export const KEY = path.join(ROOT, 'certs', 'localhost-key.pem');

const BOOT_TIMEOUT_MS = 10_000;
// Сервер, який мовчить, має падати швидко, а не висіти. На локалхості відповідь
// приходить за 1–5 мс, тож 1.5 с — це ~300× запасу. Але тест на розрізаний запит
// сам робить паузу 300 мс між двома write, тому нижче опускати не можна.
const RESPONSE_TIMEOUT_MS = 1_500;

// ─────────────────────────────────────────────────────────────────────────────
// Запуск сервера
// ─────────────────────────────────────────────────────────────────────────────

/** Просимо ядро видати вільний порт: слухаємо :0, читаємо призначений, закриваємо. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Одна спроба TCP-конекту — true, якщо порт уже приймає з'єднання. */
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Піднімає сервер дочірнім процесом і чекає, поки порт почне приймати з'єднання.
 * Якщо процес помер на старті — кидає з його stderr, а не мовчки чекає таймаут.
 *
 * @param entry шлях до файлу сервера відносно кореня репозиторію
 * @param args  додаткові argv (потрібні лише для прогону проти лекційного еталона,
 *              який бере cert/key/порт із командного рядка, а не з env)
 */
export async function bootServer(entry, { args = [], env = {} } = {}) {
  // Окрема перевірка, щоб замість 20 рядків MODULE_NOT_FOUND від node побачити
  // одне зрозуміле речення: найчастіша причина — просто ще не зроблений build.
  if (!existsSync(path.resolve(ROOT, entry))) {
    throw new Error(
      `Немає файлу ${entry}.\n` +
        `Якщо ти вже написав .ts — зроби збірку: npm run build (або одразу npm test).\n` +
        `Якщо ще ні — це та частина ДЗ, яку треба написати.`,
    );
  }

  const port = await freePort();
  const argv = args.map((a) => a.replace('{PORT}', String(port)));
  const child = spawn(process.execPath, [entry, ...argv], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let exited = null;
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.resume(); // не даємо буферу stdout заповнитись і підвісити процес
  child.on('exit', (code, signal) => (exited = { code, signal }));

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `${entry} упав на старті (код ${exited.code}, сигнал ${exited.signal}).\n` +
          `stderr:\n${stderr.trim() || '(порожній)'}`,
      );
    }
    if (await canConnect(port)) return { port, child };
    await new Promise((r) => setTimeout(r, 150));
  }

  child.kill('SIGKILL');
  throw new Error(
    `${entry} не почав слухати :${port} за ${BOOT_TIMEOUT_MS} мс.\n` +
      `Порт беремо з process.env.PORT — переконайся, що сервер його читає.\n` +
      `stderr:\n${stderr.trim() || '(порожній)'}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Клієнт
// ─────────────────────────────────────────────────────────────────────────────

/** Складає валідний HTTP/1.1-запит із CRLF-роздільниками. */
export function buildRequest(method, target, headers = {}) {
  const lines = [`${method} ${target} HTTP/1.1`, 'Host: localhost'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

/**
 * Розбір ВІДПОВІДІ. Навмисне неінкрементальний: викликається один раз на вже
 * повністю зібраному тексті. Кадрування «по шматках» тут не показане — це
 * рівно та частина, яку ти пишеш сам.
 */
export function parseResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  assert.notEqual(
    sep,
    -1,
    `У відповіді немає порожнього рядка (CRLFCRLF) між заголовками й тілом.\n` +
      `Отримано: ${JSON.stringify(raw.slice(0, 200))}`,
  );

  const head = raw.slice(0, sep);
  const body = raw.slice(sep + 4);
  const [statusLine, ...headerLines] = head.split('\r\n');

  const headers = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  const m = /^(HTTP\/\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine);
  return {
    raw,
    statusLine,
    httpVersion: m?.[1],
    status: m ? Number(m[2]) : undefined,
    reason: m?.[3] ?? '',
    headers,
    body, // latin1 — тобто рівно байти, як вони прийшли з дроту
    text: Buffer.from(body, 'latin1').toString('utf8'), // читабельний варіант
    bodyBytes: Buffer.byteLength(body, 'latin1'),
  };
}

/**
 * Чи зібралась повна HTTP-відповідь? Потрібно, щоб не залежати від того, закриє
 * сервер з'єднання чи лишить його keep-alive: у другому випадку події 'end' не
 * буде взагалі, і чекати на неї — це гарантований таймаут.
 */
function isComplete(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep === -1) return false;

  const length = /\r\ncontent-length:\s*(\d+)/i.exec(raw.slice(0, sep));
  if (!length) return false; // без Content-Length межу тіла знає лише FIN

  return Buffer.byteLength(raw.slice(sep + 4), 'latin1') >= Number(length[1]);
}

/**
 * Шле сирий запит і збирає відповідь.
 *
 * @param transport 'tcp' | 'tls' — єдина відмінність між двома наборами тестів
 * @param splitAt   розрізати запит на два записи з паузою (перевірка кадрування)
 */
export function sendRaw(port, requestText, { splitAt = null, pauseMs = 300, transport = 'tcp' } = {}) {
  const payload = Buffer.from(requestText, 'utf8');

  return new Promise((resolve, reject) => {
    const socket =
      transport === 'tls'
        ? tls.connect({
            port,
            host: '127.0.0.1',
            servername: 'localhost', // SNI — без нього серт із SAN=localhost не звіриться
            rejectUnauthorized: false, // серт самопідписаний, це очікувано
          })
        : net.connect({ port, host: '127.0.0.1' });

    let raw = '';
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Сервер не віддав повну відповідь за ${RESPONSE_TIMEOUT_MS} мс. ` +
            `Отримано ${raw.length} байт: ${JSON.stringify(raw.slice(0, 200))}\n` +
            `Ймовірні причини: не відповів зовсім; відповів без Content-Length і не закрив ` +
            `з'єднання; або тіло коротше за оголошений Content-Length.`,
        ),
      );
    }, RESPONSE_TIMEOUT_MS);

    socket.setEncoding('latin1'); // байт у символ — жодних втрат на кирилиці
    socket.on('data', (chunk) => {
      raw += chunk;
      if (isComplete(raw)) finish(resolve, raw);
    });
    socket.on('error', (err) => finish(reject, err));
    socket.on('end', () => finish(resolve, raw));

    // Пишемо й ЧЕКАЄМО: закривати з'єднання має сервер. Якби клієнт сам робив
    // socket.end(), він надіслав би FIN, а сервер за замовчуванням має
    // allowHalfOpen: false — Node закрив би й свій бік запису, і коректна
    // відповідь могла б не долетіти. Тоді тест падав би через клієнта.
    const onReady = () => {
      if (splitAt === null) {
        socket.write(payload);
        return;
      }
      socket.write(payload.subarray(0, splitAt));
      setTimeout(() => socket.write(payload.subarray(splitAt)), pauseMs);
    };

    socket.on(transport === 'tls' ? 'secureConnect' : 'connect', onReady);
  });
}
