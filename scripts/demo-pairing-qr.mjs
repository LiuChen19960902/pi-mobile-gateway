// 演示：生成一条一次性配对码并在终端渲染成二维码。
// 用法：node scripts/demo-pairing-qr.mjs [设备名]
// 扫码用 app 内的「扫描二维码」；或把打印出的 pairingText 手动粘贴。
const name = process.argv[2] ?? "qr-test";
const res = await fetch("http://127.0.0.1:3083/mgw/pair", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ name }),
});
if (!res.ok) {
	console.error("管理面生成配对码失败：", await res.text());
	process.exit(1);
}
const { pairingText, payload } = await res.json();
const qrcodeTerminal = (await import("qrcode-terminal")).default ?? (await import("qrcode-terminal"));
qrcodeTerminal.generate(pairingText, { small: true });
console.log("pairingText（手动粘贴用）：");
console.log(pairingText);
console.log("expiresAt:", new Date(payload.expiresAt).toLocaleString());
