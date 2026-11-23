const ALLOW = ["apibay.org", "yts.mx", "eztvx.to", "v3-cinemeta.strem.io"];
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const target = req.query.url;
  if (!target) { res.status(200).json({ ok: true, service: "torrflix-streams" }); return; }
  let t;
  try { t = new URL(target); } catch (e) { res.status(400).json({ error: "bad url" }); return; }
  if (t.protocol !== "https:" || ALLOW.indexOf(t.hostname) === -1) { res.status(403).json({ error: "not allowed" }); return; }
  try {
    const r = await fetch(t.toString(), { headers: { "User-Agent": "TorrFlixStreams/1.0" } });
    const body = await r.text();
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    res.status(r.status).send(body);
  } catch (e) { res.status(502).json({ error: "fetch failed" }); }
}
