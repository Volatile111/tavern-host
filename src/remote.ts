// Remote access: an extra HTTPS listener on all network interfaces, switched on and off from the panel.
// The local listener (127.0.0.1, used by this system and the desktop app) is always on. Remote access is HTTPS-only so
// passwords and API keys are never sent unencrypted over the network.
import https from 'node:https';
import type http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { dataPath } from './store.ts';

const execFileAsync = promisify(execFile);
const CERT_FILE = 'remote-cert.pfx';
const CERT_PASS_FILE = 'remote-cert.pass';

export interface RemoteConfig {
  enabled: boolean;
  port: number;
}

let server: https.Server | null = null;
let lastError: string | null = null;

/** Creates a self-signed certificate (valid 5 years) with Windows' own tools, exported to the data folder. */
async function ensureCertificate(): Promise<{ pfx: Buffer; passphrase: string }> {
  const pfxPath = dataPath(CERT_FILE);
  const passPath = dataPath(CERT_PASS_FILE);
  if (existsSync(pfxPath) && existsSync(passPath)) return { pfx: readFileSync(pfxPath), passphrase: readFileSync(passPath, 'utf-8') };

  const passphrase = randomBytes(24).toString('hex');
  const names = [...new Set([os.hostname(), 'localhost', ...localAddresses()])];
  // Values go through environment variables, so nothing is ever parsed as PowerShell code.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$names = $env:PANEL_CERT_NAMES -split ","',
    '$cert = New-SelfSignedCertificate -DnsName $names -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(5) -KeyExportPolicy Exportable -FriendlyName "Tavern Host remote access"',
    '$pw = ConvertTo-SecureString -String $env:PANEL_CERT_PASS -Force -AsPlainText',
    'Export-PfxCertificate -Cert $cert -FilePath $env:PANEL_CERT_PATH -Password $pw | Out-Null',
    'Remove-Item -Path ("Cert:\\CurrentUser\\My\\" + $cert.Thumbprint)',
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PANEL_CERT_NAMES: names.join(','), PANEL_CERT_PASS: passphrase, PANEL_CERT_PATH: pfxPath },
    windowsHide: true,
    timeout: 60_000,
  });
  writeFileSync(passPath, passphrase);
  return { pfx: readFileSync(pfxPath), passphrase };
}

function localAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export async function applyRemote(config: RemoteConfig, handler: http.RequestListener): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server.closeAllConnections();
    server = null;
  }
  lastError = null;
  if (!config.enabled) return;
  try {
    const { pfx, passphrase } = await ensureCertificate();
    const s = https.createServer({ pfx, passphrase }, handler);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(config.port, '0.0.0.0', () => resolve());
    });
    server = s;
  } catch (err) {
    lastError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : (err as Error).message;
    throw new Error(lastError);
  }
}

export function remoteStatus(config: RemoteConfig) {
  let certificate = null;
  if (existsSync(dataPath(CERT_FILE))) {
    certificate = { selfSigned: true, file: dataPath(CERT_FILE) };
  }
  return {
    ...config,
    listening: !!server,
    error: lastError,
    addresses: localAddresses().map((ip) => `https://${ip}:${config.port}`),
    hostname: `https://${os.hostname()}:${config.port}`,
    certificate,
  };
}

/**
 * SHA-256 fingerprint of the remote-access certificate ("AB:CD:..."), or null before remote access was first turned on.
 * Share links carry it so other apps (Tavern Client Mod Manager) can trust this self-signed certificate and nothing else.
 */
export async function certFingerprint(): Promise<string | null> {
  const fpPath = dataPath('remote-cert.fp');
  if (existsSync(fpPath)) return readFileSync(fpPath, 'utf-8').trim();
  if (!existsSync(dataPath(CERT_FILE)) || !existsSync(dataPath(CERT_PASS_FILE))) return null;
  const script =
    '$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:PANEL_CERT_PATH, $env:PANEL_CERT_PASS); ' +
    '[BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace("-", ":")';
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PANEL_CERT_PATH: dataPath(CERT_FILE), PANEL_CERT_PASS: readFileSync(dataPath(CERT_PASS_FILE), 'utf-8') },
    windowsHide: true,
    timeout: 30_000,
  });
  const fp = stdout.trim();
  if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp)) return null;
  writeFileSync(fpPath, fp);
  return fp;
}

/** Adds a Windows Firewall rule for the remote port. Needs admin, so Windows shows its admin prompt on this system. */
export async function addFirewallRule(port: number): Promise<void> {
  const rule = `name="Tavern Host (remote access)" dir=in action=allow protocol=TCP localport=${port}`;
  const script = `Start-Process -FilePath netsh.exe -ArgumentList 'advfirewall firewall add rule ${rule}' -Verb RunAs -Wait -WindowStyle Hidden`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120_000 });
}
