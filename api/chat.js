export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  
  let body;
  try { body = req.body; } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
  
  const model = body.model || 'deepseek-ai/DeepSeek-V4-Pro';
  const key = 'ms-d54f102be92e1dab2aadef6cc4a42926'; // hardcoded test key
  
  try {
    const upstreamResp = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ ...body, model, stream: false }),
    });
    
    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).json({ error: errText.slice(0, 200), status: upstreamResp.status });
      return;
    }
    
    const data = await upstreamResp.json();
    res.status(200).json(data);
    return;
  } catch (e) {
    res.status(502).json({ error: e.message });
    return;
  }
}
