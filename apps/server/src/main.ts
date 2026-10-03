import { startServer } from "./index";

const running = startServer();
process.stdout.write(`Agent Board web server listening at http://127.0.0.1:${running.port}\n`);

let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  running.close();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
