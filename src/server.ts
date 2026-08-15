import net from "node:net";
import handler from "./handler.ts";

const PORT = Number(process.env.PORT) || 3000;

const server = net.createServer(handler);

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));