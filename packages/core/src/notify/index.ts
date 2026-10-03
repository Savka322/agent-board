import { spawnSync } from "node:child_process";
import { getSetting, recordNotification, type BoardStore } from "../store";

export const DEFAULT_NOTIFY_APP_ID = "AgentBoard.Local";
export const POWERSHELL_NOTIFY_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
export const APP_USER_MODEL_ID_KEY = "HKCU\\Software\\Classes\\AppUserModelId";

export interface ToastInput {
  appId: string;
  title: string;
  text: string;
  launch: string;
}

export interface ToastResult {
  delivered: boolean;
  error?: string;
}

export interface NotificationSendResult extends ToastResult {
  appId: string;
}

export interface Notifier {
  notify(input: ToastInput): Promise<ToastResult>;
}

export interface RegistryWriter {
  write(appId: string, displayName: string): void;
  remove(appId: string): void;
  exists(appId: string): boolean;
}

function xmlEscape(value: string): string {
  const valid = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : "\uFFFD";
  }).join("");
  return valid.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export class WindowsToastNotifier implements Notifier {
  constructor(private readonly run: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> = (args) => {
    const result = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    return Promise.resolve({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) });
  }) {}

  async notify(input: ToastInput): Promise<ToastResult> {
    const tag = crypto.randomUUID().replaceAll("-", "");
    const xml = `<toast activationType="protocol" launch="${xmlEscape(input.launch)}"><visual><binding template="ToastGeneric"><text>${xmlEscape(input.title)}</text><text>${xmlEscape(input.text)}</text></binding></visual></toast>`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      `$appId = ${psLiteral(input.appId)}`,
      `$xmlText = ${psLiteral(xml)}`,
      `$tag = ${psLiteral(tag)}`,
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      "$xml.LoadXml($xmlText)",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "$toast.Tag = $tag",
      "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)",
      "$notifier.Show($toast)",
      "$delivered = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId) | Where-Object { $_.Tag -eq $tag } | Select-Object -First 1",
      "if ($null -eq $delivered) { Write-Output 'NOT_DELIVERED'; exit 3 }",
      "Write-Output 'DELIVERED'",
    ].join("\n");
    try {
      const result = await this.run(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShell(script)]);
      if (result.error) return { delivered: false, error: result.error.message };
      if (result.status !== 0) return { delivered: false, error: result.stderr.trim() || `powershell.exe exited with code ${result.status}` };
      if (!result.stdout.includes("DELIVERED")) return { delivered: false, error: "Toast was not found in notification history after showing it" };
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export class WindowsRegistryWriter implements RegistryWriter {
  private key(appId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appId)) throw new TypeError("Invalid notification app id");
    return `${APP_USER_MODEL_ID_KEY}\\${appId}`;
  }

  write(appId: string, displayName: string): void {
    this.run(["add", this.key(appId), "/v", "DisplayName", "/t", "REG_SZ", "/d", displayName, "/f"]);
  }

  remove(appId: string): void {
    const result = spawnSync("reg.exe", ["delete", this.key(appId), "/f"], { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0 && !`${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase().includes("unable to find")) {
      throw new Error((result.stderr || result.stdout || `reg.exe exited with code ${result.status}`).trim());
    }
  }

  exists(appId: string): boolean {
    const result = spawnSync("reg.exe", ["query", this.key(appId)], { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    return result.status === 0;
  }

  private run(args: string[]): void {
    const result = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `reg.exe exited with code ${result.status}`).trim());
  }
}

export function installNotificationApp(appId: string, writer: RegistryWriter = new WindowsRegistryWriter()): void {
  writer.write(appId, "agent-board");
}

export function uninstallNotificationApp(appId: string, writer: RegistryWriter = new WindowsRegistryWriter()): void {
  writer.remove(appId);
}

export interface NotifyCauseOptions {
  notifier?: Notifier;
  registry?: RegistryWriter;
}

export async function notifyCause(
  store: BoardStore,
  input: { kind: string; ref: string; title: string; text: string; launch: string },
  options: NotifyCauseOptions = {},
  force = false,
): Promise<NotificationSendResult | null> {
  if (!force && !getSetting(store, "notify_enabled")) return null;
  const appId = getSetting(store, "notify_app_id") || DEFAULT_NOTIFY_APP_ID;
  const registry = options.registry ?? new WindowsRegistryWriter();
  let installed = false;
  try { installed = registry.exists(appId); } catch { installed = false; }
  const effectiveAppId = installed ? appId : POWERSHELL_NOTIFY_APP_ID;
  const notifier = options.notifier ?? new WindowsToastNotifier();
  let result: ToastResult;
  try {
    result = await notifier.notify({ ...input, appId: effectiveAppId });
  } catch (error) {
    result = { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
  recordNotification(store, {
    kind: input.kind,
    ref: input.ref,
    app_id: effectiveAppId,
    delivered: result.delivered,
    error: result.error ?? null,
  });
  return { ...result, appId: effectiveAppId };
}
