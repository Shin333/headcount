import "dotenv/config";
async function main() {
  const key = process.env.GENVIRAL_API_KEY;
  if (!key) { console.log("NO KEY"); process.exit(1); }
  console.log("Key prefix:", key.slice(0, 25) + "...");
  const r = await fetch("https://www.genviral.io/api/partner/v1/accounts", {
    headers: { Authorization: "Bearer " + key },
  });
  console.log("Status:", r.status);
  const body = await r.text();
  console.log("Body:", body.slice(0, 1500));
}
main().catch((e) => { console.error(e); process.exit(1); });
