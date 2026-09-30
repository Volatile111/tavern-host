// This network's public address (what players outside it connect to), looked up at most hourly from api.ipify.org.
// Used by share links, the port forwarding help and the "public IP changed" warning.

let cached: { ip: string | null; at: number } = { ip: null, at: 0 };

export async function lookupPublicIp(maxAgeMs = 3600_000): Promise<string | null> {
  if (Date.now() - cached.at < maxAgeMs) return cached.ip;
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    const ip = (await res.text()).trim();
    cached = { ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null, at: Date.now() };
  } catch {
    cached = { ip: cached.ip, at: Date.now() - maxAgeMs + 600_000 }; // keep the last one; try again in 10 minutes
  }
  return cached.ip;
}
