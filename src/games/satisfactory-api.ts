// Satisfactory's dedicated server HTTPS API (https://<host>:<port>/api/v1, self-signed certificate). Tavern Host starts
// the server with FG.DedicatedServer.AllowInsecureLocalAccess=1, so calls from this system (127.0.0.1) need no token:
// that's how it stops the server cleanly, reads its state and runs console commands without keeping the admin password.
import https from 'node:https';

export interface ServerState {
  activeSessionName: string;
  numConnectedPlayers: number;
  playerLimit: number;
  techTier: number;
  activeSchematic: string;
  gamePhase: string;
  isGameRunning: boolean;
  totalGameDuration: number;
  isGamePaused: boolean;
  averageTickRate: number;
  autoLoadSessionName: string;
}

/** One API call. Resolves to the response's "data" (or {} for calls that return nothing). */
export function sfApi<T = Record<string, unknown>>(port: number, fn: string, data?: Record<string, unknown>, timeoutMs = 10_000, token?: string): Promise<T> {
  const body = JSON.stringify({ function: fn, ...(data ? { data } : {}) });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1',
        method: 'POST',
        rejectUnauthorized: false, // the server's own self-signed certificate
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode === 204 || !text) return resolve({} as T);
          let json: { data?: T; errorCode?: string; errorMessage?: string };
          try {
            json = JSON.parse(text);
          } catch {
            return reject(new Error(`The server answered ${res.statusCode} with something that isn't JSON.`));
          }
          if ((res.statusCode ?? 500) >= 400 || json.errorCode) return reject(new Error(json.errorMessage || json.errorCode || `The server answered ${res.statusCode}.`));
          resolve((json.data ?? {}) as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function serverState(port: number): Promise<ServerState> {
  return (await sfApi<{ serverGameState: ServerState }>(port, 'QueryServerState')).serverGameState;
}

/** The first admin setup ("claiming"): only possible while the server is unclaimed. */
export async function claimServer(port: number, serverName: string, adminPassword: string) {
  const login = await sfApi<{ authenticationToken: string }>(port, 'PasswordlessLogin', { MinimumPrivilegeLevel: 'InitialAdmin' });
  return sfApi(port, 'ClaimServer', { ServerName: serverName, AdminPassword: adminPassword }, 10_000, login.authenticationToken);
}
