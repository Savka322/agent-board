import { report, runCaptured } from "./common.ts";

async function main(): Promise<void> {
  const powerShellScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xmlText = '<toast activationType="protocol" launch="http://127.0.0.1:8790/#q=probe"><visual><binding template="ToastGeneric"><text>agent-board probe</text></binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell')
$notifier.Show($toast)
`;
  const encoded = Buffer.from(powerShellScript, "utf16le").toString("base64");
  const result = await runCaptured([
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], 20000);
  report("toast", result.code === 0 && !result.timedOut && result.stderr.trim().length === 0, {
    powershellExitCode: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    manual_check: "Confirm that the 'agent-board probe' Windows notification appears and clicking it opens the protocol URL.",
  });
}

main().catch((error: unknown) => {
  report("toast", false, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 0;
});
