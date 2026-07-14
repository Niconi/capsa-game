import { GameRoom } from "./room";

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

// Room codes avoid ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const code = randomCode();
      const stub = env.GAME_ROOM.getByName(code);
      await stub.create();
      return Response.json({ code });
    }

    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const stub = env.GAME_ROOM.getByName(code);
      if (request.headers.get("Upgrade") === "websocket") {
        return stub.fetch(request);
      }
      // Non-upgrade probe: lets the client validate a code before connecting.
      return Response.json({ exists: await stub.exists() });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
