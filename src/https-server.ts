import tls from "node:tls";
import handler from "./handler.ts";
import {readFileSync} from "node:fs";

const PORT = Number(process.env.PORT) || 3443;
const CERT = new URL('../certs/localhost-cert.pem', import.meta.url);
const KEY  = new URL('../certs/localhost-key.pem',  import.meta.url);

const read = (path: URL): Buffer => {
    try {
        return readFileSync(path);
    } catch {
        console.error(`Немає ${path.pathname} — згенеруй: npm run certs`);
        process.exit(2); // тип never, тому TS не свариться на відсутній return
    }
};

const server = tls.createServer({ cert: read(CERT), key: read(KEY) }, handler);

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));