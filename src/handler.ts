import { pipeline, Transform } from 'node:stream';

import { reasonOf } from './status.ts';

const CRLF = '\r\n';
const DELIMITER = Buffer.from(CRLF + CRLF);
const MAX_HEAD_BYTES = 8 * 1024;
const MAX_REQUEST_LINE = 8 * 1024;

interface ParsedRequest {
    readonly path: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
}

interface HttpResult {
    readonly status: number;
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
}

type Frame =
    | { readonly kind: 'head'; readonly text: string }
    | { readonly kind: 'request'; readonly request: ParsedRequest }
    | { readonly kind: 'result'; readonly result: HttpResult }
    | { readonly kind: 'error'; readonly status: number };

const ok = (body: string): HttpResult => ({ status: 200, body });
const failure = (status: number): Frame => ({ kind: 'error', status });
const errorResult = (status: number): HttpResult => ({ status, body: `${reasonOf(status)}\n` });

const createHeadFramer = (): Transform => {
    let head = Buffer.alloc(0);
    let framed = false;

    return new Transform({
        readableObjectMode: true,

        transform(chunk: Buffer, _encoding, next): void {
            if (framed) return next();

            const from = Math.max(0, head.length - (DELIMITER.length - 1));
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf(DELIMITER, from);

            if (end === -1) {
                if (head.length <= MAX_HEAD_BYTES) return next();
                framed = true;
                return next(null, failure(431));
            }

            framed = true;
            next(null, { kind: 'head', text: head.subarray(0, end).toString('latin1') });
        },
    });
};

const parseHead = (head: string): ParsedRequest | null => {
    const [requestLine = '', ...headerLines] = head.split(CRLF);
    const [method, target] = requestLine.split(' ');

    if (method === undefined || target === undefined || !target.startsWith('/')) return null;

    if (headerLines.some((line) => !line.includes(':'))) return null;

    const headers = headerLines.reduce((acc, line) => {
        const separator = line.indexOf(':');
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const existing = acc.get(name);
        return acc.set(name, existing === undefined ? value : `${existing}, ${value}`);
    }, new Map<string, string>());

    return { method, path: target.split('?')[0]!, headers: Object.fromEntries(headers) };
};

const createHeadParser = (): Transform =>
    new Transform({
        objectMode: true,

        transform(frame: Frame, _encoding, next): void {
            if (frame.kind !== 'head') return next(null, frame);

            const requestLine = frame.text.slice(0, frame.text.indexOf(CRLF));
            if (requestLine.length > MAX_REQUEST_LINE) return next(null, failure(414));

            const request = parseHead(frame.text);
            next(null, request === null ? failure(400) : { kind: 'request', request });
        },
    });

const formatHeaders = (headers: Readonly<Record<string, string>>): string =>
    Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');

type Handler = (request: ParsedRequest) => HttpResult;

const routes: Readonly<Record<string, Readonly<Record<string, Handler>>>> = {
    '/': {
        GET: () => ok('Hello from raw TCP\n'),
    },
    '/headers': {
        GET: ({ headers }) => ok(`${formatHeaders(headers)}\n`),
    },
};

const route = (request: ParsedRequest): HttpResult => {
    const { method, path } = request;

    if (!Object.hasOwn(routes, path)) {
        return { status: 404, body: `Not Found: ${path}\n` };
    }

    const handlers = routes[path]!;

    if (!Object.hasOwn(handlers, method)) {
        return {
            status: 405,
            body: `Method Not Allowed: ${method}\n`,
            headers: { Allow: Object.keys(handlers).join(', ') },
        };
    }

    return handlers[method]!(request);
};

const createRouter = (): Transform =>
    new Transform({
        objectMode: true,

        transform(frame: Frame, _encoding, next): void {
            if (frame.kind !== 'request') return next(null, frame);

            try {
                next(null, { kind: 'result', result: route(frame.request) });
            } catch (error) {
                process.emitWarning(error instanceof Error ? error : new Error(String(error)));
                next(null, failure(500));
            }
        },
    });

const serialize = ({ status, body, headers = {} }: HttpResult): string =>
    [
        `HTTP/1.1 ${status} ${reasonOf(status)}`,
        'Content-Type: text/plain; charset=utf-8',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
        'Connection: close',
        '',
        body,
    ].join(CRLF);

const createSerializer = (): Transform =>
    new Transform({
        writableObjectMode: true,

        transform(frame: Frame, _encoding, next): void {
            const result: HttpResult =
                frame.kind === 'result'
                    ? frame.result
                    : errorResult(frame.kind === 'error' ? frame.status : 500);

            this.push(serialize(result));
            this.push(null);
            next();
        },
    });

export default function (socket: any) {
    socket.setTimeout(5_000, () => socket.end());

    pipeline(
        socket,
        createHeadFramer(),
        createHeadParser(),
        createRouter(),
        createSerializer(),
        socket,
        () => socket.end(),
    );
}