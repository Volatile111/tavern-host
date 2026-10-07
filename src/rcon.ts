// A minimal Source RCON client (the protocol V Rising, Palworld, Minecraft and others use for remote console commands):
// connect, log in with the password, send one command, return the answer. Only used towards this system (127.0.0.1).
import net from 'node:net';

const AUTH = 3;
const EXEC = 2;

function packet(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf-8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf; // the two trailing NULs are already zero
}

/** Sends one command over RCON and resolves with the server's answer (empty string if none). */
export function rconCommand(port: number, password: string, command: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let answer = '';
    const done = (err: Error | null) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(answer.trim());
    };
    const timer = setTimeout(() => (authed ? done(null) : done(new Error("The server's RCON didn't answer."))), timeoutMs);
    socket.on('connect', () => socket.write(packet(1, AUTH, password)));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf-8', 12, 4 + size - 2);
        buffer = buffer.subarray(size + 4);
        if (!authed) {
          if (type !== 2) continue; // some servers send an empty response before the auth answer
          if (id === -1) return done(new Error('RCON password was refused.'));
          authed = true;
          socket.write(packet(2, EXEC, command));
          // Many servers never send an "end" marker: give the answer a moment to arrive, then finish.
          setTimeout(() => done(null), 600);
        } else if (id === 2) answer += body;
      }
    });
    socket.on('error', (err) => done(new Error(`Couldn't reach the server's RCON: ${err.message}`)));
  });
}
